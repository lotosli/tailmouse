import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { buildIdentity } from './build-identity.ts';
import { reviewedEdgeConfig } from './link-edge-config.ts';
import {
  edgeBundleInventory,
  edgeCompilerIdentity,
  generateEdgeRelease,
  verifyEdgeRelease,
} from './link-edge-release.mjs';
import { fileIdentity } from './sbom.ts';

const cborgVersion = '6.1.2';
const cborgPath = `../../node_modules/.pnpm/cborg@${cborgVersion}/node_modules/cborg/cborg.js`;
const owned = [
  '.artifacts/static-manifest.json',
  'src/api.ts',
  'src/index.ts',
  'src/short-invitation.ts',
  'src/static.ts',
];
const imported = {
  path: 'cloudflare:workers',
  kind: 'import-statement',
  external: true,
};

function bundle(staticSource = Buffer.from('{}')) {
  const sources = new Map(
    [cborgPath, ...owned].map((name) => [
      name,
      name === owned[0]
        ? staticSource
        : Buffer.from(`// Synthetic ${name}\nexport const fixture = 1;\n`),
    ]),
  );
  const meta = {
    inputs: Object.fromEntries(
      [...sources].map(([name, source]) => [
        name,
        {
          bytes: source.length,
          imports:
            name === 'src/index.ts'
              ? [
                  imported,
                  { path: cborgPath, kind: 'import-statement' },
                  {
                    path: '<runtime>',
                    kind: 'import-statement',
                    external: true,
                  },
                ]
              : [],
          format: 'esm',
        },
      ]),
    ),
    outputs: {
      'dist/index.js': {
        imports: [imported],
        exports: ['ShortInvitation', 'default'],
        entryPoint: 'src/index.ts',
        inputs: Object.fromEntries(
          [...sources.keys()].map((name) => [name, { bytesInOutput: 1 }]),
        ),
        bytes: 0,
      },
      'dist/index.js.map': { imports: [], exports: [], inputs: {}, bytes: 0 },
    },
  };
  const sourceMap = {
    version: 3,
    sources: [...sources.keys()].map((name) => `../${name}`),
    sourceRoot: 'dist',
    sourcesContent: [...sources.values()].map((source) =>
      source.toString('utf8'),
    ),
    mappings: 'AAAA',
    names: [],
  };
  return { meta, sourceMap, sources };
}

await test('edge compiler inventory binds exact source bytes, current cborg, platform import and SQLite export', () => {
  const fixture = bundle();
  const result = edgeBundleInventory(
    fixture.meta,
    fixture.sourceMap,
    fixture.sources,
    cborgVersion,
  );
  assert.equal(result.length, 6);
  assert.deepEqual(
    result.find((item) => item.name === 'npm/cborg/cborg.js'),
    fileIdentity('npm/cborg/cborg.js', fixture.sources.get(cborgPath)!),
  );
  assert.ok(
    result.every(
      (item) =>
        !item.name.includes('node_modules') && !item.name.startsWith('/'),
    ),
  );
});

await test('edge compiler inventory rejects changed sources, unknown input/imports, and incomplete maps or exports', () => {
  const mutations: ((fixture: ReturnType<typeof bundle>) => void)[] = [
    (fixture) => {
      fixture.sources.set('src/index.ts', Buffer.from('altered'));
    },
    (fixture) => {
      fixture.sources.delete(cborgPath);
    },
    (fixture) => {
      fixture.meta.inputs['src/index.ts']!.imports.push({
        path: 'node:fs',
        kind: 'import-statement',
        external: true,
      });
    },
    (fixture) => {
      fixture.meta.inputs['src/index.ts']!.imports.push({
        path: './missing.ts',
        kind: 'import-statement',
      });
    },
    (fixture) => {
      fixture.meta.inputs['src/index.ts']!.imports.push({
        path: cborgPath,
        kind: 'dynamic-import',
      });
    },
    (fixture) => {
      fixture.meta.inputs['src/index.ts']!.format = 'cjs';
    },
    (fixture) => {
      fixture.meta.inputs['src/index.ts']!.bytes++;
    },
    (fixture) => {
      delete fixture.meta.inputs['src/static.ts'];
    },
    (fixture) => {
      fixture.meta.outputs['dist/index.js'].entryPoint = 'src/api.ts';
    },
    (fixture) => {
      fixture.meta.outputs['dist/index.js'].exports = ['default'];
    },
    (fixture) => {
      fixture.meta.outputs['dist/index.js'].imports.push({
        ...imported,
        path: 'node:fs',
      });
    },
    (fixture) => {
      delete fixture.meta.outputs['dist/index.js'].inputs['src/api.ts'];
    },
    (fixture) => {
      fixture.meta.outputs['dist/index.js'].inputs[
        'src/api.ts'
      ]!.bytesInOutput = 0;
    },
    (fixture) => {
      fixture.meta.outputs['dist/index.js.map'].inputs = {
        extra: { bytesInOutput: 1 },
      };
    },
    (fixture) => {
      fixture.sourceMap.sources[0] = '/private/absolute';
    },
    (fixture) => {
      fixture.sourceMap.sourcesContent[0] = 'altered source';
    },
    (fixture) => {
      fixture.sourceMap.sourcesContent.pop();
    },
    (fixture) => {
      fixture.sourceMap.sourceRoot = '/absolute';
    },
    (fixture) => {
      fixture.sourceMap.version = 2;
    },
    (fixture) => {
      Object.assign(fixture.meta, { unreviewed: true });
    },
    (fixture) => {
      Object.assign(fixture.sourceMap, { unreviewed: true });
    },
    (fixture) => {
      const key =
        '../../node_modules/.pnpm/unknown@1.0.0/node_modules/unknown/index.js';
      const source = Buffer.from('unknown');
      fixture.sources.set(key, source);
      fixture.meta.inputs[key] = {
        bytes: source.length,
        imports: [],
        format: 'esm',
      };
    },
    (fixture) => {
      const source = Buffer.from(
        `https://link.tailmouse.com/#/v1/${'A'.repeat(100)}`,
      );
      fixture.sources.set('src/index.ts', source);
      fixture.meta.inputs['src/index.ts']!.bytes = source.length;
    },
  ];
  for (const mutate of mutations) {
    const fixture = bundle();
    mutate(fixture);
    assert.throws(() =>
      edgeBundleInventory(
        fixture.meta,
        fixture.sourceMap,
        fixture.sources,
        cborgVersion,
      ),
    );
  }
  const fixture = bundle();
  assert.throws(() =>
    edgeBundleInventory(
      fixture.meta,
      fixture.sourceMap,
      fixture.sources,
      'latest',
    ),
  );
  assert.throws(() =>
    edgeBundleInventory(
      fixture.meta,
      fixture.sourceMap,
      fixture.sources,
      '6.1.1',
    ),
  );
});

function repository(t: { after: (cleanup: () => void) => void }) {
  const root = mkdtempSync(resolve(tmpdir(), 'tailmouse-edge-release-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (name: string, source: string | Uint8Array) => {
    const path = resolve(root, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, source);
  };
  const putJSON = (name: string, value: unknown) =>
    put(name, `${JSON.stringify(value, null, 2)}\n`);
  const git = (cwd: string, ...args: string[]) =>
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Synthetic Test',
        '-c',
        'user.email=test@example.invalid',
        ...args,
      ],
      { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    ).trim();
  const upstream = resolve(root, 'third_party/tailcat');
  mkdirSync(upstream, { recursive: true });
  for (const cwd of [root, upstream]) {
    git(cwd, 'init', '--initial-branch=main');
    git(
      cwd,
      'commit',
      '--allow-empty',
      '-m',
      'Initialize synthetic repository',
    );
  }
  putJSON('package.json', { version: '0.0.0' });
  git(root, 'add', '--', 'package.json');
  git(
    root,
    'update-index',
    '--add',
    '--cacheinfo',
    `160000,${git(upstream, 'rev-parse', 'HEAD')},third_party/tailcat`,
  );
  git(root, 'commit', '-m', 'Record synthetic dependency');
  putJSON('tooling/versions.json', {
    node: process.versions.node,
    wrangler: '4.129.0',
  });
  putJSON('apps/link-edge/wrangler.jsonc', reviewedEdgeConfig);
  putJSON('apps/link-edge/node_modules/wrangler/package.json', {
    name: 'wrangler',
    version: '4.129.0',
    dependencies: { esbuild: '0.28.1' },
  });
  putJSON('apps/link-edge/node_modules/esbuild/package.json', {
    name: 'esbuild',
    version: '0.28.1',
  });
  putJSON('apps/link-edge/node_modules/cborg/package.json', {
    name: 'cborg',
    version: cborgVersion,
  });
  for (const name of [
    'LICENSE',
    'NOTICE',
    'THIRD_PARTY_NOTICES.txt',
    'tooling/third-party-licenses.json',
  ])
    put(name, readFileSync(new URL(`../${name}`, import.meta.url)));
  const identity = buildIdentity(root);
  const webSource = Buffer.from(
    JSON.stringify({
      schemaVersion: 2,
      ...identity,
      dependencies: { npm: [{ name: 'cborg', version: cborgVersion }] },
    }),
  );
  put('apps/web/dist/web-manifest.json', webSource);
  const fixture = bundle(
    Buffer.from(
      JSON.stringify({
        webManifestSha256: fileIdentity('web-manifest.json', webSource).sha256,
      }),
    ),
  );
  for (const [name, source] of fixture.sources)
    put(`apps/link-edge/${name}`, source);
  const worker = Buffer.from(
    'import { DurableObject } from "cloudflare:workers"; export default {}; export class ShortInvitation extends DurableObject {}\n',
  );
  const map = Buffer.from(JSON.stringify(fixture.sourceMap));
  fixture.meta.outputs['dist/index.js'].bytes = worker.length;
  fixture.meta.outputs['dist/index.js.map'].bytes = map.length;
  put('apps/link-edge/dist/index.js', worker);
  put('apps/link-edge/dist/index.js.map', map);
  put(
    'apps/link-edge/dist/README.md',
    'This folder contains the built output assets for the worker "tailmouse-link-edge" generated at 2026-09-07T00:00:00.000Z.',
  );
  putJSON('apps/link-edge/.artifacts/bundle-meta.json', fixture.meta);
  return { root, put, putJSON, identity };
}

await test('edge release generation and distribution verification bind identity, config, compiler and every file', (t) => {
  const fixture = repository(t);
  const result = generateEdgeRelease(fixture.root);
  assert.equal(result.manifest.schemaVersion, 1);
  assert.equal(result.manifest.version, fixture.identity.version);
  assert.equal(
    result.manifest.role,
    'protected-short-invitation-and-static-edge',
  );
  assert.deepEqual(result.manifest.toolchains, {
    node: process.versions.node,
    wrangler: '4.129.0',
    esbuild: '0.28.1',
  });
  assert.deepEqual(result.manifest.dependencies, {
    npm: [{ name: 'cborg', version: cborgVersion }],
    platformImports: ['cloudflare:workers'],
  });
  assert.equal(result.identities.length, 8);
  const destination = resolve(fixture.root, 'distribution/edge');
  mkdirSync(destination, { recursive: true });
  for (const item of result.identities)
    copyFileSync(
      resolve(fixture.root, 'apps/link-edge/dist', item.name),
      resolve(destination, item.name),
    );
  assert.deepEqual(
    verifyEdgeRelease(fixture.root, destination).manifest,
    result.manifest,
  );
  const original = new Map(
    readdirSync(destination).map((name) => [
      name,
      readFileSync(resolve(destination, name)),
    ]),
  );
  for (const name of original.keys()) {
    writeFileSync(
      resolve(destination, name),
      Buffer.concat([original.get(name)!, Buffer.from('altered')]),
    );
    assert.throws(() => verifyEdgeRelease(fixture.root, destination), name);
    writeFileSync(resolve(destination, name), original.get(name)!);
  }
  // Rewriting both the distributed artifact and its declared hash cannot make
  // them match the current source-verified build outputs.
  const changed = Buffer.from('tampered worker');
  writeFileSync(resolve(destination, 'index.js'), changed);
  const manifest = structuredClone(result.manifest);
  const { name: _name, ...changedIdentity } = fileIdentity('index.js', changed);
  manifest.files['index.js'] = changedIdentity;
  writeFileSync(
    resolve(destination, 'edge-manifest.json'),
    JSON.stringify(manifest),
  );
  assert.throws(() => verifyEdgeRelease(fixture.root, destination));
  for (const [name, source] of original)
    writeFileSync(resolve(destination, name), source);
  writeFileSync(resolve(destination, 'README.md'), 'extra');
  assert.throws(() => verifyEdgeRelease(fixture.root, destination));
  rmSync(resolve(destination, 'README.md'));
  rmSync(resolve(destination, 'NOTICE'));
  symlinkSync(resolve(fixture.root, 'NOTICE'), resolve(destination, 'NOTICE'));
  assert.throws(() => verifyEdgeRelease(fixture.root, destination));
});

await test('edge release rejects source/config/compiler/Web drift and does not reflect diagnostics', (t) => {
  const fixture = repository(t);
  generateEdgeRelease(fixture.root);
  const mutations: [string, string][] = [
    ['apps/link-edge/src/api.ts', 'altered source'],
    ['apps/link-edge/dist/index.js', 'altered bundle'],
    ['apps/link-edge/dist/index.js.map', '{}'],
    ['apps/link-edge/dist/README.md', 'unreviewed output'],
    [
      'apps/link-edge/wrangler.jsonc',
      JSON.stringify({ ...reviewedEdgeConfig, logpush: true }),
    ],
    ['apps/link-edge/.artifacts/bundle-meta.json', '{}'],
    ['apps/web/dist/web-manifest.json', '{}'],
    [
      'apps/link-edge/node_modules/wrangler/package.json',
      JSON.stringify({
        name: 'wrangler',
        version: '4.129.1',
        dependencies: { esbuild: '0.28.1' },
      }),
    ],
    [
      'apps/link-edge/node_modules/esbuild/package.json',
      JSON.stringify({ name: 'esbuild', version: '0.28.2' }),
    ],
    [
      'apps/link-edge/node_modules/cborg/package.json',
      JSON.stringify({ name: 'cborg', version: '6.1.1' }),
    ],
    [
      'tooling/versions.json',
      JSON.stringify({ node: '1.0.0', wrangler: '4.129.0' }),
    ],
  ];
  for (const [name, source] of mutations) {
    const original = readFileSync(resolve(fixture.root, name));
    fixture.put(name, source);
    assert.throws(() => verifyEdgeRelease(fixture.root), name);
    fixture.put(name, original);
  }
  assert.deepEqual(edgeCompilerIdentity(fixture.root).npm, [
    { name: 'cborg', version: cborgVersion },
  ]);
  const child = spawnSync(
    process.execPath,
    [
      resolve(import.meta.dirname, 'link-edge-release.mjs'),
      'synthetic-sensitive-argument',
    ],
    { encoding: 'utf8' },
  );
  assert.equal(child.status, 1);
  assert.equal(child.stdout, '');
  assert.equal(
    child.stderr,
    'Edge release verification failed. No publication attempted.\n',
  );
});
