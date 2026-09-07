import manifest from '../.artifacts/static-manifest.json';

type StaticObject = {
  bytes: number;
  sha256: string;
  contentType: string;
  cacheControl: string;
  contentEncoding?: string;
};

const objects = new Map<string, StaticObject>(Object.entries(manifest.files));
const shortPath = /^\/[0-9A-Za-z]{6}$/u;

export function isStaticLocator(code: string): boolean {
  return objects.has(code);
}

function failure(status: number, method: string): Response {
  return new Response(
    method === 'HEAD' ? null : 'Static resource unavailable.\n',
    {
      status,
      headers: {
        ...manifest.requiredHeaders,
        'cache-control': 'no-store',
        'content-type': 'text/plain; charset=utf-8',
        ...(status === 405 ? { allow: 'GET, HEAD' } : {}),
      },
    },
  );
}

function encodingQuality(header: string, encoding: string): number {
  let wildcard: number | undefined;
  for (const entry of header.toLowerCase().split(',')) {
    const match = entry
      .trim()
      .match(/^([a-z*]+)(?:\s*;\s*q=(0(?:\.\d{0,3})?|1(?:\.0{0,3})?))?$/u);
    if (!match) continue;
    const quality = match[2] === undefined ? 1 : Number(match[2]);
    if (match[1] === encoding) return quality;
    if (match[1] === '*') wildcard = quality;
  }
  return encoding === 'identity' ? (wildcard === 0 ? 0 : 1) : (wildcard ?? 0);
}

function representation(
  path: string,
  acceptEncoding: string,
): string | undefined {
  const original = objects.get(path)!;
  if (original.contentEncoding) return path;
  let selected: string | undefined;
  let bestQuality = 0;
  for (const [encoding, suffix] of [
    ['br', '.br'],
    ['gzip', '.gz'],
    ['identity', ''],
  ] as const) {
    const quality = encodingQuality(acceptEncoding, encoding);
    if (quality > bestQuality && objects.has(`${path}${suffix}`)) {
      selected = `${path}${suffix}`;
      bestQuality = quality;
    }
  }
  return selected;
}

function byteRange(
  value: string,
  size: number,
): { offset: number; length: number } | undefined {
  const match = /^bytes=(\d*)-(\d*)$/u.exec(value);
  if (!match || (!match[1] && !match[2]) || size === 0) return undefined;
  const first = Number(match[1]);
  const last = Number(match[2]);
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last))
    return undefined;
  const offset = match[1] ? first : Math.max(0, size - last);
  const end = match[1] && match[2] ? Math.min(last, size - 1) : size - 1;
  if (offset >= size || offset > end) return undefined;
  return { offset, length: end - offset + 1 };
}

function matches(metadata: StaticObject, object: R2Object): boolean {
  const checksum = object.checksums.sha256;
  return (
    object.size === metadata.bytes &&
    object.httpMetadata?.contentType === metadata.contentType &&
    object.httpMetadata.cacheControl === metadata.cacheControl &&
    object.httpMetadata.contentEncoding === metadata.contentEncoding &&
    (!checksum ||
      Array.from(new Uint8Array(checksum), (byte) =>
        byte.toString(16).padStart(2, '0'),
      ).join('') === metadata.sha256)
  );
}

export async function serveStatic(
  request: Request,
  env: { STATIC_ASSETS: R2Bucket },
): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD')
    return failure(405, request.method);
  const path = new URL(request.url).pathname;
  const isShort = shortPath.test(path) && !objects.has(path.slice(1));
  const key = path === '/' || isShort ? 'index.html' : path.slice(1);
  if (!objects.has(key)) return failure(404, request.method);
  const selected = representation(
    key,
    typeof request.cf?.clientAcceptEncoding === 'string'
      ? request.cf.clientAcceptEncoding
      : (request.headers.get('accept-encoding') ?? ''),
  );
  if (!selected) return failure(406, request.method);
  const metadata = objects.get(selected)!;
  const etag = `"${metadata.sha256}"`;
  const headers = new Headers({
    ...manifest.requiredHeaders,
    'content-type': metadata.contentType,
    'cache-control': isShort ? 'no-store' : metadata.cacheControl,
    'content-length': String(metadata.bytes),
    'accept-ranges': 'bytes',
    etag,
  });
  if (metadata.contentEncoding)
    headers.set('content-encoding', metadata.contentEncoding);
  if (
    !objects.get(key)!.contentEncoding &&
    (objects.has(`${key}.br`) || objects.has(`${key}.gz`))
  )
    headers.set('vary', 'Accept-Encoding');
  const noneMatch = request.headers.get('if-none-match');
  const notModified =
    !isShort &&
    noneMatch
      ?.split(',')
      .some(
        (value) =>
          value.trim() === '*' || value.trim().replace(/^W\//u, '') === etag,
      );
  const rangeValue = request.headers.get('range');
  const ifRange = request.headers.get('if-range');
  const wantsRange =
    request.method === 'GET' &&
    rangeValue !== null &&
    (!ifRange || ifRange === etag) &&
    !notModified;
  const range = wantsRange ? byteRange(rangeValue!, metadata.bytes) : undefined;
  if (wantsRange && !range) {
    const response = failure(416, request.method);
    response.headers.set('content-range', `bytes */${metadata.bytes}`);
    return response;
  }
  try {
    let object: R2Object | null;
    let body: ReadableStream | null = null;
    if (request.method === 'HEAD' || notModified) {
      object = await env.STATIC_ASSETS.head(selected);
    } else {
      const result = await env.STATIC_ASSETS.get(
        selected,
        range ? { range } : undefined,
      );
      object = result;
      body = result?.body ?? null;
    }
    if (!object || !matches(metadata, object)) {
      await body?.cancel();
      return failure(503, request.method);
    }
    if (notModified) {
      headers.delete('content-length');
      return new Response(null, { status: 304, headers });
    }
    if (range) {
      headers.set('content-length', String(range.length));
      headers.set(
        'content-range',
        `bytes ${range.offset}-${range.offset + range.length - 1}/${metadata.bytes}`,
      );
    }
    return new Response(body, {
      status: range ? 206 : 200,
      headers,
      encodeBody: 'manual',
    });
  } catch {
    return failure(503, request.method);
  }
}
