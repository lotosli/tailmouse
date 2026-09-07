import { describe, expect, it, vi } from 'vitest';
import { isStaticLocator, serveStatic } from './static.ts';

const fixture = vi.hoisted(() => {
  const sources: Record<string, string> = {
    'index.html': '<main>TailMouse</main>',
    NOTICE: 'Synthetic project notice.',
    'service-worker.js': '// synthetic worker',
    'assets/app-12345678.js': '0123456789',
    'assets/app-12345678.js.br': 'brotli bytes',
    'assets/app-12345678.js.gz': 'gzip bytes',
    'web-manifest.json': '{}',
    'assets/empty-12345678.js': '',
  };
  const files = Object.fromEntries(
    Object.entries(sources).map(([path, bytes], index) => [
      path,
      {
        bytes: new TextEncoder().encode(bytes).length,
        sha256: String(index + 1).repeat(64),
        contentType: path.endsWith('.html')
          ? 'text/html; charset=utf-8'
          : 'text/javascript; charset=utf-8',
        cacheControl: path.startsWith('assets/')
          ? `public, max-age=31536000, immutable${/\.(br|gz)$/u.test(path) ? ', no-transform' : ''}`
          : 'no-cache',
        ...(path.endsWith('.br') ? { contentEncoding: 'br' } : {}),
        ...(path.endsWith('.gz') ? { contentEncoding: 'gzip' } : {}),
      },
    ]),
  );
  return {
    sources,
    manifest: {
      files,
      requiredHeaders: {
        'Content-Security-Policy': "default-src 'self'; frame-ancestors 'none'",
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
      },
    },
  };
});

vi.mock('../.artifacts/static-manifest.json', () => ({
  default: fixture.manifest,
}));

function bucket(
  options: {
    missing?: boolean;
    wrongSize?: boolean;
    wrongMetadata?: boolean;
    wrongChecksum?: boolean;
    fail?: boolean;
  } = {},
) {
  const cancel = vi.fn();
  const read = (
    key: string,
    range?: { offset: number; length: number },
    head = false,
  ) => {
    if (options.fail) throw new Error('SYNTHETIC_PRIVATE_STORAGE_FAILURE');
    if (options.missing) return null;
    const metadata = fixture.manifest.files[key]!;
    const source = new TextEncoder().encode(fixture.sources[key]!);
    return {
      size: options.wrongSize ? source.length + 1 : source.length,
      httpMetadata: {
        contentType: options.wrongMetadata
          ? 'text/plain'
          : metadata.contentType,
        cacheControl: metadata.cacheControl,
        ...(metadata.contentEncoding
          ? { contentEncoding: metadata.contentEncoding }
          : {}),
      },
      checksums: options.wrongChecksum
        ? { sha256: new Uint8Array(32).buffer }
        : {},
      ...(head
        ? {}
        : {
            body: new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(
                  range
                    ? source.slice(range.offset, range.offset + range.length)
                    : source,
                );
              },
              pull(controller) {
                controller.close();
              },
              cancel,
            }),
          }),
    };
  };
  const head = vi.fn((key: string) =>
    Promise.resolve(read(key, undefined, true)),
  );
  const get = vi.fn(
    (key: string, options?: { range?: { offset: number; length: number } }) =>
      Promise.resolve(read(key, options?.range)),
  );
  return { binding: { get, head } as unknown as R2Bucket, get, head, cancel };
}

function request(
  path: string,
  headers: Record<string, string> = {},
  method = 'GET',
) {
  return new Request(`https://link.tailmouse.com${path}`, { method, headers });
}

describe('manifest-bound R2 static serving', () => {
  it('serves the unchanged entry with security headers and does not cache short pages', async () => {
    const store = bucket();
    for (const [path, cache] of [
      ['/', 'no-cache'],
      ['/index.html', 'no-cache'],
      ['/T6wxZ8', 'no-store'],
      ['/?ignored=yes', 'no-cache'],
    ] as const) {
      const response = await serveStatic(request(path), {
        STATIC_ASSETS: store.binding,
      });
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(fixture.sources['index.html']);
      expect(response.headers.get('cache-control')).toBe(cache);
      for (const [name, value] of Object.entries(
        fixture.manifest.requiredHeaders,
      ))
        expect(response.headers.get(name)).toBe(value);
    }
    expect(store.get).toHaveBeenCalledTimes(4);
  });

  it('keeps the six-character NOTICE asset separate from allocatable locators', async () => {
    expect(isStaticLocator('NOTICE')).toBe(true);
    expect(isStaticLocator('Notice')).toBe(false);
    const store = bucket();
    const response = await serveStatic(request('/NOTICE'), {
      STATIC_ASSETS: store.binding,
    });
    expect(await response.text()).toBe(fixture.sources.NOTICE);
    expect(response.headers.get('cache-control')).toBe('no-cache');
  });

  it.each([
    '/unknown',
    '/api/unknown',
    '/T6wxZ8/',
    '/%54%36wxZ8',
    '/assets/unknown.js',
    '//index.html',
    '/.git/config',
  ])('does not turn %s into arbitrary R2 or SPA lookup', async (path) => {
    const store = bucket();
    const response = await serveStatic(request(path), {
      STATIC_ASSETS: store.binding,
    });
    expect(response.status).toBe(404);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(store.get).not.toHaveBeenCalled();
  });

  it.each([
    ['', 'assets/app-12345678.js'],
    ['identity', 'assets/app-12345678.js'],
    ['br, gzip', 'assets/app-12345678.js.br'],
    ['gzip, br;q=0', 'assets/app-12345678.js.gz'],
    ['gzip;q=0.5, br;q=0.4', 'assets/app-12345678.js'],
    ['gzip;q=0.5, br;q=0.4, identity;q=0', 'assets/app-12345678.js.gz'],
    ['*;q=1', 'assets/app-12345678.js.br'],
    ['br;q=2, gzip;q=0, identity', 'assets/app-12345678.js'],
  ])(
    'negotiates %s without expanding stored bytes',
    async (encoding, expected) => {
      const store = bucket();
      const response = await serveStatic(
        request('/assets/app-12345678.js', { 'accept-encoding': encoding }),
        { STATIC_ASSETS: store.binding },
      );
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(fixture.sources[expected]);
      expect(response.headers.get('content-length')).toBe(
        String(fixture.manifest.files[expected]!.bytes),
      );
      expect(response.headers.get('content-encoding')).toBe(
        fixture.manifest.files[expected]!.contentEncoding ?? null,
      );
      expect(response.headers.get('vary')).toBe('Accept-Encoding');
    },
  );

  it('returns direct encoded objects exactly and refuses an unacceptable raw representation', async () => {
    const store = bucket();
    const direct = await serveStatic(request('/assets/app-12345678.js.gz'), {
      STATIC_ASSETS: store.binding,
    });
    expect(await direct.text()).toBe('gzip bytes');
    expect(direct.headers.get('content-encoding')).toBe('gzip');
    expect(direct.headers.get('vary')).toBeNull();
    const denied = await serveStatic(
      request('/index.html', { 'accept-encoding': '*;q=0' }),
      { STATIC_ASSETS: store.binding },
    );
    expect(denied.status).toBe(406);
    expect(store.get).toHaveBeenCalledTimes(1);
  });

  it('honors the original encoding when Cloudflare normalizes its request header', async () => {
    const store = bucket();
    const input = request('/assets/app-12345678.js', {
      'accept-encoding': 'br, gzip',
    });
    Object.defineProperty(input, 'cf', {
      value: { clientAcceptEncoding: 'identity' },
    });
    const response = await serveStatic(input, { STATIC_ASSETS: store.binding });
    expect(response.headers.get('content-encoding')).toBeNull();
    expect(await response.text()).toBe('0123456789');
  });

  it('validates HEAD and conditional responses without reading an object body', async () => {
    const store = bucket();
    const head = await serveStatic(request('/index.html', {}, 'HEAD'), {
      STATIC_ASSETS: store.binding,
    });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
    expect(head.headers.get('content-length')).toBe(
      String(fixture.manifest.files['index.html']!.bytes),
    );
    const etag = head.headers.get('etag')!;
    for (const value of [etag, `W/${etag}`, `"other", ${etag}`, '*']) {
      const cached = await serveStatic(
        request('/index.html', { 'if-none-match': value }),
        { STATIC_ASSETS: store.binding },
      );
      expect(cached.status).toBe(304);
      expect(cached.headers.get('etag')).toBe(etag);
      expect(cached.headers.get('content-length')).toBeNull();
    }
    expect(store.get).not.toHaveBeenCalled();
    expect(store.head).toHaveBeenCalledTimes(5);
    const short = await serveStatic(
      request('/T6wxZ8', { 'if-none-match': etag }),
      { STATIC_ASSETS: store.binding },
    );
    expect(short.status).toBe(200);
    expect(await short.text()).toBe(fixture.sources['index.html']);
  });

  it.each([
    ['bytes=2-4', '234', 'bytes 2-4/10'],
    ['bytes=7-', '789', 'bytes 7-9/10'],
    ['bytes=-3', '789', 'bytes 7-9/10'],
    ['bytes=-30', '0123456789', 'bytes 0-9/10'],
    ['bytes=0-100', '0123456789', 'bytes 0-9/10'],
  ])(
    'serves a single bounded byte range %s',
    async (range, expected, contentRange) => {
      const store = bucket();
      const response = await serveStatic(
        request('/assets/app-12345678.js', { range }),
        { STATIC_ASSETS: store.binding },
      );
      expect(response.status).toBe(206);
      expect(response.headers.get('content-range')).toBe(contentRange);
      expect(response.headers.get('content-length')).toBe(
        String(expected.length),
      );
      expect(await response.text()).toBe(expected);
    },
  );

  it.each([
    'bytes=10-',
    'bytes=5-2',
    'bytes=-0',
    'bytes=-',
    'bytes=9007199254740992-',
    'bytes=0-1,3-4',
    'items=1-2',
  ])(
    'rejects invalid or unsatisfiable ranges %s before storage access',
    async (range) => {
      const store = bucket();
      const response = await serveStatic(
        request('/assets/app-12345678.js', { range }),
        { STATIC_ASSETS: store.binding },
      );
      expect(response.status).toBe(416);
      expect(response.headers.get('content-range')).toBe('bytes */10');
      expect(store.get).not.toHaveBeenCalled();
    },
  );

  it('honors strong If-Range and ignores Range on HEAD or stale If-Range', async () => {
    const store = bucket();
    const path = '/assets/app-12345678.js';
    const initial = await serveStatic(request(path, {}, 'HEAD'), {
      STATIC_ASSETS: store.binding,
    });
    const matched = await serveStatic(
      request(path, {
        range: 'bytes=0-1',
        'if-range': initial.headers.get('etag')!,
      }),
      { STATIC_ASSETS: store.binding },
    );
    expect(matched.status).toBe(206);
    expect(await matched.text()).toBe('01');
    const stale = await serveStatic(
      request(path, { range: 'bytes=0-1', 'if-range': '"stale"' }),
      { STATIC_ASSETS: store.binding },
    );
    expect(stale.status).toBe(200);
    expect(await stale.text()).toBe('0123456789');
    const head = await serveStatic(
      request(path, { range: 'bytes=0-1' }, 'HEAD'),
      { STATIC_ASSETS: store.binding },
    );
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
    const empty = await serveStatic(
      request('/assets/empty-12345678.js', { range: 'bytes=0-0' }),
      { STATIC_ASSETS: store.binding },
    );
    expect(empty.status).toBe(416);
  });

  it.each([
    'missing',
    'wrongSize',
    'wrongMetadata',
    'wrongChecksum',
    'fail',
  ] as const)('fails closed and redacts storage failure %s', async (reason) => {
    const store = bucket({ [reason]: true });
    const response = await serveStatic(request('/index.html'), {
      STATIC_ASSETS: store.binding,
    });
    expect(response.status).toBe(503);
    expect(await response.text()).toBe('Static resource unavailable.\n');
    expect(response.headers.get('cache-control')).toBe('no-store');
    if (reason.startsWith('wrong'))
      expect(store.cancel).toHaveBeenCalledTimes(1);
  });

  it('rejects writes and returns no body for an unknown HEAD request', async () => {
    const store = bucket();
    const write = await serveStatic(request('/', {}, 'POST'), {
      STATIC_ASSETS: store.binding,
    });
    expect(write.status).toBe(405);
    expect(write.headers.get('allow')).toBe('GET, HEAD');
    const absent = await serveStatic(request('/unknown', {}, 'HEAD'), {
      STATIC_ASSETS: store.binding,
    });
    expect(absent.status).toBe(404);
    expect(await absent.text()).toBe('');
    expect(store.get).not.toHaveBeenCalled();
  });
});
