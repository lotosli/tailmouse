import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { prepareResourceDeployment } from '../../tools/resource-deploy.mjs';
import { digest } from '../../tools/web-assets.ts';
const require = createRequire(
  new URL('../../apps/link-edge/package.json', import.meta.url),
);
const { createTestHarness } = require('wrangler');
const root = resolve(import.meta.dirname, '../..');

await test(
  'real static Worker serves source-built assets, scoped bootstrap and decoded Wasm',
  { timeout: 120000 },
  async (t) => {
    const directory = mkdtempSync(
      resolve(tmpdir(), 'tailmouse-resource-runtime-'),
    );
    let server;
    // Node stops subsequent after hooks when an earlier hook throws. Release
    // the runtime's Windows file handles before removing its asset directory.
    t.after(async () => {
      const failures = [];
      try {
        await server?.close();
      } catch (error) {
        failures.push(error);
      }
      try {
        rmSync(directory, { recursive: true, force: true });
      } catch (error) {
        failures.push(error);
      }
      if (failures.length) {
        throw new AggregateError(failures, 'Resource fixture cleanup failed.');
      }
    });
    const source = resolve(root, 'apps/web/dist');
    const destination = resolve(directory, 'assets');
    const { manifest, manifestSha256 } = prepareResourceDeployment(
      source,
      destination,
    );
    const configuration = JSON.parse(
      readFileSync(resolve(import.meta.dirname, 'wrangler.jsonc'), 'utf8'),
    );
    server = createTestHarness({
      root: directory,
      workers: [
        {
          config: {
            ...configuration,
            main: resolve(import.meta.dirname, 'worker.ts'),
            routes: [],
            assets: { ...configuration.assets, directory: destination },
          },
        },
      ],
    });
    const { url } = await server.listen();
    const get = (path, options) =>
      fetch(new URL(path, url), {
        signal: AbortSignal.timeout(30000),
        ...options,
      });
    for (const [name, metadata] of Object.entries(manifest.files)) {
      const response = await get('/' + name, {
        headers: { 'Accept-Encoding': metadata.contentEncoding ?? 'identity' },
      });
      assert.equal(response.status, 200, name);
      assert.equal(
        response.headers.get('content-type'),
        metadata.contentType,
        name,
      );
      assert.equal(
        response.headers.get('referrer-policy'),
        'no-referrer',
        name,
      );
      assert.equal(
        response.headers.get('x-content-type-options'),
        'nosniff',
        name,
      );
      assert.equal(
        response.headers.get('cache-control'),
        /^(assets|tailcat)\//u.test(name)
          ? 'public, max-age=31536000, immutable'
          : 'no-store',
        name,
      );
      const rawName = metadata.contentEncoding ? name.slice(0, -3) : name;
      const data = new Uint8Array(await response.arrayBuffer());
      assert.equal(data.length, manifest.files[rawName].bytes, name);
      assert.equal(digest(data), manifest.files[rawName].sha256, name);
    }
    assert.equal(
      digest(
        new Uint8Array(await (await get('/web-manifest.json')).arrayBuffer()),
      ),
      manifestSha256,
    );
    const config = await get('/tailmouse-config.json');
    assert.equal(config.status, 200);
    assert.equal((await config.json()).testSingleOrigin, true);
    for (const path of ['/', '/.tailmouse/workspace/']) {
      const response = await get(path + '?ignored=1');
      assert.equal(response.status, 200);
      assert.equal(
        digest(new Uint8Array(await response.arrayBuffer())),
        manifest.files['index.html'].sha256,
      );
      assert.equal(response.headers.get('cache-control'), 'no-store');
    }
    const bridge = await get(
      '/.tailmouse/p/' + 'a'.repeat(32) + '/bridge.html',
    );
    assert.equal(bridge.status, 200);
    assert.match(
      bridge.headers.get('content-security-policy'),
      /frame-ancestors 'self'/u,
    );
    assert.equal(
      (await get('/.tailmouse/sw.js')).headers.get('service-worker-allowed'),
      '/.tailmouse/p/',
    );
    for (const [name, metadata] of Object.entries(manifest.files).filter(
      ([name]) => name.endsWith('.wasm'),
    )) {
      for (const encoding of ['br', 'gzip', 'identity']) {
        const response = await get('/' + name, {
          headers: { 'Accept-Encoding': encoding },
        });
        assert.equal(response.status, 200);
        assert.equal(response.headers.get('content-type'), 'application/wasm');
        const data = new Uint8Array(await response.arrayBuffer());
        assert.equal(data.length, metadata.bytes);
        assert.equal(digest(data), metadata.sha256);
      }
    }
    assert.equal(
      (await get('/application-business-endpoint', { method: 'POST' })).status,
      405,
    );
    assert.equal((await get('/missing')).status, 404);
  },
);
