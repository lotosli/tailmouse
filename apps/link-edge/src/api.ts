import { decode, encode } from 'cborg';

export const ORIGIN = 'https://link.tailmouse.com';
export const API_PATH = '/api/v1/short-invitations';
export const CODE = /^[0-9A-Za-z]{6}$/u;
export const LEASE_MS = 15 * 60_000;
export const REQUEST_MS = 10_000;
export const BODY_LIMIT = 2048;
export const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'self' https: wss:; frame-src https:; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy':
    'camera=(), microphone=(), geolocation=(), payment=(), usb=(), accelerometer=(self), gyroscope=(self), magnetometer=()',
  'X-Content-Type-Options': 'nosniff',
};

export class RequestFailure extends Error {
  constructor(readonly status = 400) {
    super('invalid_request');
  }
}

export function reply(value: unknown, status = 200): Response {
  const headers = { ...SECURITY_HEADERS, 'Cache-Control': 'no-store' };
  return status === 204
    ? new Response(null, { status, headers })
    : Response.json(value, { status, headers });
}

export function failure(status = 404): Response {
  const error =
    status === 404
      ? 'invitation_unavailable'
      : status === 429
        ? 'rate_limited'
        : status === 503
          ? 'service_unavailable'
          : 'invalid_request';
  const response = reply({ error }, status);
  if (status === 429) response.headers.set('Retry-After', '60');
  return response;
}

export function exact(
  value: unknown,
  keys: string[],
): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

export async function readJSON(request: Request): Promise<unknown> {
  if (
    !/^application\/json(?:;\s*charset=utf-8)?$/iu.test(
      request.headers.get('content-type') ?? '',
    ) ||
    request.headers.has('content-encoding')
  )
    throw new RequestFailure();
  const bytes = await readBody(request, BODY_LIMIT);
  try {
    return JSON.parse(
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes),
    ) as unknown;
  } catch {
    throw new RequestFailure();
  } finally {
    bytes.fill(0);
  }
}

export async function requireEmptyBody(request: Request): Promise<void> {
  await readBody(request, 0);
}

async function readBody(request: Request, limit: number): Promise<Uint8Array> {
  if (request.headers.has('content-encoding')) throw new RequestFailure();
  const length = request.headers.get('content-length');
  if (length !== null && (!/^\d+$/u.test(length) || Number(length) > limit))
    throw new RequestFailure(limit === 0 ? 400 : 413);
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const bytes = new Uint8Array(limit);
  let used = 0;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    void reader.cancel().catch(() => {});
  }, REQUEST_MS);
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (timedOut) throw new RequestFailure(503);
      if (done) break;
      if (used + value.byteLength > limit)
        throw new RequestFailure(limit === 0 ? 400 : 413);
      bytes.set(value, used);
      used += value.byteLength;
    }
    return bytes.slice(0, used);
  } catch (error) {
    throw error instanceof RequestFailure ? error : new RequestFailure();
  } finally {
    clearTimeout(timer);
    bytes.fill(0);
    // Cancel is cleanup only; the primary parse/bounds failure stays authoritative.
    try {
      await reader.cancel();
    } catch {
      /* A failed input stream is already rejected. */
    }
    reader.releaseLock();
  }
}

export function validInvitation(
  value: unknown,
  now = Date.now(),
): value is string {
  if (
    typeof value !== 'string' ||
    value.length >= 1400 ||
    !value.startsWith(`${ORIGIN}/#/v1/`)
  )
    return false;
  const encoded = value.slice(`${ORIGIN}/#/v1/`.length);
  if (!/^[\w-]+$/u.test(encoded)) return false;
  let payload: Uint8Array | undefined;
  let canonical: Uint8Array | undefined;
  try {
    payload = Uint8Array.from(
      atob(encoded.replaceAll('-', '+').replaceAll('_', '/')),
      (c) => c.charCodeAt(0),
    );
    if (
      payload.length > 1050 ||
      payload[0] !== 0xa8 ||
      base64url(payload) !== encoded
    )
      return false;
    const card: unknown = decode(payload, {
      allowBigInt: false,
      allowIndefinite: false,
      allowUndefined: false,
      rejectDuplicateMapKeys: true,
      strict: true,
    });
    if (
      !exact(card, ['a', 'e', 'm', 'p', 's', 't', 'v', 'z']) ||
      card.a !== 2 ||
      card.z !== 2 ||
      card.v !== 1 ||
      card.m !== 'leash' ||
      card.p !== 44321 ||
      typeof card.t !== 'string' ||
      card.t.length === 0 ||
      !(card.s instanceof Uint8Array) ||
      card.s.length !== 16 ||
      !card.s.some((byte) => byte !== 0) ||
      typeof card.e !== 'number' ||
      !Number.isSafeInteger(card.e) ||
      card.e < 0 ||
      (card.e !== 0 && Math.floor(now / 1000) >= card.e)
    )
      return false;
    canonical = encode(card);
    return (
      canonical.length === payload.length &&
      canonical.every((byte, index) => byte === payload![index])
    );
  } catch {
    return false;
  } finally {
    payload?.fill(0);
    canonical?.fill(0);
  }
}

export function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
}

export function validToken(token: unknown): token is string {
  return (
    typeof token === 'string' &&
    /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u.test(token)
  );
}

export async function tokenHash(token: string): Promise<string> {
  const bytes = new TextEncoder().encode(token);
  try {
    return base64url(
      new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
    );
  } finally {
    bytes.fill(0);
  }
}

export function equalHash(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index++)
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

export function randomCode(): string {
  const alphabet =
    '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  // Rejection sampling removes modulo bias. A finite entropy budget fails closed.
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let code = '';
  for (const byte of bytes) {
    if (byte < 248) code += alphabet[byte % 62];
    if (code.length === 6) break;
  }
  bytes.fill(0);
  if (code.length !== 6) throw new RequestFailure(503);
  return code;
}
