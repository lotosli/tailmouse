import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { encode } from 'cborg';
import { createTestHarness } from 'wrangler';
import { verifyPublicOrigin } from '../../tools/verify-public-origin.mjs';
import { staticHosting, webObjectMetadata } from '../../tools/web-assets.ts';
import { prepareStaticManifest } from './build.mjs';
import { verifyLifecycle } from './verify-lifecycle.mjs';

const appDirectory = import.meta.dirname;
const distribution = resolve(appDirectory, '../web/dist');

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

await test('edge preparation rejects stale, malformed, or escaped static objects', (t) => {
  const directory = mkdtempSync(resolve(tmpdir(), 'tailmouse-edge-build-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const output = resolve(directory, 'generated/static-manifest.json');
  const source = '<main>Synthetic TailMouse</main>';
  writeFileSync(resolve(directory, 'index.html'), source);
  const valid = {
    schemaVersion: 2,
    staticHosting,
    files: {
      'index.html': {
        bytes: Buffer.byteLength(source),
        sha256: digest(source),
        ...webObjectMetadata('index.html'),
      },
    },
  };
  const manifestPath = resolve(directory, 'web-manifest.json');
  const prepare = (manifest) => {
    writeFileSync(manifestPath, JSON.stringify(manifest));
    return prepareStaticManifest(directory, output);
  };
  const generated = prepare(valid);
  assert.equal(generated.webManifestSha256, digest(readFileSync(manifestPath)));
  assert.deepEqual(generated.files['index.html'], valid.files['index.html']);
  assert.equal(
    generated.files['web-manifest.json'].contentType,
    'application/json',
  );
  for (const invalid of [
    { ...valid, schemaVersion: 1 },
    { ...valid, staticHosting: {} },
    { ...valid, files: {} },
    { ...valid, files: { '../index.html': valid.files['index.html'] } },
    {
      ...valid,
      files: { 'index.html': { ...valid.files['index.html'], bytes: 1 } },
    },
    {
      ...valid,
      files: {
        'index.html': { ...valid.files['index.html'], sha256: '0'.repeat(64) },
      },
    },
    {
      ...valid,
      files: {
        'index.html': {
          ...valid.files['index.html'],
          contentType: 'text/plain',
        },
      },
    },
  ])
    assert.throws(() => prepare(invalid));
  assert.deepEqual(JSON.parse(readFileSync(output, 'utf8')), generated);
});

function rawRequest(url, headers = {}, method = 'GET') {
  return new Promise((resolveResult, reject) => {
    const request = httpRequest(url, { method, headers }, (response) => {
      const chunks = [];
      let received = 0;
      response.on('data', (chunk) => {
        received += chunk.byteLength;
        if (received > 128 * 1024 * 1024) {
          response.destroy(new Error('Local edge response exceeds its bound.'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () =>
        resolveResult({
          status: response.statusCode,
          headers: response.headers,
          body: Buffer.concat(chunks),
        }),
      );
    });
    request.setTimeout(10_000, () =>
      request.destroy(new Error('Local edge request timed out.')),
    );
    request.on('error', reject);
    request.end();
  });
}

await test(
  'the real local Worker preserves every published static byte and response contract',
  { timeout: 120_000 },
  async (t) => {
    const directory = mkdtempSync(resolve(tmpdir(), 'tailmouse-edge-runtime-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const compiled = prepareStaticManifest();
    const config = JSON.parse(
      readFileSync(resolve(appDirectory, 'wrangler.jsonc'), 'utf8'),
    );
    const server = createTestHarness({
      root: directory,
      workers: [
        {
          config: {
            ...config,
            main: resolve(appDirectory, 'src/index.ts'),
            r2_buckets: config.r2_buckets.map((binding) => ({
              ...binding,
              remote: false,
            })),
            observability: { enabled: false },
          },
        },
      ],
    });
    t.after(() => server.close());
    const { url } = await server.listen();
    const worker = server.getWorker();
    const env = await worker.getEnv();
    for (const [path, metadata] of Object.entries(compiled.files)) {
      const { contentType, cacheControl, contentEncoding, sha256 } = metadata;
      await env.STATIC_ASSETS.put(
        path,
        readFileSync(resolve(distribution, path)),
        {
          httpMetadata: {
            contentType,
            cacheControl,
            ...(contentEncoding ? { contentEncoding } : {}),
          },
          sha256,
        },
      );
    }
    const evidence = await verifyPublicOrigin(
      url.href,
      resolve(distribution, 'web-manifest.json'),
      { shortInvitations: true },
    );
    assert.equal(evidence.routing.shortInvitations.status, 'verified');
    assert.equal(evidence.routing.staticClientBackendRequired, false);
    assert.equal('applicationBackend' in evidence.routing, false);
    const index = readFileSync(resolve(distribution, 'index.html'));
    const short = await rawRequest(new URL('/T6wxZ8', url));
    assert.equal(short.status, 200);
    assert.equal(short.headers['cache-control'], 'no-store');
    assert.deepEqual(short.body, index);
    const head = await rawRequest(new URL('/T6wxZ8', url), {}, 'HEAD');
    assert.equal(head.status, 200);
    assert.equal(head.body.length, 0);
    assert.equal(head.headers['cache-control'], 'no-store');
    const notice = await rawRequest(new URL('/NOTICE', url));
    assert.equal(notice.status, 200);
    assert.deepEqual(
      notice.body,
      readFileSync(resolve(distribution, 'NOTICE')),
    );
    const wasmPath = Object.keys(compiled.files).find((path) =>
      path.endsWith('.wasm'),
    );
    assert.ok(wasmPath);
    for (const [encoding, suffix] of [
      ['br', '.br'],
      ['gzip', '.gz'],
    ]) {
      const compressed = await rawRequest(new URL(`/${wasmPath}`, url), {
        'accept-encoding': encoding,
      });
      assert.equal(compressed.status, 200);
      assert.equal(compressed.headers['content-encoding'], encoding);
      assert.deepEqual(
        compressed.body,
        readFileSync(resolve(distribution, `${wasmPath}${suffix}`)),
      );
      const compressedHead = await rawRequest(
        new URL(`/${wasmPath}`, url),
        { 'accept-encoding': encoding },
        'HEAD',
      );
      assert.equal(compressedHead.status, 200);
      assert.equal(compressedHead.headers['content-encoding'], encoding);
      assert.equal(compressedHead.body.length, 0);
      if (compressedHead.headers['content-length'] !== undefined)
        assert.equal(
          compressedHead.headers['content-length'],
          String(compiled.files[`${wasmPath}${suffix}`].bytes),
        );
    }
    const range = await rawRequest(new URL(`/${wasmPath}`, url), {
      range: 'bytes=0-7',
      'accept-encoding': 'identity',
    });
    assert.equal(range.status, 206);
    assert.equal(
      range.headers['content-range'],
      `bytes 0-7/${compiled.files[wasmPath].bytes}`,
    );
    assert.deepEqual(
      range.body,
      readFileSync(resolve(distribution, wasmPath)).subarray(0, 8),
    );
    const cached = await rawRequest(new URL('/index.html', url), {
      'if-none-match': `"${compiled.files['index.html'].sha256}"`,
    });
    assert.equal(cached.status, 304);
    assert.equal(cached.body.length, 0);
    assert.equal(
      JSON.stringify(server.getLogs()).includes('SYNTHETIC_PRIVATE'),
      false,
    );
  },
);

await test(
  'the local SQLite runtime orders protected allocation, renewal, deletion and alarm expiry',
  { timeout: 30_000 },
  async (t) => {
    const directory = mkdtempSync(resolve(tmpdir(), 'tailmouse-edge-lease-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const config = JSON.parse(
      readFileSync(resolve(appDirectory, 'wrangler.jsonc'), 'utf8'),
    );
    const server = createTestHarness({
      root: directory,
      workers: [
        {
          config: {
            ...config,
            main: resolve(appDirectory, 'tests/runtime-worker.ts'),
            r2_buckets: config.r2_buckets.map((binding) => ({
              ...binding,
              remote: false,
            })),
            observability: { enabled: false },
          },
        },
      ],
    });
    t.after(() => server.close());
    await server.listen();
    const worker = server.getWorker();
    let env = await worker.getEnv();
    const endpoint = 'https://link.tailmouse.com/api/v1/short-invitations';
    const invitation = `https://link.tailmouse.com/#/v1/${Buffer.from(
      encode({
        a: 2,
        e: 0,
        m: 'leash',
        p: 44321,
        s: new Uint8Array(16).fill(0x53),
        t: 'SYNTHETIC_TAILCAT_ADDRESS_FOR_LOCAL_RUNTIME_ONLY',
        v: 1,
        z: 2,
      }),
    ).toString('base64url')}`;
    const send = (path = '', method = 'GET', body, token) =>
      worker.fetch(`${endpoint}${path}`, {
        method,
        headers: {
          'cf-connecting-ip': '192.0.2.1',
          ...(body ? { 'content-type': 'application/json' } : {}),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    const publish = async () => {
      const created = await send('', 'POST', { invitation, access: 'code' });
      assert.equal(created.status, 201);
      assert.equal(created.headers.get('cache-control'), 'no-store');
      const body = await created.json();
      assert.match(body.code, /^[0-9A-Za-z]{6}$/u);
      assert.match(body.managementToken, /^[A-Za-z0-9_-]{43}$/u);
      assert.ok(body.expiresAt > Date.now() + 14 * 60_000);
      assert.ok(body.expiresAt <= Date.now() + 15 * 60_000);
      return body;
    };
    const first = await publish();
    const stub = env.SHORT_INVITATIONS.getByName(first.code);
    const state = JSON.parse(await stub.inspectForTest());
    assert.deepEqual(state.keys, ['mapping']);
    assert.deepEqual(Object.keys(state.mapping).sort(), [
      'expiresAt',
      'invitation',
      'verifier',
    ]);
    assert.equal(state.mapping.invitation, invitation);
    assert.notEqual(state.mapping.verifier, first.managementToken);
    assert.equal(state.alarm, state.mapping.expiresAt);
    const resolved = await send(`/${first.code}`);
    assert.equal(resolved.status, 200);
    assert.equal(resolved.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await resolved.json(), {
      invitation,
      expiresAt: first.expiresAt,
    });
    const unauthorized = await send(
      `/${first.code}`,
      'DELETE',
      undefined,
      Buffer.alloc(32, 2).toString('base64url'),
    );
    assert.equal(unauthorized.status, 404);
    assert.deepEqual(await unauthorized.json(), {
      error: 'invitation_unavailable',
    });
    const renewal = await send(
      `/${first.code}`,
      'PUT',
      undefined,
      first.managementToken,
    );
    assert.equal(renewal.status, 200);
    const renewed = await renewal.json();
    assert.ok(renewed.expiresAt >= first.expiresAt);
    await stub.earlyAlarmForTest();
    const early = JSON.parse(await stub.inspectForTest());
    assert.equal(early.alarm, renewed.expiresAt);
    assert.equal(early.mapping.expiresAt, renewed.expiresAt);
    await server.update((current) => ({
      ...current,
      workers: current.workers.map((definition) => ({
        config: {
          ...definition.config,
          vars: { SYNTHETIC_RUNTIME_RELOAD: '1' },
        },
      })),
    }));
    env = await worker.getEnv();
    assert.equal((await send(`/${first.code}`)).status, 200);
    const deleted = await send(
      `/${first.code}`,
      'DELETE',
      undefined,
      first.managementToken,
    );
    assert.equal(deleted.status, 204);
    assert.deepEqual(
      JSON.parse(
        await env.SHORT_INVITATIONS.getByName(first.code).inspectForTest(),
      ),
      { keys: [], alarm: null },
    );
    assert.equal((await send(`/${first.code}`)).status, 404);

    const expired = await publish();
    const expiredStub = env.SHORT_INVITATIONS.getByName(expired.code);
    await expiredStub.expireForTest(false);
    assert.equal((await send(`/${expired.code}`)).status, 404);
    assert.deepEqual(JSON.parse(await expiredStub.inspectForTest()), {
      keys: [],
      alarm: null,
    });

    const abandoned = await publish();
    const abandonedStub = env.SHORT_INVITATIONS.getByName(abandoned.code);
    await abandonedStub.expireForTest(true);
    const deadline = Date.now() + 5_000;
    while (JSON.parse(await abandonedStub.inspectForTest()).keys.length !== 0) {
      assert.ok(
        Date.now() < deadline,
        'Local storage alarm did not delete the expired mapping.',
      );
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
    }
    assert.equal((await send(`/${abandoned.code}`)).status, 404);

    const failedCleanup = await publish();
    const failedCleanupStub = env.SHORT_INVITATIONS.getByName(
      failedCleanup.code,
    );
    await failedCleanupStub.expireForTest(false);
    const failedAt = Date.now();
    assert.equal(
      await failedCleanupStub.failedCleanupForTest(),
      'cleanup_unavailable',
    );
    const backstop = JSON.parse(await failedCleanupStub.inspectForTest());
    assert.deepEqual(backstop.keys, ['mapping']);
    assert.ok(backstop.alarm >= failedAt + 5 * 60_000);
    assert.ok(backstop.alarm <= Date.now() + 5 * 60_000);
    await failedCleanupStub.earlyAlarmForTest();
    assert.deepEqual(JSON.parse(await failedCleanupStub.inspectForTest()), {
      keys: [],
      alarm: null,
    });
    assert.equal((await send(`/${failedCleanup.code}`)).status, 404);
    const lifecycleEvidence = await verifyLifecycle(
      { production: true },
      {
        fetch: (url, init) => {
          const headers = new Headers(init.headers);
          headers.set('cf-connecting-ip', '192.0.2.2');
          return worker.fetch(url, { ...init, headers });
        },
        now: Date.now,
        wait: (ms) =>
          new Promise((resolveDelay) => setTimeout(resolveDelay, ms)),
      },
    );
    assert.equal(lifecycleEvidence.status, 'verified');
    assert.equal(lifecycleEvidence.createdMappings, 1);
    assert.equal(lifecycleEvidence.requestCount, 8);
    assert.equal(lifecycleEvidence.cleanup, 'verified');
    const retainedLogs = JSON.stringify(server.getLogs());
    for (const material of [
      invitation,
      first.managementToken,
      state.mapping.verifier,
      'SYNTHETIC_PRIVATE_STORAGE_FAILURE',
    ])
      assert.equal(retainedLogs.includes(material), false);
  },
);
