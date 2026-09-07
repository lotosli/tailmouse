import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { securityHeaders } from '../../tools/web-assets.ts';

// An isolated read-only origin permits actual outages and worker updates
// without modifying the build or another parallel browser's static server.
export async function staticServer(
  options: {
    omitContentLength?: boolean;
    requireMatchingContentEncoding?: boolean;
  } = {},
) {
  const root = new URL('../../apps/web/dist/', import.meta.url);
  const manifest = JSON.parse(
    readFileSync(new URL('web-manifest.json', root), 'utf8'),
  ) as {
    cacheVersion: string;
    staticHosting: {
      manifestObject: { metadata: StaticMetadata };
    };
    files: Record<string, StaticMetadata>;
  };
  const files = new Set([...Object.keys(manifest.files), 'web-manifest.json']);
  let cacheVersion = manifest.cacheVersion;
  let corruptWasm = false;
  let closed = false;
  const requests: string[] = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    requests.push(url.pathname + url.search);
    const headers: Record<string, string> = {
      ...securityHeaders,
      'Cache-Control': 'no-cache',
    };
    if (!['GET', 'HEAD'].includes(request.method ?? '') || !files.has(file)) {
      const body = Buffer.from(
        '<!doctype html><title>Not found</title><p>Not found</p>',
      );
      response
        .writeHead(404, {
          ...headers,
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Length': String(body.byteLength),
        })
        .end(request.method === 'HEAD' ? undefined : body);
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
    const metadata =
      file === 'web-manifest.json'
        ? manifest.staticHosting.manifestObject.metadata
        : manifest.files[file]!;
    if (
      options.requireMatchingContentEncoding &&
      metadata.contentEncoding &&
      request.headers['accept-encoding'] !== metadata.contentEncoding
    ) {
      response
        .writeHead(406, {
          ...headers,
          'Content-Type': 'text/plain; charset=utf-8',
          'Content-Length': '0',
        })
        .end();
      return;
    }
    headers['Cache-Control'] = metadata.cacheControl;
    if (metadata.contentEncoding)
      headers['Content-Encoding'] = metadata.contentEncoding;
    response.writeHead(200, {
      ...headers,
      'Content-Type': metadata.contentType,
      ...(options.omitContentLength
        ? { 'Transfer-Encoding': 'chunked' }
        : { 'Content-Length': String(body.byteLength) }),
    });
    if (request.method !== 'HEAD' && options.omitContentLength)
      response.write(body);
    response.end(
      request.method === 'HEAD' || options.omitContentLength ? undefined : body,
    );
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

type StaticMetadata = {
  contentType: string;
  cacheControl: string;
  contentEncoding?: 'br' | 'gzip';
};
