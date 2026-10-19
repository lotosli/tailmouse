import configuration from './tailmouse-config.test.json' with { type: 'json' };

interface Assets {
  fetch(request: Request): Promise<Response>;
}
const baseHeaders = {
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'Permissions-Policy':
    'camera=(), microphone=(), geolocation=(), payment=(), usb=(), document-domain=()',
  'Origin-Agent-Cluster': '?1',
};
// This Worker only serves release assets. Business HTTP always travels through
// the authenticated browser/native resource stream, never through Cloudflare.
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
    const bridge = /^\/\.tailmouse\/p\/[a-f0-9]{32}\/bridge\.html$/u.test(
      url.pathname,
    );
    if (bridge) url.pathname = '/.tailmouse/bridge.html';
    else if (url.pathname === '/' || url.pathname === '/.tailmouse/workspace/')
      url.pathname = '/index.html';
    // All remaining paths resolve only to bundled static files or a 404.
    url.search = '';
    let encoding: 'br' | 'gzip' | undefined;
    let decompress = false;
    const wasm = /^\/tailcat\/[\w.-]+\.wasm$/u.test(url.pathname);
    if (wasm) {
      const accepted = request.headers.get('Accept-Encoding') ?? '';
      if (/\bbr\b/u.test(accepted)) {
        url.pathname += '.br';
        encoding = 'br';
      } else {
        url.pathname += '.gz';
        encoding = 'gzip';
        decompress = !/\bgzip\b/u.test(accepted);
      }
    }
    const asset = await env.ASSETS.fetch(
      new Request(url, { method: request.method, headers: request.headers }),
    );
    const headers = new Headers(asset.headers);
    for (const [key, value] of Object.entries(baseHeaders))
      headers.set(key, value);
    headers.set(
      'Cache-Control',
      /^\/(assets|tailcat)\//u.test(url.pathname)
        ? 'public, max-age=31536000, immutable'
        : 'no-store',
    );
    if (url.pathname.endsWith('.js'))
      headers.set('Content-Type', 'text/javascript; charset=utf-8');
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
        "default-src 'self'; script-src 'self'; style-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'",
      );
    let body = asset.body;
    if (wasm && asset.ok) {
      headers.set('Content-Type', 'application/wasm');
      headers.set('Vary', 'Accept-Encoding');
      if (decompress) {
        headers.delete('Content-Encoding');
        headers.delete('Content-Length');
        if (body !== null)
          body = body.pipeThrough(new DecompressionStream('gzip'));
      } else if (encoding !== undefined)
        headers.set('Content-Encoding', encoding);
    }
    return new Response(body, { status: asset.status, headers });
  },
};
