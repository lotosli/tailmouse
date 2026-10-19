import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import worker from './worker.ts';

const origin = 'https://tailmouse.com';
await test('static Worker binds workspace routes and keeps business traffic out of the edge', async () => {
  const requests: Request[] = [];
  const env = {
    ASSETS: {
      async fetch(request: Request) {
        requests.push(request);
        return new Response('asset', {
          headers: { 'Content-Type': 'application/octet-stream' },
        });
      },
    },
  };
  for (const path of ['/', '/.tailmouse/workspace/']) {
    const response = await worker.fetch(
      new Request(origin + path + '?private=discarded'),
      env,
    );
    assert.equal(new URL(requests.at(-1)!.url).pathname, '/index.html');
    assert.equal(new URL(requests.at(-1)!.url).search, '');
    assert.match(
      response.headers.get('Content-Security-Policy')!,
      /frame-ancestors 'none'/u,
    );
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
  }
  for (const path of [
    '/.tailmouse/bridge.html',
    `/.tailmouse/p/${'a'.repeat(32)}/bridge.html`,
  ]) {
    const response = await worker.fetch(new Request(origin + path), env);
    assert.equal(
      new URL(requests.at(-1)!.url).pathname,
      '/.tailmouse/bridge.html',
    );
    assert.match(
      response.headers.get('Content-Security-Policy')!,
      /frame-ancestors 'self'/u,
    );
  }
  const sw = await worker.fetch(new Request(origin + '/.tailmouse/sw.js'), env);
  assert.equal(sw.headers.get('Service-Worker-Allowed'), '/.tailmouse/p/');
  assert.match(sw.headers.get('Content-Type')!, /javascript/u);
  const count = requests.length;
  const config = await worker.fetch(
    new Request(origin + '/tailmouse-config.json'),
    env,
  );
  assert.deepEqual(await config.json(), {
    version: 1,
    frontendBase: origin,
    contentBase: origin,
    testSingleOrigin: true,
    releaseManifest: '/web-manifest.json',
  });
  for (const method of ['POST', 'PUT', 'DELETE', 'CONNECT']) {
    // Fetch forbids CONNECT before the Worker boundary; use a request-shaped input.
    const request =
      method === 'CONNECT'
        ? ({ url: origin + '/api', method, headers: new Headers() } as Request)
        : new Request(origin + '/api', { method });
    assert.equal((await worker.fetch(request, env)).status, 405);
  }
  const head = await worker.fetch(
    new Request(origin + '/tailmouse-config.json', { method: 'HEAD' }),
    env,
  );
  assert.equal(head.body, null);
  assert.equal(requests.length, count);
  const missing = await worker.fetch(new Request(origin + '/private-api'), {
    ASSETS: {
      async fetch() {
        return new Response('absent', { status: 404 });
      },
    },
  });
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get('Cache-Control'), 'no-store');
});
await test('Wasm negotiation respects refusal, quality, raw decoding and HEAD', async () => {
  const raw = Buffer.from('synthetic Wasm bytes');
  const seen: Request[] = [];
  const env = {
    ASSETS: {
      async fetch(request: Request) {
        seen.push(request);
        return new Response(gzipSync(raw), {
          headers: { 'Content-Length': '42' },
        });
      },
    },
  };
  for (const [accepted, extension, encoding] of [
    ['br, gzip', '.br', 'br'],
    ['br;q=0, gzip', '.gz', 'gzip'],
    ['br;q=0.2,gzip;q=0.8', '.gz', 'gzip'],
    ['*;q=0.5', '.br', 'br'],
    ['br;q=invalid, identity', '.gz', null],
    ['identity', '.gz', null],
    ['', '.gz', null],
  ] as const) {
    const response = await worker.fetch(
      new Request(origin + '/tailcat/resource-hash.wasm', {
        headers: { 'Accept-Encoding': accepted, Range: 'bytes=0-2' },
      }),
      env,
    );
    assert.ok(new URL(seen.at(-1)!.url).pathname.endsWith(extension));
    assert.equal(seen.at(-1)!.headers.get('Range'), null);
    assert.equal(response.headers.get('Content-Encoding'), encoding);
    assert.equal(response.headers.get('Vary'), 'Accept-Encoding');
    assert.equal(response.headers.get('Content-Type'), 'application/wasm');
    assert.match(response.headers.get('Cache-Control')!, /immutable/u);
    if (encoding === null) {
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), raw);
      assert.equal(response.headers.get('Content-Length'), null);
    }
  }
  const before = seen.length;
  const normalized = new Request(origin + '/tailcat/resource-hash.wasm', {
    headers: { 'Accept-Encoding': 'br, gzip' },
  });
  Object.defineProperty(normalized, 'cf', {
    value: { clientAcceptEncoding: 'identity' },
  });
  const originalOffer = await worker.fetch(normalized, env);
  assert.equal(originalOffer.headers.get('Content-Encoding'), null);
  assert.deepEqual(Buffer.from(await originalOffer.arrayBuffer()), raw);
  assert.equal(
    (
      await worker.fetch(
        new Request(origin + '/tailcat/resource-hash.wasm', {
          headers: { 'Accept-Encoding': '*;q=0,identity;q=0' },
        }),
        env,
      )
    ).status,
    406,
  );
  assert.equal(seen.length, before + 1);
  for (const suffix of ['.br', '.gz']) {
    const response = await worker.fetch(
      new Request(origin + '/tailcat/resource-hash.wasm' + suffix),
      env,
    );
    assert.equal(
      response.headers.get('Content-Encoding'),
      suffix === '.br' ? 'br' : 'gzip',
    );
  }
  const head = await worker.fetch(
    new Request(origin + '/tailcat/resource-hash.wasm', { method: 'HEAD' }),
    env,
  );
  assert.equal(head.body, null);
  const missing = await worker.fetch(
    new Request(origin + '/tailcat/missing.wasm'),
    {
      ASSETS: {
        async fetch() {
          return new Response(null, { status: 404 });
        },
      },
    },
  );
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get('Content-Encoding'), null);
});

await test('static objects retain their manifest MIME and encoding despite provider defaults', async () => {
  for (const [path, type, encoding] of [
    ['/assets/app-12345678.js.br', 'text/javascript; charset=utf-8', 'br'],
    ['/assets/app-12345678.css.gz', 'text/css; charset=utf-8', 'gzip'],
    ['/LICENSE', 'text/plain; charset=utf-8', null],
    ['/NOTICE', 'text/plain; charset=utf-8', null],
    ['/THIRD_PARTY_NOTICES.txt', 'text/plain; charset=utf-8', null],
    ['/index.html', 'text/html; charset=utf-8', null],
    ['/.tailmouse/bridge.html', 'text/html; charset=utf-8', null],
  ]) {
    const response = await worker.fetch(new Request(origin + path), {
      ASSETS: {
        async fetch() {
          return new Response('static fixture', {
            headers: { 'Content-Type': type!.split(';')[0]! },
          });
        },
      },
    });
    assert.equal(response.headers.get('Content-Type'), type);
    assert.equal(response.headers.get('Content-Encoding'), encoding);
  }
});
