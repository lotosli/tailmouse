import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildIdentity } from './build-identity.ts';
import { run } from './process.mjs';

const root = resolve(import.meta.dirname, '..');
const targets = [
  'darwin/amd64',
  'darwin/arm64',
  'linux/amd64',
  'linux/arm64',
  'windows/amd64',
  'windows/arm64',
];

export function verifyNativeBuild(
  info,
  bytes,
  identity,
  target,
  revision,
  goVersion,
) {
  assert.ok(targets.includes(target), 'Unexpected native target.');
  assert.equal(info.GoVersion, `go${goVersion}`, 'Unexpected Go toolchain.');
  assert.equal(
    info.Path,
    'tailmouse/apps/cli/cmd/tailmouse',
    'Unexpected executable.',
  );
  assert.equal(info.Main?.Path, 'tailmouse', 'Unexpected main module.');
  const settings = new Map(
    info.Settings?.map(({ Key, Value }) => [Key, Value]),
  );
  assert.equal(
    `${settings.get('GOOS')}/${settings.get('GOARCH')}`,
    target,
    'Wrong native target.',
  );
  assert.equal(
    settings.get('CGO_ENABLED'),
    '0',
    'Native archive requires a self-contained Go build.',
  );
  assert.equal(
    settings.get('-trimpath'),
    'true',
    'Native build paths must be trimmed.',
  );
  assert.equal(
    settings.get('vcs.revision'),
    revision,
    'Wrong source revision.',
  );
  assert.equal(
    info.Deps?.find(({ Path }) => Path === 'github.com/tailscale/tailcat')
      ?.Replace?.Path,
    './third_party/tailcat',
    'Native build must use the recorded local Tailcat submodule.',
  );
  // Go omits linker flags from trimmed build metadata. Inspect the stamped
  // strings as well; only a native execution proves the version command.
  assert.ok(
    bytes.includes(Buffer.from(identity.version)),
    'Missing build version stamp.',
  );
  assert.ok(
    bytes.includes(Buffer.from(identity.tailcatRevision)),
    'Missing Tailcat revision stamp.',
  );
}

export function verifyNativeMatrix(artifacts, version) {
  for (const type of ['Binary', 'Archive']) {
    const selected = artifacts.filter((artifact) => artifact.type === type);
    assert.deepEqual(
      selected.map(({ goos, goarch }) => `${goos}/${goarch}`).sort(),
      targets,
      `Expected exactly one ${type} for every native platform.`,
    );
    for (const artifact of selected) {
      const binary =
        artifact.goos === 'windows' ? 'tailmouse.exe' : 'tailmouse';
      if (type === 'Binary') {
        assert.equal(artifact.name, binary, 'Unexpected binary name.');
      } else {
        const extension = artifact.goos === 'windows' ? 'zip' : 'tar.gz';
        assert.equal(
          artifact.name,
          `tailmouse_${version}_${artifact.goos}_${artifact.goarch}.${extension}`,
          'Unexpected archive name.',
        );
        assert.deepEqual(
          artifact.extra?.Binaries,
          [binary],
          'Archive must contain one executable.',
        );
      }
    }
  }
}

function checkedIdentity(version, snapshot) {
  assert.ok(
    snapshot === 'true' || snapshot === 'false',
    'Missing snapshot classification.',
  );
  const identity = buildIdentity(
    root,
    snapshot === 'true' ? undefined : version,
  );
  assert.equal(
    version,
    identity.version,
    'Release version disagrees with source identity.',
  );
  assert.equal(
    process.env.TAILMOUSE_TAILCAT_REVISION,
    identity.tailcatRevision,
    'Release Tailcat revision disagrees with the gitlink.',
  );
  return identity;
}

function main(args) {
  const versions = JSON.parse(
    readFileSync(resolve(root, 'tooling/versions.json'), 'utf8'),
  );
  if (args[0] === 'check' && args.length === 3) {
    checkedIdentity(args[1], args[2]);
    process.stdout.write('Release source identity verified.\n');
    return;
  }
  if (args[0] === 'verify' && args.length === 6) {
    const [, path, goos, goarch, version, snapshot] = args;
    const identity = checkedIdentity(version, snapshot);
    const info = JSON.parse(
      run('go', ['version', '-m', '-json', path], { cwd: root, capture: true })
        .stdout,
    );
    const revision = run('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      capture: true,
    }).stdout.trim();
    verifyNativeBuild(
      info,
      readFileSync(path),
      identity,
      `${goos}/${goarch}`,
      revision,
      versions.go,
    );
    const hostOS = process.platform === 'win32' ? 'windows' : process.platform;
    const hostArch = process.arch === 'x64' ? 'amd64' : process.arch;
    if (goos === hostOS && goarch === hostArch) {
      const output = execFileSync(path, ['version'], {
        encoding: 'utf8',
        timeout: 10000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      assert.equal(
        output,
        `TailMouse ${identity.version}\nTMOUSE Escape protocol 1\nTMOUSE Leash protocol 2\nTailcat revision ${identity.tailcatRevision}\n`,
        'Native version output disagrees with release identity.',
      );
      process.stdout.write(
        `Native version command verified: ${goos}/${goarch}.\n`,
      );
    } else {
      process.stdout.write(
        `Build metadata and stamps verified: ${goos}/${goarch}; native execution remains required.\n`,
      );
    }
    return;
  }
  assert.equal(
    args.length,
    0,
    'Use pnpm release:snapshot for local native archives.',
  );
  assert.equal(
    process.versions.node,
    versions.node,
    'Unexpected Node toolchain.',
  );
  const installed = run('goreleaser', ['--version'], {
    cwd: root,
    capture: true,
  }).stdout;
  assert.equal(
    /GitVersion:\s+(\S+)/u.exec(installed)?.[1],
    versions.goreleaser,
    'GoReleaser must match tooling/versions.json.',
  );
  assert.equal(
    run('go', ['env', 'GOVERSION'], { cwd: root, capture: true }).stdout.trim(),
    `go${versions.go}`,
    'Unexpected Go toolchain.',
  );
  const identity = buildIdentity(root);
  const env = {
    GOWORK: 'off',
    TAILMOUSE_BUILD_VERSION: identity.version,
    TAILMOUSE_TAILCAT_REVISION: identity.tailcatRevision,
  };
  run('goreleaser', ['check', '--config', '.goreleaser.yaml'], {
    cwd: root,
    env,
  });
  // Never clean an existing output directory or publish from this local command.
  run(
    'goreleaser',
    [
      'release',
      '--config',
      '.goreleaser.yaml',
      '--snapshot',
      '--parallelism=1',
      '--fail-fast',
      '--timeout=15m',
    ],
    { cwd: root, env },
  );
  verifyNativeMatrix(
    JSON.parse(
      readFileSync(resolve(root, '.artifacts/release/artifacts.json'), 'utf8'),
    ),
    identity.version,
  );
  process.stdout.write(
    'Six native snapshot archives verified; publication, SBOM/notices and cross-platform runtime acceptance remain separate checks.\n',
  );
}

if (import.meta.main) main(process.argv.slice(2));
