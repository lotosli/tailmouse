import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { test } from 'node:test';
import { staticServer } from '../tests/e2e/static-server.ts';
import { securityHeaders } from './web-assets.ts';
import {
  publicOriginArguments,
  publicOriginFailureMessage,
  verifyPublicOrigin,
} from './verify-public-origin.mjs';

await test('public-origin CLI accepts the documented pnpm argument separator', () => {
  const expected = [
    'https://link.tailmouse.com/',
    'apps/web/dist/web-manifest.json',
  ];
  assert.deepEqual(publicOriginArguments(expected), expected);
  assert.deepEqual(publicOriginArguments(['--', ...expected]), expected);
  assert.deepEqual(
    publicOriginArguments(['--', ...expected, '--short-invitations']),
    [...expected, '--short-invitations'],
  );
  assert.throws(
    () => publicOriginArguments(['--', ...expected, 'unexpected']),
    /Expected an origin URL and local Web manifest path/u,
  );
  assert.throws(
    () => publicOriginArguments([...expected, '--short-invitations', 'extra']),
    /Expected an origin URL and local Web manifest path/u,
  );
});

async function shortOrigin() {
  const upstream = await staticServer();
  const index = readFileSync('apps/web/dist/index.html');
  let fault = '';
  const requests: string[] = [];
  const server = createServer((request, response) => {
    const path = request.url ?? '/';
    requests.push(`${request.method} ${path}`);
    const short = path === '/T6wxZ8';
    const unavailable =
      path ===
      '/api/v1/short-invitations/.tailmouse-origin-verifier-unavailable';
    if (short || unavailable) {
      const body = short
        ? fault === 'short-body'
          ? Buffer.alloc(index.byteLength, 0x21)
          : index
        : Buffer.from(
            fault === 'api-body'
              ? '{"error":"synthetic-diagnostic-not-generic"}'
              : '{"error":"invitation_unavailable"}',
          );
      const headers: Record<string, string> = {
        ...securityHeaders,
        'Content-Type': short ? 'text/html; charset=utf-8' : 'application/json',
        'Content-Length': String(body.byteLength),
        'Cache-Control':
          (short && fault === 'short-cache') ||
          (short && request.method === 'HEAD' && fault === 'head-cache') ||
          (unavailable && fault === 'api-cache')
            ? 'no-cache'
            : 'no-store',
      };
      if (short && fault === 'short-security')
        delete headers['Referrer-Policy'];
      response
        .writeHead(short ? 200 : 404, headers)
        .end(request.method === 'HEAD' ? undefined : body);
      return;
    }
    const proxy = httpRequest(
      new URL(path, upstream.url),
      { method: request.method, headers: request.headers },
      (source) => {
        response.writeHead(source.statusCode ?? 502, source.headers);
        source.pipe(response);
        source.on('error', () => response.destroy());
      },
    );
    proxy.on('error', () => response.destroy());
    proxy.end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return {
    url: `http://127.0.0.1:${address.port}/`,
    requests,
    fault: (value: string) => {
      fault = value;
    },
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
      await upstream.close();
    },
  };
}

await test('optional short-origin verification is read-only and reports its exact scope', async (t) => {
  const server = await shortOrigin();
  t.after(server.close);
  const result = await verifyPublicOrigin(
    server.url,
    'apps/web/dist/web-manifest.json',
    { timeoutMs: 5_000, shortInvitations: true },
  );
  assert.equal(result.routing.staticClientBackendRequired, false);
  assert.equal('applicationBackend' in result.routing, false);
  assert.deepEqual(result.routing.shortInvitations, {
    status: 'verified',
    entryPath: '/T6wxZ8',
    unavailableStatus: 404,
    cacheControl: 'no-store',
    lifecycle: 'not-tested',
  });
  assert.ok(server.requests.includes('GET /T6wxZ8'));
  assert.ok(server.requests.includes('HEAD /T6wxZ8'));
  assert.ok(
    server.requests.every((request) => /^(?:GET|HEAD) /u.test(request)),
  );
  assert.ok(
    server.requests.every(
      (request) => !/short-invitations\/[0-9A-Za-z]{6}$/u.test(request),
    ),
  );
});

await test('short-origin verification fails fast on wrong bytes, headers, or diagnostic responses', async (t) => {
  const server = await shortOrigin();
  t.after(server.close);
  for (const [fault, expected] of [
    ['short-body', /Content hash mismatch/u],
    ['short-cache', /Static object cache policy mismatch/u],
    ['head-cache', /Short entry HEAD cache policy mismatch/u],
    ['short-security', /Referrer-Policy mismatch/u],
    ['api-cache', /Unavailable invitation cache policy mismatch/u],
    ['api-body', /Unavailable invitation response was not generic/u],
  ] as const) {
    server.fault(fault);
    await assert.rejects(
      verifyPublicOrigin(server.url, 'apps/web/dist/web-manifest.json', {
        timeoutMs: 5_000,
        shortInvitations: true,
      }),
      expected,
    );
  }
  assert.ok(!server.requests.some((request) => request.includes('.wasm')));
});

await test('public-origin CLI reports only a bounded safe failure category', () => {
  const error = Object.assign(
    new Error('upstream included synthetic-secret-DO-NOT-PRINT'),
    { code: 'ECONNRESET' },
  );
  const message = publicOriginFailureMessage(error);
  assert.equal(message, 'Origin verification failed (ECONNRESET).');
  assert.doesNotMatch(message, /synthetic-secret|DO-NOT-PRINT/u);
  assert.equal(
    publicOriginFailureMessage(new Error('synthetic-secret-DO-NOT-PRINT')),
    'Origin verification failed (UNCLASSIFIED).',
  );
});

await test('public-origin verifier proves the built local static fixture without an invitation', async (t) => {
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
  assert.ok(!server.requests.includes('/T6wxZ8'));
});

await test('public-origin verifier accepts omitted Content-Length while still checking exact bodies', async (t) => {
  const server = await staticServer({
    omitContentLength: true,
    requireMatchingContentEncoding: true,
  });
  t.after(server.close);
  const result = await verifyPublicOrigin(
    server.url,
    'apps/web/dist/web-manifest.json',
    { timeoutMs: 5_000 },
  );
  assert.equal(result.routing.root.action, 'internal-rewrite');
  assert.ok(result.transfer.coldWasm.bytes > 0);
});

await test('public-origin verifier rejects credentials, query strings and fragments before a request', async (t) => {
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
  await assert.rejects(
    verifyPublicOrigin(server.url, 'apps/web/dist/web-manifest.json', {
      shortInvitations: 'true',
    }),
    /Invalid short-invitation verification option/u,
  );
  assert.deepEqual(server.requests, []);
});
