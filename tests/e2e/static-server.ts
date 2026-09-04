import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { securityHeaders } from '../../tools/web-assets.ts';

// An isolated read-only origin permits actual outages and worker updates
// without modifying the build or another parallel browser's static server.
export async function staticServer() {
  const root = new URL('../../apps/web/dist/', import.meta.url);
  const manifest = JSON.parse(
    readFileSync(new URL('web-manifest.json', root), 'utf8'),
  ) as { cacheVersion: string; files: Record<string, unknown> };
  const files = new Set([
    ...Object.keys(manifest.files),
    'index.html',
    'web-manifest.json',
    'manifest.webmanifest',
  ]);
  const types: Record<string, string> = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.wasm': 'application/wasm',
    '.json': 'application/json',
    '.webmanifest': 'application/manifest+json',
  };
  let cacheVersion = manifest.cacheVersion;
  let corruptWasm = false;
  let closed = false;
  const requests: string[] = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    requests.push(url.pathname + url.search);
    const headers = { ...securityHeaders, 'Cache-Control': 'no-cache' };
    if (request.method !== 'GET' || !files.has(file)) {
      response
        .writeHead(404, {
          ...headers,
          'Content-Type': 'text/html; charset=utf-8',
        })
        .end('<!doctype html><title>Not found</title><p>Not found</p>');
      return;
    }
    let body = readFileSync(new URL(file, root));
    if (file.endsWith('.wasm')) {
      headers['Cache-Control'] = 'public, max-age=31536000, immutable';
      if (corruptWasm) body = Buffer.from('corrupted synthetic Wasm');
    }
    if (file === 'service-worker.js')
      body = Buffer.from(
        body.toString().replace(manifest.cacheVersion, cacheVersion),
      );
    response.writeHead(200, {
      ...headers,
      'Content-Type': types[extname(file)] ?? 'application/octet-stream',
    });
    response.end(body);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('Static test origin has no TCP port.');
  return {
    url: `http://127.0.0.1:${address.port}/`,
    requests,
    corruptWasm: (enabled: boolean) => {
      corruptWasm = enabled;
    },
    update: () => {
      cacheVersion = `${manifest.cacheVersion}-next`;
    },
    close: async () => {
      if (closed) return;
      closed = true;
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
