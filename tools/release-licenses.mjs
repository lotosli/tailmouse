import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { resolve } from 'node:path';
import { buildIdentity } from './build-identity.ts';
import { projectNotices, thirdPartyNotices } from './release-licenses.ts';
import { wasmDependencies } from './web-dependencies.ts';

const root = resolve(import.meta.dirname, '..');
const namedNotice =
  /^(?:licen[cs]e|copying|copyright|patents|notice|authors)(?:[._-]|$)/iu;
let stage = 'prerequisites';

function noticeFiles(directory, prefix, budget) {
  assert.ok(prefix.split('/').length <= 24, 'Notice source tree is too deep.');
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    assert.ok(
      ++budget.entries <= 100000,
      'Notice source tree exceeds its bound.',
    );
    if (['.git', 'node_modules'].includes(entry.name)) continue;
    const name = `${prefix}${entry.name}`;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory())
      files.push(...noticeFiles(path, `${name}/`, budget));
    else if (
      namedNotice.test(entry.name) &&
      !/\.(?:go|ts|js|py|rs)$/iu.test(entry.name)
    ) {
      assert.ok(
        entry.isFile() && !entry.isSymbolicLink(),
        'Source notices must be regular files.',
      );
      const size = lstatSync(path).size;
      assert.ok(size <= 2 * 1024 * 1024, 'Source notice exceeds its bound.');
      budget.bytes += size;
      assert.ok(
        ++budget.notices <= 512 && budget.bytes <= 8 * 1024 * 1024,
        'Source notice collection exceeds its bound.',
      );
      files.push({ name, source: readFileSync(path) });
    }
  }
  return files;
}

function main() {
  assert.ok(
    process.argv.length === 3 &&
      ['generate', 'check'].includes(process.argv[2]),
    'Expected generate or check.',
  );
  const versions = JSON.parse(
    readFileSync(resolve(root, 'tooling/versions.json'), 'utf8'),
  );
  assert.equal(
    process.versions.node,
    versions.node,
    'Node toolchain mismatch.',
  );
  projectNotices(root);
  const identity = buildIdentity(root);
  const web = JSON.parse(
    readFileSync(resolve(root, 'apps/web/dist/web-manifest.json'), 'utf8'),
  );
  assert.equal(web.schemaVersion, 1, 'Unsupported Web manifest.');
  assert.equal(
    web.tailcatRevision,
    identity.tailcatRevision,
    'Web notice input has a stale gitlink.',
  );
  assert.deepEqual(
    web.dependencies.wasm,
    wasmDependencies(
      readFileSync(resolve(root, '.artifacts/tailcat/tailcat-web.wasm')),
      identity.tailcatRevision,
    ),
    'Web notice dependencies differ from compiled Wasm.',
  );
  const execute = (args, cwd = root, env = {}) =>
    execFileSync('go', args, {
      cwd,
      env: {
        ...process.env,
        GOWORK: 'off',
        CGO_ENABLED: '0',
        GOTOOLCHAIN: `go${versions.go}`,
        ...env,
      },
      encoding: 'utf8',
      timeout: 60000,
      maxBuffer: 8 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  const [goVersion, goRoot] = execute(['env', 'GOVERSION', 'GOROOT']).split(
    '\n',
  );
  assert.equal(goVersion, `go${versions.go}`, 'Go toolchain mismatch.');
  const libraries = new Map();
  const add = (
    ecosystem,
    name,
    version,
    directory,
    scope = 'distribution',
    revision,
  ) => {
    const key = `${ecosystem}:${name}@${version}`;
    const resolved = realpathSync(directory);
    const previous = libraries.get(key);
    if (previous) {
      assert.equal(
        previous.directory,
        resolved,
        'Ambiguous dependency source.',
      );
      return;
    }
    libraries.set(key, {
      ecosystem,
      name,
      version,
      directory: resolved,
      scope,
      ...(revision ? { revision } : {}),
    });
  };
  add('golang', 'stdlib', goVersion, goRoot);
  const targets = [
    'darwin/amd64',
    'darwin/arm64',
    'linux/amd64',
    'linux/arm64',
    'windows/amd64',
    'windows/arm64',
    'js/wasm',
  ];
  for (const target of targets) {
    stage = `production dependency listing ${target}`;
    const [GOOS, GOARCH] = target.split('/');
    const wasm = GOOS === 'js';
    const sources = execute(
      [
        'list',
        '-mod=readonly',
        '-deps',
        '-f',
        '{{if .Module}}{{.Module.Path}}|{{.Module.Version}}|{{.Module.Dir}}|{{with .Module.Replace}}{{.Path}}{{end}}{{end}}',
        wasm ? './web' : './apps/cli/cmd/tailmouse',
      ],
      wasm ? resolve(root, 'third_party/tailcat') : root,
      { GOOS, GOARCH },
    );
    for (const line of new Set(sources.split('\n').filter(Boolean))) {
      const [name, version, directory, replacement] = line.split('|');
      if (name === 'tailmouse') continue;
      if (name === web.dependencies.wasm.main.name) {
        assert.equal(
          realpathSync(directory),
          realpathSync(resolve(root, 'third_party/tailcat')),
          'Tailcat source differs from its gitlink.',
        );
        add(
          'golang',
          name,
          web.dependencies.wasm.main.version,
          directory,
          'distribution',
          identity.tailcatRevision,
        );
      } else {
        assert.equal(replacement, '', 'Unexpected dependency replacement.');
        add('golang', name, version, directory);
      }
    }
  }
  stage = 'bundled npm and source-skill notices';
  const webPackage = JSON.parse(
    readFileSync(resolve(root, 'apps/web/package.json'), 'utf8'),
  );
  assert.deepEqual(
    web.dependencies.npm.map((item) => item.name).sort(),
    [...Object.keys(webPackage.dependencies), 'vite'].sort(),
    'Bundled npm source inventory differs.',
  );
  for (const { name, version } of web.dependencies.npm) {
    const directory = resolve(root, 'apps/web/node_modules', name);
    const pkg = JSON.parse(
      readFileSync(resolve(directory, 'package.json'), 'utf8'),
    );
    assert.equal(pkg.name, name);
    assert.equal(pkg.version, version);
    add('npm', name, version, directory);
  }
  const openspec = resolve(root, 'node_modules/@fission-ai/openspec');
  assert.equal(
    JSON.parse(readFileSync(resolve(openspec, 'package.json'), 'utf8')).version,
    versions.openspec,
    'OpenSpec source version differs.',
  );
  add(
    'npm',
    '@fission-ai/openspec',
    versions.openspec,
    openspec,
    'source-skills',
  );
  stage = 'source notice preservation';
  const budget = { entries: 0, notices: 0, bytes: 0 };
  const notices = thirdPartyNotices(
    [...libraries.values()].map(({ directory, ...library }) => ({
      ...library,
      files: noticeFiles(directory, '', budget),
    })),
  );
  const inventory = Buffer.from(
    `${JSON.stringify(notices.inventory, null, 2)}\n`,
  );
  const outputs = [
    ['THIRD_PARTY_NOTICES.txt', notices.source],
    ['tooling/third-party-licenses.json', inventory],
  ];
  stage = 'checked-in notice identity';
  for (const [name, source] of outputs) {
    if (process.argv[2] === 'generate')
      writeFileSync(resolve(root, name), source);
    else
      assert.deepEqual(
        readFileSync(resolve(root, name)),
        source,
        'Dependency notices drifted; review and explicitly regenerate.',
      );
  }
  process.stdout.write(
    `Third-party notices ${process.argv[2] === 'generate' ? 'generated' : 'verified'}: ${libraries.size} component versions, ${notices.inventory.libraries.reduce((count, library) => count + library.files.length, 0)} source files.\n`,
  );
}

try {
  main();
} catch (error) {
  process.stderr.write(
    `Third-party notice verification failed during ${stage}. No publication attempted.\n`,
  );
  if (error.code === 'ERR_ASSERTION' && error.generatedMessage === false)
    process.stderr.write(`${error.message.split('\n')[0]}\n`);
  process.exitCode = 1;
}
