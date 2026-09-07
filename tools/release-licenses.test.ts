import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { test } from 'node:test';
import {
  distributionNotices,
  projectNotices,
  thirdPartyNotices,
  verifyNoticeCoverage,
  type NoticeLibrary,
} from './release-licenses.ts';

await test('release notice coverage requires every actual dependency and the recorded source revision', () => {
  const source = { ...syntheticLibrary(), revision: 'a'.repeat(40) };
  const sourceOnly = {
    ...syntheticLibrary(),
    name: 'example.invalid/skills',
    scope: 'source-skills' as const,
  };
  const { inventory } = thirdPartyNotices([source, sourceOnly]);
  const component = {
    name: source.name,
    version: source.version,
    purl: `pkg:golang/${source.name}@${source.version}`,
    properties: [{ name: 'tailmouse:git-revision', value: source.revision }],
  };
  verifyNoticeCoverage(inventory, [component, component]);
  for (const components of [
    [],
    [{ ...component, version: 'v9.0.0' }],
    [{ ...component, properties: [] }],
    [{ ...component, name: sourceOnly.name }],
    [{ ...component, purl: undefined }],
  ])
    assert.throws(() => verifyNoticeCoverage(inventory, components));
});

await test('distribution notice bytes must match the checked-in source inventory', (t) => {
  const root = resolve(import.meta.dirname, '..');
  assert.deepEqual(
    distributionNotices(root).map((file) => file.fileName),
    ['LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.txt'],
  );
  const directory = mkdtempSync(resolve(tmpdir(), 'tailmouse-notice-package-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const name of ['LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.txt'])
    copyFileSync(resolve(root, name), resolve(directory, name));
  assert.throws(() => distributionNotices(directory));
  // A changed notice is rejected even when the project license is intact.
  mkdirSync(resolve(directory, 'tooling'));
  copyFileSync(
    resolve(root, 'tooling/third-party-licenses.json'),
    resolve(directory, 'tooling/third-party-licenses.json'),
  );
  assert.equal(distributionNotices(directory).length, 3);
  writeFileSync(resolve(directory, 'THIRD_PARTY_NOTICES.txt'), 'Changed terms');
  assert.throws(
    () => distributionNotices(directory),
    /differs from its inventory/u,
  );
});

function syntheticLibrary(): NoticeLibrary {
  return {
    ecosystem: 'golang',
    name: 'example.invalid/module',
    version: 'v1.2.3',
    scope: 'distribution',
    files: [
      { name: 'LICENSE', source: Buffer.from('Synthetic root terms\r\n') },
      {
        name: 'nested/NOTICE',
        source: Buffer.from('Synthetic separate attribution\n'),
      },
    ],
  };
}

await test('third-party notices preserve nested bytes, provenance and stable ordering', () => {
  const first = syntheticLibrary();
  const second = {
    ...syntheticLibrary(),
    name: 'example.invalid/another',
    revision: 'a'.repeat(40),
  };
  const result = thirdPartyNotices([first, second]);
  assert.deepEqual(
    result,
    thirdPartyNotices([
      second,
      { ...first, files: [...first.files].reverse() },
    ]),
  );
  assert.equal(result.inventory.libraries.length, 2);
  assert.equal(result.inventory.libraries[0]!.revision, second.revision);
  assert.ok(result.source.includes(first.files[0]!.source));
  assert.ok(result.source.includes(first.files[1]!.source));
  assert.match(result.source.toString(), /nested\/NOTICE/u);
  assert.match(result.source.toString(), /conservatively included/u);
  assert.equal(
    result.inventory.libraries[0]!.files[0]!.bytes,
    first.files[0]!.source.length,
  );
  assert.match(result.inventory.noticeSha256, /^[a-f0-9]{64}$/u);
  const changed = syntheticLibrary();
  changed.files[0]!.source = Buffer.from('Changed synthetic terms');
  assert.notEqual(
    thirdPartyNotices([changed]).inventory.noticeSha256,
    thirdPartyNotices([first]).inventory.noticeSha256,
  );
});

await test('third-party notice rendering rejects missing grants, ambiguous identities and unsafe source data', () => {
  const original = syntheticLibrary();
  for (const libraries of [
    [],
    [original, original],
    Array.from({ length: 129 }, (_, index) => ({
      ...original,
      name: `example.invalid/m${index}`,
    })),
  ])
    assert.throws(() => thirdPartyNotices(libraries));
  for (const change of [
    { name: 'invalid\nname' },
    { version: 'latest' },
    { revision: 'unrecorded' },
    { files: [] },
    { files: [original.files[1]!] },
    { files: [original.files[0]!, original.files[0]!] },
    {
      files: [
        ...original.files,
        { name: '../outside', source: Buffer.from('synthetic') },
      ],
    },
    { files: [{ name: 'LICENSE', source: Buffer.alloc(0) }] },
    { files: [{ name: 'LICENSE', source: Buffer.alloc(2 * 1024 * 1024 + 1) }] },
    { files: [{ name: 'LICENSE', source: Buffer.from([0xff]) }] },
    { files: [{ name: 'LICENSE', source: Buffer.from('binary\0notice') }] },
    {
      files: [{ name: 'LICENSE', source: Buffer.from(`tc${'A'.repeat(80)}`) }],
    },
  ])
    assert.throws(() => thirdPartyNotices([{ ...original, ...change }]));
});

await test('project notices preserve the complete license and accepted project attribution', () => {
  const files = projectNotices(resolve(import.meta.dirname, '..'));
  assert.deepEqual(
    files.map((file) => file.fileName),
    ['LICENSE', 'NOTICE'],
  );
  assert.match(files[0]!.source.toString(), /END OF TERMS AND CONDITIONS/u);
  assert.match(files[1]!.source.toString(), /Third-party software retains/u);
});

await test('project notices reject missing, changed, excessive and linked source material', (t) => {
  const directory = mkdtempSync(resolve(tmpdir(), 'tailmouse-licenses-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const restore = () => {
    for (const name of ['LICENSE', 'NOTICE'])
      copyFileSync(
        resolve(import.meta.dirname, '..', name),
        resolve(directory, name),
      );
  };
  assert.throws(() => projectNotices(directory));
  restore();
  for (const [name, source, expected] of [
    ['LICENSE', 'Apache-2.0', /complete Apache/u],
    ['NOTICE', 'unattributed', /accepted attribution/u],
    ['NOTICE', 'x'.repeat(65537), /bounded regular/u],
    ['NOTICE', `tc${'A'.repeat(80)}`, /Possible ConnBlob/u],
  ] as const) {
    writeFileSync(resolve(directory, name), source);
    assert.throws(() => projectNotices(directory), expected);
    restore();
  }
  rmSync(resolve(directory, 'NOTICE'));
  symlinkSync(
    resolve(import.meta.dirname, '..', 'NOTICE'),
    resolve(directory, 'NOTICE'),
  );
  assert.throws(() => projectNotices(directory), /bounded regular/u);
});

await test('notice command explicitly updates sources and fails closed on drift or a missing grant', (t) => {
  const fixture = mkdtempSync(resolve(tmpdir(), 'tailmouse-notice-command-'));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  const put = (name: string, source: string | Uint8Array) => {
    const path = resolve(fixture, name);
    mkdirSync(resolve(path, '..'), { recursive: true });
    writeFileSync(path, source);
  };
  for (const name of [
    'release-licenses.mjs',
    'release-licenses.ts',
    'sbom.ts',
    'web-dependencies.ts',
  ])
    put(`tools/${name}`, readFileSync(new URL(name, import.meta.url)));
  for (const name of ['LICENSE', 'NOTICE'])
    put(name, readFileSync(resolve(import.meta.dirname, '..', name)));
  const revision = '1'.repeat(40);
  const tailcatName = 'github.com/tailscale/tailcat';
  const tailcatVersion = 'v0.4.1-0.20260901000000-111111111111';
  const module = {
    name: 'example.invalid/module',
    version: 'v1.2.3',
    sum: `h1:${'A'.repeat(43)}=`,
  };
  put(
    'tools/build-identity.ts',
    `export const buildIdentity = () => ({tailcatRevision: '${revision}'});`,
  );
  put(
    'tooling/versions.json',
    JSON.stringify({
      node: process.versions.node,
      go: '1.27.1',
      openspec: '1.11.0',
    }),
  );
  put('apps/web/package.json', JSON.stringify({ dependencies: {} }));
  put(
    'apps/web/node_modules/vite/package.json',
    JSON.stringify({ name: 'vite', version: '8.0.0' }),
  );
  put(
    'node_modules/@fission-ai/openspec/package.json',
    JSON.stringify({ name: '@fission-ai/openspec', version: '1.11.0' }),
  );
  for (const directory of [
    'third_party/tailcat',
    'dependency',
    'goroot',
    'apps/web/node_modules/vite',
    'node_modules/@fission-ai/openspec',
  ])
    put(`${directory}/LICENSE`, `Synthetic terms for ${directory}\r\n`);
  put('dependency/nested/NOTICE', 'Synthetic nested attribution\n');
  const wasm = {
    main: { name: tailcatName, version: tailcatVersion, revision },
    modules: [module],
  };
  put(
    'apps/web/dist/web-manifest.json',
    JSON.stringify({
      schemaVersion: 2,
      tailcatRevision: revision,
      dependencies: { npm: [{ name: 'vite', version: '8.0.0' }], wasm },
    }),
  );
  const info = [
    `path\t${tailcatName}/web`,
    `mod\t${tailcatName}\t${tailcatVersion}\t`,
    `dep\t${module.name}\t${module.version}\t${module.sum}`,
    'build\t-trimpath=true',
    'build\tCGO_ENABLED=0',
    'build\tGOARCH=wasm',
    'build\tGOOS=js',
    `build\tvcs.revision=${revision}`,
    'build\tvcs.modified=false',
    '',
  ].join('\n');
  put(
    '.artifacts/tailcat/tailcat-web.wasm',
    Buffer.concat([
      Buffer.from('0061736d01000000', 'hex'),
      Buffer.from('3077af0c9274080241e1c107e6d618e6', 'hex'),
      Buffer.from(info),
      Buffer.from('f932433186182072008242104116d8f2', 'hex'),
    ]),
  );
  const mock = `
    export function execFileSync(command, args, options) {
      if (command !== 'go' || options.env.GOWORK !== 'off' || options.env.CGO_ENABLED !== '0') throw new Error('Unexpected command');
      if (args[0] === 'env') return ${JSON.stringify(`go1.27.1\n${resolve(fixture, 'goroot')}`)};
      if (args[0] === 'list') return ${JSON.stringify(`${tailcatName}|v0.0.0|${resolve(fixture, 'third_party/tailcat')}|\n${module.name}|${module.version}|${resolve(fixture, 'dependency')}|`)};
      throw new Error('Unexpected Go command');
    }
  `;
  put(
    'mock.mjs',
    `import {registerHooks} from 'node:module'; registerHooks({resolve(name, context, next) { return name === 'node:child_process' ? {url: ${JSON.stringify(`data:text/javascript,${encodeURIComponent(mock)}`)}, shortCircuit: true} : next(name, context); }});`,
  );
  const run = (action: string) => {
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        resolve(fixture, 'mock.mjs'),
        resolve(fixture, 'tools/release-licenses.mjs'),
        action,
      ],
      { encoding: 'utf8', timeout: 10000 },
    );
    if (result.error) throw result.error;
    return result;
  };
  assert.notEqual(run('check').status, 0);
  const generated = run('generate');
  assert.equal(generated.status, 0, generated.stderr);
  assert.match(generated.stdout, /5 component versions, 6 source files/u);
  assert.equal(run('check').status, 0);
  const before = readFileSync(resolve(fixture, 'THIRD_PARTY_NOTICES.txt'));
  put('dependency/nested/NOTICE', 'Updated synthetic attribution\n');
  const drift = run('check');
  assert.notEqual(drift.status, 0);
  assert.match(drift.stderr, /Dependency notices drifted/u);
  assert.deepEqual(
    readFileSync(resolve(fixture, 'THIRD_PARTY_NOTICES.txt')),
    before,
  );
  assert.equal(run('generate').status, 0);
  assert.equal(run('check').status, 0);
  const updated = readFileSync(resolve(fixture, 'THIRD_PARTY_NOTICES.txt'));
  assert.notDeepEqual(updated, before);
  rmSync(resolve(fixture, 'dependency/LICENSE'));
  const missing = run('generate');
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /no root license grant/u);
  assert.deepEqual(
    readFileSync(resolve(fixture, 'THIRD_PARTY_NOTICES.txt')),
    updated,
  );
});
