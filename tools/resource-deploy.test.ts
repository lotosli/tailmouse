import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { gzipSync, brotliCompressSync } from 'node:zlib';
import { prepareResourceDeployment } from './resource-deploy.mjs';
import { digest, webObjectMetadata } from './web-assets.ts';

await test('deployment staging verifies every byte and both Wasm representations before replacement', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'tailmouse-resource-deploy-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'source'),
    dest = join(root, 'assets');
  mkdirSync(source);
  mkdirSync(dest);
  const put = (name: string, data: Uint8Array | string) => {
    const path = join(source, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, data);
  };
  const wasm = Buffer.from('synthetic Wasm');
  const files: Record<
    string,
    ReturnType<typeof webObjectMetadata> & { bytes: number; sha256: string }
  > = {};
  for (const [name, data] of Object.entries({
    'index.html': Buffer.from('<!doctype html>'),
    '.tailmouse/bridge.html': Buffer.from('<iframe></iframe>'),
    '.tailmouse/bridge.js': Buffer.from('void 0;'),
    '.tailmouse/sw.js': Buffer.from('void 0;'),
    '.tailmouse/shim.js': Buffer.from('void 0;'),
    'tailcat/resource-12345678.wasm': wasm,
    'tailcat/resource-12345678.wasm.br': brotliCompressSync(wasm),
    'tailcat/resource-12345678.wasm.gz': gzipSync(wasm),
  })) {
    put(name, data);
    files[name] = {
      bytes: data.length,
      sha256: digest(data),
      ...webObjectMetadata(name),
    };
  }
  const manifest = {
    schemaVersion: 2,
    protocols: { escape: 1, leash: 2, resource: 2 },
    resourceProtocol: {
      frontendMajor: 1,
      protocolMajor: 2,
      wasm: 'tailcat/resource-12345678.wasm',
    },
    files,
  };
  const reset = () => put('web-manifest.json', JSON.stringify(manifest));
  reset();
  const result = prepareResourceDeployment(source, dest);
  assert.equal(result.files, Object.keys(files).length + 1);
  assert.equal(existsSync(join(dest, 'tailcat/resource-12345678.wasm')), false);
  assert.ok(
    readFileSync(join(dest, 'tailcat/resource-12345678.wasm.gz')).equals(
      gzipSync(wasm),
    ),
  );
  const marker = join(dest, 'accepted.txt');
  writeFileSync(marker, 'keep previous candidate');
  put('index.html', 'changed');
  assert.throws(() => prepareResourceDeployment(source, dest), /integrity/u);
  assert.equal(readFileSync(marker, 'utf8'), 'keep previous candidate');
  put('index.html', '<!doctype html>');
  put('unlisted.txt', 'extra');
  assert.throws(() => prepareResourceDeployment(source, dest), /Unlisted/u);
  rmSync(join(source, 'unlisted.txt'));
  symlinkSync(join(source, 'index.html'), join(source, 'linked.html'));
  assert.throws(() => prepareResourceDeployment(source, dest), /symlinks/u);
  rmSync(join(source, 'linked.html'));
  const compressed = gzipSync(Buffer.from('other bytes'));
  put('tailcat/resource-12345678.wasm.gz', compressed);
  files['tailcat/resource-12345678.wasm.gz'] = {
    bytes: compressed.length,
    sha256: digest(compressed),
    ...webObjectMetadata('tailcat/resource-12345678.wasm.gz'),
  };
  reset();
  assert.throws(
    () => prepareResourceDeployment(source, dest),
    /encoding mismatch/u,
  );
  assert.ok(existsSync(marker));
});
