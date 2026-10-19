import configuration from './tailmouse-config.test.json' with { type: 'json' };

interface Assets {
  fetch(request: Request): Promise<Response>;
}
const baseHeaders = {
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'Permissions-Policy':
    'camera=(), microphone=(), geolocation=(), payment=(), usb=(), document-domain=(), accelerometer=(self), gyroscope=(self), magnetometer=()',
  'Origin-Agent-Cluster': '?1',
};
function representation(
  header: string | null,
): 'br' | 'gzip' | 'identity' | undefined {
  const quality = new Map<string, number>();
  for (const item of (header ?? '').split(',')) {
    const [name, ...parameters] = item.trim().toLowerCase().split(';');
    if (!name) continue;
    let q = 1;
    for (const parameter of parameters) {
      const value = /^\s*q=(0(?:\.\d{0,3})?|1(?:\.0{0,3})?)\s*$/u.exec(
        parameter,
      )?.[1];
      q = value === undefined ? 0 : Number(value);
    }
    quality.set(name, q);
  }
  const br = quality.get('br') ?? quality.get('*') ?? 0;
  const gzip = quality.get('gzip') ?? quality.get('*') ?? 0;
  if (br > 0 && br >= gzip) return 'br';
  if (gzip > 0) return 'gzip';
  if ((quality.get('identity') ?? (quality.get('*') === 0 ? 0 : 1)) > 0)
    return 'identity';
  return undefined;
}

// Static release assets only. Authorized application traffic uses Tailcat.
export default {
  async fetch(request: Request, env: { ASSETS: Assets }): Promise<Response> {
    const url = new URL(request.url);
    if (!['GET', 'HEAD'].includes(request.method))
      return new Response(null, {
        status: 405,
        headers: {
          ...baseHeaders,
          Allow: 'GET, HEAD',
          'Cache-Control': 'no-store',
        },
      });
    if (url.pathname === '/tailmouse-config.json')
      return new Response(
        request.method === 'HEAD' ? null : JSON.stringify(configuration),
        {
          headers: {
            ...baseHeaders,
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
          },
        },
      );
    const bridge =
      /^\/\.tailmouse\/p\/[a-f0-9]{32}\/bridge\.html$/u.test(url.pathname) ||
      url.pathname === '/.tailmouse/bridge.html';
    if (bridge) url.pathname = '/.tailmouse/bridge.html';
    else if (url.pathname === '/' || url.pathname === '/.tailmouse/workspace/')
      url.pathname = '/index.html';
    url.search = '';
    const wasm = /^\/tailcat\/[\w.-]+\.wasm$/u.test(url.pathname);
    const encoded = /^\/tailcat\/[\w.-]+\.wasm\.(br|gz)$/u.exec(
      url.pathname,
    )?.[1];
    let encoding: 'br' | 'gzip' | 'identity' | undefined;
    if (wasm) {
      // Cloudflare normalizes the header; cf preserves the client's real offer.
      const cf = (
        request as Request & { cf?: { clientAcceptEncoding?: unknown } }
      ).cf;
      encoding = representation(
        typeof cf?.clientAcceptEncoding === 'string'
          ? cf.clientAcceptEncoding
          : request.headers.get('Accept-Encoding'),
      );
      if (encoding === undefined)
        return new Response(null, {
          status: 406,
          headers: {
            ...baseHeaders,
            Vary: 'Accept-Encoding',
            'Cache-Control': 'no-store',
          },
        });
      url.pathname += encoding === 'br' ? '.br' : '.gz';
    }
    const incoming = new Headers(request.headers);
    if (wasm) incoming.delete('Range');
    const asset = await env.ASSETS.fetch(
      new Request(url, { method: request.method, headers: incoming }),
    );
    const headers = new Headers(asset.headers);
    for (const [key, value] of Object.entries(baseHeaders))
      headers.set(key, value);
    headers.set(
      'Cache-Control',
      asset.ok && /^\/(assets|tailcat)\//u.test(url.pathname)
        ? 'public, max-age=31536000, immutable'
        : 'no-store',
    );
    const compressed = /^\/(?:assets|tailcat)\/[\w.-]+\.(br|gz)$/u.exec(
      url.pathname,
    )?.[1];
    const rawPath =
      compressed === undefined ? url.pathname : url.pathname.slice(0, -3);
    if (rawPath.endsWith('.js'))
      headers.set('Content-Type', 'text/javascript; charset=utf-8');
    if (rawPath.endsWith('.css'))
      headers.set('Content-Type', 'text/css; charset=utf-8');
    if (rawPath === '/LICENSE' || rawPath === '/NOTICE')
      headers.set('Content-Type', 'text/plain; charset=utf-8');
    if (compressed !== undefined && asset.ok)
      headers.set('Content-Encoding', compressed === 'br' ? 'br' : 'gzip');
    if (url.pathname === '/.tailmouse/sw.js')
      headers.set('Service-Worker-Allowed', '/.tailmouse/p/');
    if (url.pathname === '/index.html')
      headers.set(
        'Content-Security-Policy',
        "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'self' https: wss:; frame-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
      );
    if (bridge)
      headers.set(
        'Content-Security-Policy',
        "default-src 'none'; script-src 'self'; style-src 'self'; frame-src 'self'; connect-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'",
      );
    let body = request.method === 'HEAD' ? null : asset.body;
    if ((wasm || encoded !== undefined) && asset.ok) {
      headers.set('Content-Type', 'application/wasm');
      if (wasm) headers.set('Vary', 'Accept-Encoding');
      if (encoding === 'identity') {
        headers.delete('Content-Encoding');
        headers.delete('Content-Length');
        if (body !== null)
          body = body.pipeThrough(new DecompressionStream('gzip'));
      } else
        headers.set(
          'Content-Encoding',
          encoding ?? (encoded === 'br' ? 'br' : 'gzip'),
        );
    }
    // These bytes are already compressed. Workers must not encode them again.
    const init: ResponseInit & { encodeBody: 'manual' } = {
      status: asset.status,
      headers,
      encodeBody: 'manual',
    };
    return new Response(body, init);
  },
};
