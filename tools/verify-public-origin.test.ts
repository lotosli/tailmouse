import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { staticServer } from '../tests/e2e/static-server.ts';
import { verifyPublicOrigin } from './verify-public-origin.mjs';

test('public-origin verifier proves the built local static fixture without an invitation', async (t) => {
  const server = await staticServer();
  t.after(server.close);
  const result = await verifyPublicOrigin(
    server.url,
    'apps/web/dist/web-manifest.json',
    { timeoutMs: 5_000 },
  );
  assert.equal(result.origin, new URL(server.url).origin);
  assert.equal(result.tls.status, 'not-applicable');
  assert.equal(result.routing.applicationBackend, false);
  assert.equal(result.routing.unknownPathStatus, 404);
  const manifest = JSON.parse(
    readFileSync('apps/web/dist/web-manifest.json', 'utf8'),
  ) as { files: Record<string, { bytes: number }> };
  const wasm = Object.entries(manifest.files).find(([name]) =>
    name.endsWith('.wasm'),
  );
  assert.ok(wasm);
  assert.equal(result.transfer.coldWasm.bytes, wasm[1].bytes);
  assert.equal(result.transfer.warmWasm.bytes, wasm[1].bytes);
  assert.ok(result.transfer.coldWasm.durationMs >= 0);
  assert.ok(result.transfer.warmWasm.durationMs >= 0);
  assert.ok(server.requests.every((request) => !request.includes('#')));
  assert.ok(
    server.requests.includes('/api/.tailmouse-origin-verifier-no-backend'),
  );
});

test('public-origin verifier rejects credentials, query strings and fragments before a request', async (t) => {
  const server = await staticServer();
  t.after(server.close);
  const base = new URL(server.url);
  for (const unsafe of [
    `http://user:password@${base.host}/`,
    `${server.url}?invitation-material`,
    `${server.url}#invitation-material`,
  ])
    await assert.rejects(
      verifyPublicOrigin(unsafe, 'apps/web/dist/web-manifest.json', {
        timeoutMs: 5_000,
      }),
      /credentials|query strings|fragments/u,
    );
  assert.deepEqual(server.requests, []);
});
