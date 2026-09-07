import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { npmDependencies, wasmDependencies } from './web-dependencies.ts';

const revision = '1'.repeat(40);
const moduleName = 'github.com/tailscale/tailcat';
const sum = `h1:${'A'.repeat(43)}=`;
const records =
  [
    `path\t${moduleName}/web`,
    `mod\t${moduleName}\tv0.4.1-0.20260901000000-111111111111\t`,
    `dep\texample.invalid/module\tv1.2.3\t${sum}`,
    'build\t-ldflags="-s -w"',
    'build\t-trimpath=true',
    'build\tCGO_ENABLED=0',
    'build\tGOARCH=wasm',
    'build\tGOOS=js',
    `build\tvcs.revision=${revision}`,
    'build\tvcs.modified=false',
  ].join('\n') + '\n';

function wasm(info = records) {
  return Buffer.concat([
    Buffer.from('0061736d01000000', 'hex'),
    Buffer.from('3077af0c9274080241e1c107e6d618e6', 'hex'),
    Buffer.from(info),
    Buffer.from('f932433186182072008242104116d8f2', 'hex'),
  ]);
}

await test('Wasm inventory uses embedded compiled modules and exact clean revision', () => {
  const inventory = wasmDependencies(wasm(), revision);
  assert.deepEqual(inventory, {
    main: {
      name: moduleName,
      version: 'v0.4.1-0.20260901000000-111111111111',
      revision,
    },
    modules: [{ name: 'example.invalid/module', version: 'v1.2.3', sum }],
  });
  assert.ok(!JSON.stringify(inventory).includes('ldflags'));
  const unordered = records + `dep\ta.invalid/a\tv0.2.0\t${sum}\n`;
  assert.equal(
    wasmDependencies(wasm(unordered), revision).modules[0]?.name,
    'a.invalid/a',
  );
});

await test('Wasm inventory requires trimmed source paths in the compiled artifact', () => {
  for (const info of [
    records.replace('build\t-trimpath=true\n', ''),
    records.replace('-trimpath=true', '-trimpath=false'),
  ])
    assert.throws(
      () => wasmDependencies(wasm(info), revision),
      /trimmed source paths/u,
    );
});

await test('Wasm inventory fails closed on missing, altered and unknown metadata', () => {
  for (const source of [
    Buffer.alloc(0),
    Buffer.from('not Wasm'),
    wasm().subarray(0, -1),
    Buffer.concat([wasm(), wasm()]),
    wasm('x'.repeat(64 * 1024)),
    wasm(records.slice(0, -1)),
    wasm(records.replace('vcs.modified=false', 'vcs.modified=true')),
    wasm(records.replace(revision, '2'.repeat(40))),
    wasm(records.replace('GOOS=js', 'GOOS=linux')),
    wasm(records.replace('GOARCH=wasm', 'GOARCH=arm64')),
    wasm(records.replace('CGO_ENABLED=0', 'CGO_ENABLED=1')),
    wasm(records.replace(`${moduleName}/web`, 'other.invalid/app')),
    wasm(records.replace(`mod\t${moduleName}`, 'mod\tother.invalid/app')),
    wasm(records.replace(/dep\t[^\n]*\n/u, '')),
    wasm(records.replace('v1.2.3', '(devel)')),
    wasm(records.replace(sum, '')),
    wasm(records.replace(sum, `${sum}\textra`)),
    wasm(records + `dep\texample.invalid/module\tv1.2.3\t${sum}\n`),
    wasm(records + `mod\tanother.invalid/app\tv1.0.0\t\n`),
    wasm(records + `=>\t../local\t(devel)\t\n`),
    wasm(records + 'build\tGOOS=js\n'),
    wasm(records + 'build\t=bad\n'),
    wasm(records + 'unknown\tvalue\n'),
    wasm(records + `path\t${moduleName}/web\n`),
  ])
    assert.throws(() => wasmDependencies(source, revision));
  assert.throws(() => wasmDependencies(wasm(), 'unrecorded'));
});

await test('npm inventory resolves shipped modules only, deduplicates and strips paths', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'tailmouse-npm-inventory-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  function packageFile(name: string, version: string, declaredName = name) {
    const root = join(
      directory,
      'node_modules',
      '.pnpm',
      `${name.replace('/', '+')}@${version}`,
      'node_modules',
      name,
    );
    mkdirSync(root, { recursive: true });
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: declaredName, version }),
    );
    return join(root, 'dist', 'index.js');
  }
  const preact = packageFile('preact', '10.29.3');
  const fit = packageFile('@xterm/addon-fit', '0.12.0');
  packageFile('unshipped-test-tool', '1.0.0');
  assert.deepEqual(
    npmDependencies(
      [
        preact,
        fit,
        preact,
        `${preact}?commonjs-proxy`,
        join(directory, 'apps', 'web', 'src', 'app.tsx'),
        '\0vite/modulepreload-polyfill.js',
      ],
      '8.2.2',
    ),
    [
      { name: '@xterm/addon-fit', version: '0.12.0' },
      { name: 'preact', version: '10.29.3' },
      { name: 'vite', version: '8.2.2' },
    ],
  );
  assert.deepEqual(
    npmDependencies([preact, packageFile('preact', '10.29.2')]).map(
      (x) => x.version,
    ),
    ['10.29.2', '10.29.3'],
  );
  assert.throws(() => npmDependencies([]), /no recorded/u);
  assert.throws(
    () => npmDependencies(['\0vite/modulepreload-polyfill.js']),
    /producer/u,
  );
  assert.throws(
    () => npmDependencies(['\0unknown/helper.js'], '8.2.2'),
    /producer/u,
  );
  assert.throws(
    () => npmDependencies(['\0vite/modulepreload-polyfill.js'], 'latest'),
    /producer/u,
  );
  assert.throws(
    () => npmDependencies(['/node_modules/.broken/file.js']),
    /unsupported/u,
  );
  assert.throws(
    () => npmDependencies([packageFile('bad', 'latest')]),
    /invalid/u,
  );
  assert.throws(
    () => npmDependencies([packageFile('mismatch', '1.0.0', 'other')]),
    /invalid/u,
  );
  assert.throws(() =>
    npmDependencies([join(directory, 'node_modules/missing/file.js')]),
  );
});
