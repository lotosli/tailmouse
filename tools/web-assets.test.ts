import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import {
  compressedAssets,
  digest,
  tailcatAssets,
  verifyStaticReferences,
} from './web-assets.ts';

test('Tailcat asset paths and checksums derive only from verified bytes', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'tailmouse-web-assets-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const revision = '1'.repeat(40);
  const files = Object.fromEntries(
    ['wasm_exec.js', 'tailcat-web.wasm'].map((name) => {
      const source = Buffer.from(`synthetic ${name}`);
      writeFileSync(join(directory, name), source);
      return [name, { bytes: source.length, sha256: digest(source) }];
    }),
  );
  writeFileSync(
    join(directory, 'manifest.json'),
    JSON.stringify({
      schemaVersion: 1,
      tailcatRevision: revision,
      goVersion: 'go1.27.1',
      files,
    }),
  );
  const { goVersion, files: assets } = tailcatAssets(
    directory,
    revision,
    'go1.27.1',
  );
  assert.equal(goVersion, 'go1.27.1');
  assert.equal(assets.length, 2);
  for (const asset of assets) {
    assert.match(
      asset.fileName,
      new RegExp(`-${digest(asset.source)}\\.(js|wasm)$`, 'u'),
    );
    assert.ok(asset.fileName.startsWith('tailcat/'));
  }
  assert.throws(
    () => tailcatAssets(directory, '2'.repeat(40), 'go1.27.1'),
    /revisions do not match/u,
  );
  assert.throws(
    () => tailcatAssets(directory, revision, 'go1.27.0'),
    /toolchain/u,
  );
  writeFileSync(join(directory, 'tailcat-web.wasm'), 'tampered');
  assert.throws(
    () => tailcatAssets(directory, revision, 'go1.27.1'),
    /checksum/u,
  );
  const original = JSON.parse(
    readFileSync(join(directory, 'manifest.json'), 'utf8'),
  ) as { files: unknown };
  delete (original as { files?: unknown }).files;
  writeFileSync(join(directory, 'manifest.json'), JSON.stringify(original));
  assert.throws(
    () => tailcatAssets(directory, revision, 'go1.27.1'),
    /checksum/u,
  );
  writeFileSync(
    join(directory, 'manifest.json'),
    JSON.stringify({ schemaVersion: 1, tailcatRevision: revision, files }),
  );
  assert.throws(
    () => tailcatAssets(directory, revision, 'go1.27.1'),
    /toolchain/u,
  );
});

test('gzip and Brotli artifacts are deterministic and preserve original bytes', () => {
  const source = Buffer.from(
    'synthetic static application bytes\0🐈'.repeat(100),
  );
  const first = compressedAssets('assets/app-12345678.js', source);
  assert.deepEqual(first, compressedAssets('assets/app-12345678.js', source));
  assert.deepEqual(gunzipSync(first[0]!.source), source);
  assert.deepEqual(brotliDecompressSync(first[1]!.source), source);
  assert.ok(first.every((item) => item.source.length < source.length));
});

test('static inspection rejects external and inline executable resources', () => {
  verifyStaticReferences(
    '<script type="module" src="./assets/app-12345678.js"></script><link href="./assets/app-12345678.css">',
    'html',
  );
  verifyStaticReferences(
    'body { background: url("./image-12345678.png"); }',
    'css',
  );
  for (const html of [
    '<script src="https://cdn.example/app.js"></script>',
    '<script src=https://cdn.example/app.js></script>',
    '<link href="//fonts.example/style.css">',
    '<script>alert(1)</script>',
    '<body onload="alert(1)">',
    '<script src="https&colon;//cdn.example/app.js"></script>',
  ])
    assert.throws(() => verifyStaticReferences(html, 'html'), /Web build/u);
  for (const css of [
    '@import "https://fonts.example/style.css";',
    'body { background: url(https://cdn.example/image.png); }',
    'body { background: url(\\68ttps://cdn.example/image.png); }',
  ])
    assert.throws(() => verifyStaticReferences(css, 'css'), /Web build/u);
});
