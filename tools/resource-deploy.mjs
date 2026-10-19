import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { buildIdentity } from './build-identity.ts';
import { digest, webObjectMetadata } from './web-assets.ts';
import { runPnpm } from './process.mjs';

export function prepareResourceDeployment(source, destination) {
  const manifestBytes = readFileSync(join(source, 'web-manifest.json'));
  assert.ok(
    manifestBytes.length <= 2 * 1024 * 1024,
    'Release manifest is oversized.',
  );
  const manifest = JSON.parse(manifestBytes);
  assert.equal(manifest.schemaVersion, 2);
  assert.deepEqual(manifest.protocols, { escape: 1, leash: 2, resource: 2 });
  assert.equal(manifest.resourceProtocol?.frontendMajor, 1);
  assert.equal(manifest.resourceProtocol?.protocolMajor, 2);
  const paths = Object.keys(manifest.files).sort((a, b) =>
    a.localeCompare(b, 'en'),
  );
  assert.ok(
    paths.length > 0 && paths.length <= 512,
    'Invalid release inventory.',
  );
  const found = [];
  function collect(directory, prefix = '') {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      assert.match(entry.name, /^[A-Za-z0-9_.-]+$/u, 'Unsafe asset name.');
      assert.ok(!entry.isSymbolicLink(), 'Asset symlinks are forbidden.');
      const name = prefix + entry.name;
      if (entry.isDirectory()) collect(join(directory, entry.name), name + '/');
      else {
        assert.ok(entry.isFile(), 'Invalid asset type.');
        found.push(name);
      }
    }
  }
  collect(source);
  assert.deepEqual(
    found.sort((a, b) => a.localeCompare(b, 'en')),
    [...paths, 'web-manifest.json'].sort((a, b) => a.localeCompare(b, 'en')),
    'Unlisted or missing release asset.',
  );
  for (const name of paths) {
    assert.match(name, /^(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+$/u);
    assert.ok(
      !name.split('/').some((part) => part === '.' || part === '..'),
      'Unsafe manifest path.',
    );
    const data = readFileSync(join(source, name));
    const metadata = manifest.files[name];
    assert.deepEqual(
      metadata,
      { bytes: data.length, sha256: digest(data), ...webObjectMetadata(name) },
      'Release asset integrity mismatch.',
    );
    if (name.endsWith('.wasm')) {
      for (const [suffix, decode] of [
        ['.br', brotliDecompressSync],
        ['.gz', gunzipSync],
      ]) {
        assert.ok(paths.includes(name + suffix), 'Missing compressed Wasm.');
        assert.ok(
          decode(readFileSync(join(source, name + suffix))).equals(data),
          'Wasm encoding mismatch.',
        );
      }
    } else
      assert.ok(
        data.length <= 25 * 1024 * 1024,
        'Cloudflare asset exceeds 25 MiB.',
      );
  }
  assert.ok(
    paths.includes(manifest.resourceProtocol.wasm),
    'Missing resource Wasm.',
  );
  for (const name of [
    '.tailmouse/bridge.html',
    '.tailmouse/bridge.js',
    '.tailmouse/sw.js',
    '.tailmouse/shim.js',
  ])
    assert.ok(paths.includes(name), 'Missing preview bootstrap.');
  // Validate everything before replacing this disposable deployment directory.
  rmSync(destination, { recursive: true, force: true });
  mkdirSync(destination, { recursive: true });
  for (const name of [...paths, 'web-manifest.json']) {
    // Raw Wasm exceeds the provider's limit; the Worker serves verified encodings.
    if (name.endsWith('.wasm')) continue;
    mkdirSync(dirname(join(destination, name)), { recursive: true });
    cpSync(join(source, name), join(destination, name));
  }
  return {
    manifest,
    manifestSha256: digest(manifestBytes),
    files: paths.length + 1,
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const root = resolve(import.meta.dirname, '..');
  const action = process.argv[2] ?? 'prepare';
  if (!['prepare', 'check', 'publish'].includes(action))
    throw new Error('Expected prepare, check or publish.');
  const source = join(root, 'apps/web/dist');
  if (action === 'publish') {
    const manifest = JSON.parse(
      readFileSync(join(source, 'web-manifest.json'), 'utf8'),
    );
    const identity = buildIdentity(root, manifest.version);
    for (const [key, value] of Object.entries(identity))
      assert.deepEqual(manifest[key], value, 'Deployment identity mismatch.');
    assert.ok(
      !identity.version.endsWith('.dirty'),
      'Rebuild from clean sources.',
    );
    assert.equal(
      manifest.resourceProtocol.sourceRevision,
      execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: root,
        encoding: 'utf8',
      }).trim(),
      'Deployment was built from a different source revision.',
    );
  }
  const result = prepareResourceDeployment(
    source,
    join(root, '.artifacts/resource-deploy/assets'),
  );
  if (action !== 'prepare')
    runPnpm([
      '--filter',
      '@tailmouse/link-edge',
      'exec',
      'wrangler',
      'deploy',
      '--config',
      '../../deploy/resource/wrangler.jsonc',
      ...(action === 'check'
        ? ['--dry-run', '--outdir', '../../.artifacts/resource-deploy/worker']
        : []),
    ]);
  process.stdout.write(
    `${action === 'publish' ? 'Published' : 'Prepared'} static resource release ${result.manifestSha256}.\n`,
  );
}
