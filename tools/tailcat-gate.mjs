import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { run } from './process.mjs';
import { cloneTailcatBuildSource } from './tailcat-source.mjs';

const mode = process.argv[2] ?? 'full';
const root = resolve(import.meta.dirname, '..');
const tailcat = join(root, 'third_party', 'tailcat');
const versions = JSON.parse(
  readFileSync(join(root, 'tooling/versions.json'), 'utf8'),
);
if (typeof versions.go !== 'string' || !/^\d+\.\d+\.\d+$/.test(versions.go))
  throw new Error('Tailcat build requires the pinned Go toolchain version.');
// A submodule's go directive is a minimum, not the root toolchain pin.
// Propagate the exact toolchain to upstream's nested Wasm build as well.
const goEnv = { GOWORK: 'off', GOTOOLCHAIN: `go${versions.go}` };
const supportedModes = new Set(['check', 'test', 'build', 'full']);

if (!supportedModes.has(mode)) {
  throw new Error(`Unknown Tailcat gate mode: ${mode}`);
}
if (!existsSync(join(tailcat, 'go.mod'))) {
  throw new Error(
    'Tailcat submodule is not initialized; run git submodule update --init -- third_party/tailcat.',
  );
}

function assertClean() {
  const status = run(
    'git',
    ['status', '--porcelain=v1', '--untracked-files=all'],
    { capture: true, cwd: tailcat },
  ).stdout.trim();
  if (status) {
    throw new Error(`Tailcat source must remain clean:\n${status}`);
  }
}

function recordedRevision() {
  const entry = run(
    'git',
    ['ls-files', '--stage', '--', 'third_party/tailcat'],
    { capture: true, cwd: root },
  ).stdout.trim();
  const match = entry.match(/^160000 ([0-9a-f]{40}) 0\tthird_party\/tailcat$/);
  if (!match) {
    throw new Error(
      'Tailcat is not recorded as an exact Git submodule gitlink.',
    );
  }
  return match[1];
}

function assertRecordedCheckout(revision) {
  const checkout = run('git', ['rev-parse', 'HEAD'], {
    capture: true,
    cwd: tailcat,
  }).stdout.trim();
  if (checkout !== revision) {
    throw new Error(
      `Tailcat checkout ${checkout} does not match recorded gitlink ${revision}.`,
    );
  }
}

function fileIdentity(path) {
  const bytes = readFileSync(path);
  return {
    bytes: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

function verifyWasmArtifact(directory, revision) {
  const manifestPath = join(directory, 'manifest.json');
  if (!existsSync(manifestPath)) {
    throw new Error('Tailcat Wasm manifest is missing.');
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (manifest.schemaVersion !== 1 || manifest.tailcatRevision !== revision) {
    throw new Error(
      'Tailcat Wasm manifest revision does not match the gitlink.',
    );
  }
  if (manifest.goVersion !== goEnv.GOTOOLCHAIN)
    throw new Error(
      'Tailcat Wasm artifact does not use the pinned Go toolchain.',
    );
  for (const name of ['tailcat-web.wasm', 'wasm_exec.js']) {
    const path = join(directory, name);
    if (!existsSync(path) || !statSync(path).isFile()) {
      throw new Error(`Tailcat Wasm artifact is missing: ${name}.`);
    }
    const identity = fileIdentity(path);
    if (
      manifest.files?.[name]?.bytes !== identity.bytes ||
      manifest.files?.[name]?.sha256 !== identity.sha256
    ) {
      throw new Error(`Tailcat Wasm artifact identity mismatch: ${name}.`);
    }
  }
}

function buildWasmArtifact(revision) {
  const artifactDirectory = join(root, '.artifacts', 'tailcat');
  const temporaryDirectory = mkdtempSync(
    join(tmpdir(), 'tailmouse-tailcat-wasm-'),
  );
  try {
    const checkout = join(temporaryDirectory, 'source');
    const output = join(temporaryDirectory, 'dist');
    cloneTailcatBuildSource(tailcat, checkout, revision);
    run(
      'go',
      ['run', './cmd/tailcat-webdist', '-o', output, '-web-dir', 'web'],
      { cwd: checkout, env: { ...goEnv, GOFLAGS: '-trimpath' } },
    );
    mkdirSync(artifactDirectory, { recursive: true });
    copyFileSync(
      join(output, 'main.wasm'),
      join(artifactDirectory, 'tailcat-web.wasm'),
    );
    copyFileSync(
      join(output, 'wasm_exec.js'),
      join(artifactDirectory, 'wasm_exec.js'),
    );
    const files = Object.fromEntries(
      ['tailcat-web.wasm', 'wasm_exec.js'].map((name) => [
        name,
        fileIdentity(join(artifactDirectory, name)),
      ]),
    );
    const goVersion = run('go', ['env', 'GOVERSION'], {
      capture: true,
      cwd: tailcat,
      env: goEnv,
    }).stdout.trim();
    writeFileSync(
      join(artifactDirectory, 'manifest.json'),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          tailcatRevision: revision,
          sourcePackage: './web',
          goVersion,
          files,
        },
        null,
        2,
      )}\n`,
    );
    verifyWasmArtifact(artifactDirectory, revision);
  } finally {
    rmSync(temporaryDirectory, { force: true, recursive: true });
  }
}

assertClean();
const revision = recordedRevision();
assertRecordedCheckout(revision);

if (mode === 'check' || mode === 'full') {
  run('go', ['mod', 'verify'], { cwd: tailcat, env: goEnv });
  run('go', ['mod', 'tidy', '-diff'], { cwd: tailcat, env: goEnv });

  const sources = run('git', ['ls-files', '--', '*.go'], {
    capture: true,
    cwd: tailcat,
  })
    .stdout.trim()
    .split(/\r?\n/)
    .filter(Boolean);
  const formatted = run('gofmt', ['-l', ...sources], {
    capture: true,
    cwd: tailcat,
  }).stdout.trim();
  if (formatted) {
    const listed = formatted
      .split(/\r?\n/)
      .map((path) =>
        relative(tailcat, join(tailcat, path)).split(sep).join('/'),
      )
      .join(', ');
    throw new Error(`Upstream Tailcat source is not gofmt-clean: ${listed}`);
  }
  run('go', ['vet', './...'], { cwd: tailcat, env: goEnv });
}

if (mode === 'test' || mode === 'full') {
  run('go', ['test', '-count=1', '-timeout=600s', './...'], {
    cwd: tailcat,
    env: goEnv,
  });
}

if (mode === 'build' || mode === 'full') {
  run('go', ['build', './...'], { cwd: tailcat, env: goEnv });
  buildWasmArtifact(revision);
}

assertClean();
assertRecordedCheckout(revision);
process.stdout.write(
  `[tailcat:${mode}] passed at ${revision.slice(0, 12)} with an unchanged submodule.\n`,
);
