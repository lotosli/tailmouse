import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';

export const securityHeaders = Object.freeze({
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'self' https: wss:; frame-src https:; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy':
    'camera=(), microphone=(), geolocation=(), payment=(), usb=(), accelerometer=(self), gyroscope=(self), magnetometer=()',
  'X-Content-Type-Options': 'nosniff',
});

export const immutableCacheControl = 'public, max-age=31536000, immutable';

export const staticHosting = Object.freeze({
  applicationBackend: false,
  manifestObject: Object.freeze({
    path: 'web-manifest.json',
    metadata: Object.freeze({
      contentType: 'application/json',
      cacheControl: 'no-cache',
    }),
  }),
  rootRoute: Object.freeze({
    requestPath: '/',
    objectPath: 'index.html',
    action: 'internal-rewrite',
    clearQuery: true,
  }),
  unknownPathStatus: 404,
  requiredHeaders: securityHeaders,
});

// Content bootstrap hosts cannot use the trusted UI's frame-ancestors 'none'.
// The deployment adds its configured trusted session wildcard as the ancestor.
export const contentHosting = Object.freeze({
  applicationBackend: false,
  allowedPrefix: '/.tailmouse/',
  unknownPathStatus: 404,
  serviceWorker: Object.freeze({
    path: '/.tailmouse/sw.js',
    scope: '/',
    requiredHeaders: Object.freeze({ 'Service-Worker-Allowed': '/' }),
  }),
  frameAncestors: 'trusted-session-wildcard-from-config',
  requiredHeaders: Object.freeze({
    'Content-Security-Policy':
      "default-src 'none'; script-src 'self'; style-src 'self'; frame-src 'self'; connect-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'none'",
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
  }),
});

export type WebObjectMetadata = {
  contentType: string;
  cacheControl: string;
  contentEncoding?: 'br' | 'gzip';
};

export function webObjectMetadata(fileName: string): WebObjectMetadata {
  const compressed = fileName.match(/\.(br|gz)$/u)?.[1];
  const rawName = compressed ? fileName.slice(0, -3) : fileName;
  const contentType = rawName.endsWith('.html')
    ? 'text/html; charset=utf-8'
    : rawName.endsWith('.js')
      ? 'text/javascript; charset=utf-8'
      : rawName.endsWith('.css')
        ? 'text/css; charset=utf-8'
        : rawName.endsWith('.wasm')
          ? 'application/wasm'
          : rawName.endsWith('.webmanifest')
            ? 'application/manifest+json'
            : rawName.endsWith('.json') || rawName.endsWith('.map')
              ? 'application/json'
              : rawName.endsWith('.txt') ||
                  ['LICENSE', 'NOTICE'].includes(rawName)
                ? 'text/plain; charset=utf-8'
                : rawName.endsWith('.svg')
                  ? 'image/svg+xml'
                  : rawName.endsWith('.png')
                    ? 'image/png'
                    : rawName.endsWith('.webp')
                      ? 'image/webp'
                      : rawName.endsWith('.woff2')
                        ? 'font/woff2'
                        : undefined;
  if (!contentType)
    throw new Error(`Unsupported static Web object type: ${fileName}`);
  const immutable =
    /^(?:assets|tailcat)\/[\w.-]+-[\w-]{8,}\.(?:js|js\.map|css|wasm|svg|png|webp|woff2)$/u.test(
      rawName,
    );
  return {
    contentType,
    cacheControl: `${rawName.startsWith('.tailmouse/') ? 'no-store' : immutable ? immutableCacheControl : 'no-cache'}${
      compressed ? ', no-transform' : ''
    }`,
    ...(compressed
      ? { contentEncoding: compressed === 'br' ? 'br' : 'gzip' }
      : {}),
  };
}

export function digest(bytes: string | Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function verifyStaticReferences(
  source: string,
  kind: 'html' | 'css',
): void {
  const local = (value: string): void => {
    // Build-owned URLs need neither HTML entities nor CSS escapes. Reject
    // ambiguous references instead of partially decoding executable URLs.
    if (
      /[&\\]/u.test(value) ||
      new URL(value, 'https://tailmouse.invalid/').origin !==
        'https://tailmouse.invalid'
    )
      throw new Error(
        'Web build contains an external or ambiguous resource URL.',
      );
  };
  if (kind === 'html') {
    if (
      /<script\b[^>]*>\s*[^<\s]/iu.test(source) ||
      /\son[a-z]+\s*=/iu.test(source)
    )
      throw new Error('Web build contains inline executable content.');
    for (const match of source.matchAll(
      /\b(?:src|href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/giu,
    ))
      local(match[1] ?? match[2] ?? match[3]!);
  } else {
    if (/@import\b/iu.test(source))
      throw new Error('Web build contains an unbundled stylesheet import.');
    for (const match of source.matchAll(
      /url\(\s*['"]?([^)'"\s]+)['"]?\s*\)/giu,
    ))
      local(match[1]!);
  }
}

export function tailcatAssets(
  directory: string,
  revision: string,
  goVersion: string,
) {
  const manifest = JSON.parse(
    readFileSync(join(directory, 'manifest.json'), 'utf8'),
  ) as {
    schemaVersion?: unknown;
    tailcatRevision?: unknown;
    goVersion?: unknown;
    files?: Record<string, { bytes?: unknown; sha256?: unknown }>;
  };
  if (manifest.schemaVersion !== 1 || manifest.tailcatRevision !== revision)
    throw new Error('Web and Wasm Tailcat revisions do not match.');
  if (
    typeof manifest.goVersion !== 'string' ||
    !/^go\d+\.\d+\.\d+$/u.test(manifest.goVersion) ||
    manifest.goVersion !== goVersion
  )
    throw new Error(
      'Tailcat artifact does not match the pinned Go toolchain version.',
    );
  const files = ['wasm_exec.js', 'tailcat-web.wasm'].map((name) => {
    const source = readFileSync(join(directory, name));
    const sha256 = digest(source);
    if (
      manifest.files?.[name]?.sha256 !== sha256 ||
      manifest.files[name]?.bytes !== source.byteLength
    )
      throw new Error('Tailcat artifact does not match its recorded checksum.');
    const dot = name.lastIndexOf('.');
    return {
      fileName: `tailcat/${name.slice(0, dot)}-${sha256}${name.slice(dot)}`,
      source,
    };
  });
  return { goVersion: manifest.goVersion, files };
}

export function compressedAssets(fileName: string, source: Uint8Array) {
  return [
    { fileName: `${fileName}.gz`, source: gzipSync(source, { level: 9 }) },
    {
      fileName: `${fileName}.br`,
      source: brotliCompressSync(source, {
        params: { [constants.BROTLI_PARAM_QUALITY]: 9 },
      }),
    },
  ];
}
