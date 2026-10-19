import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { staticHosting, webObjectMetadata } from '../../tools/web-assets.ts';
import { generateEdgeRelease } from '../../tools/link-edge-release.mjs';

const applicationDirectory = import.meta.dirname;
const maximumFileBytes = 128 * 1024 * 1024;

function boundedFile(path, maximum) {
  const stat = lstatSync(path);
  assert.ok(
    stat.isFile() &&
      !stat.isSymbolicLink() &&
      stat.size <= maximum &&
      realpathSync(path) === path,
    'Expected a bounded regular static file.',
  );
  return readFileSync(path);
}

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function prepareStaticManifest(
  distribution = resolve(applicationDirectory, '../web/dist'),
  output = resolve(applicationDirectory, '.artifacts/static-manifest.json'),
) {
  const directory = realpathSync(distribution);
  const source = boundedFile(
    resolve(directory, 'web-manifest.json'),
    2 * 1024 * 1024,
  );
  const manifest = JSON.parse(source.toString('utf8'));
  assert.equal(manifest.schemaVersion, 2, 'Unsupported static manifest.');
  assert.deepEqual(manifest.staticHosting, staticHosting);
  const entries = Object.entries(manifest.files ?? {});
  assert.ok(entries.length > 0 && entries.length <= 128);
  let totalBytes = source.byteLength;
  const files = Object.fromEntries(
    entries.map(([path, metadata]) => {
      assert.match(
        path,
        /^(?:\.tailmouse\/)?[A-Za-z0-9_-]+(?:[./][A-Za-z0-9_-]+)*$/u,
      );
      assert.notEqual(path, 'web-manifest.json');
      assert.ok(
        Number.isSafeInteger(metadata.bytes) &&
          metadata.bytes >= 0 &&
          metadata.bytes <= maximumFileBytes,
      );
      assert.match(metadata.sha256, /^[0-9a-f]{64}$/u);
      const expected = webObjectMetadata(path);
      assert.deepEqual(metadata, {
        bytes: metadata.bytes,
        sha256: metadata.sha256,
        ...expected,
      });
      const bytes = boundedFile(resolve(directory, path), maximumFileBytes);
      assert.equal(bytes.byteLength, metadata.bytes, 'Static size mismatch.');
      assert.equal(digest(bytes), metadata.sha256, 'Static hash mismatch.');
      totalBytes += bytes.byteLength;
      assert.ok(totalBytes <= 256 * 1024 * 1024);
      return [path, metadata];
    }),
  );
  assert.ok(files['index.html'], 'Static entry is missing.');
  const result = {
    schemaVersion: 1,
    webManifestSha256: digest(source),
    requiredHeaders: staticHosting.requiredHeaders,
    files: {
      ...files,
      'web-manifest.json': {
        bytes: source.byteLength,
        sha256: digest(source),
        ...staticHosting.manifestObject.metadata,
      },
    },
  };
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  assert.ok(
    process.argv.length === 2 ||
      (process.argv.length === 3 && process.argv[2] === '--prepare'),
    'Only --prepare is supported.',
  );
  const manifest = prepareStaticManifest();
  process.stdout.write(
    `Verified ${Object.keys(manifest.files).length} static edge objects.\n`,
  );
  if (process.argv[2] !== '--prepare') {
    const result = spawnSync(
      process.execPath,
      [
        resolve(applicationDirectory, 'node_modules/wrangler/bin/wrangler.js'),
        'deploy',
        '--dry-run',
        '--outdir',
        'dist',
        '--metafile',
        '.artifacts/bundle-meta.json',
        '--config',
        'wrangler.jsonc',
      ],
      {
        cwd: applicationDirectory,
        env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
        stdio: 'inherit',
      },
    );
    if (result.error) throw result.error;
    assert.equal(result.status, 0, 'Static edge dry-run build failed.');
    try {
      const release = generateEdgeRelease(
        resolve(applicationDirectory, '../..'),
      );
      process.stdout.write(
        `Verified ${release.identities.length} edge release files.\n`,
      );
    } catch {
      throw new Error(
        'Edge release verification failed. No publication attempted.',
      );
    }
  }
}
