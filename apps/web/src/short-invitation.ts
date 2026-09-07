import {
  InvitationError,
  parseFragment,
  type MouseCard,
} from './invitation.ts';

const MAX_RESPONSE_BYTES = 2048;
const OFFICIAL_ORIGIN = 'https://link.tailmouse.com';

export function discardShortInvitationTimings(): () => void {
  // Fetch completion can precede insertion into the resource timeline. Observe
  // the active short-link page so a later browser task cannot reintroduce its
  // locator after the resolver's immediate cleanup. Retain no entries.
  const observer = new PerformanceObserver((list) => {
    if (
      list
        .getEntries()
        .some((entry) =>
          entry.name.startsWith(`${location.origin}/api/v1/short-invitations/`),
        )
    )
      performance.clearResourceTimings();
  });
  observer.observe({ type: 'resource' });
  return () => observer.disconnect();
}

// The caller has consumed and erased one canonical official short path. Only
// its locator is sent; the separate access code never enters this boundary.
export async function resolveShortInvitation(
  code: string,
  signal: AbortSignal,
): Promise<MouseCard> {
  const timeout = new AbortController();
  const bound = AbortSignal.any([signal, timeout.signal]);
  const timer = setTimeout(() => timeout.abort(), 10_000);
  const bytes = new Uint8Array(MAX_RESPONSE_BYTES);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let card: MouseCard | undefined;
  try {
    if (bound.aborted || !/^[0-9A-Za-z]{6}$/u.test(code))
      throw new InvitationError('UNAVAILABLE');
    const response = await fetch(`/api/v1/short-invitations/${code}`, {
      method: 'GET',
      signal: bound,
      mode: 'same-origin',
      credentials: 'omit',
      redirect: 'error',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      headers: { Accept: 'application/json' },
    });
    if (
      response.status !== 200 ||
      response.redirected ||
      response.headers.get('content-type')?.split(';')[0]?.trim() !==
        'application/json' ||
      !response.headers
        .get('cache-control')
        ?.split(',')
        .some((directive) => directive.trim().toLowerCase() === 'no-store') ||
      response.body === null
    )
      throw new InvitationError('UNAVAILABLE');
    const declared = response.headers.get('content-length');
    if (
      declared !== null &&
      (!/^[0-9]+$/u.test(declared) || Number(declared) > MAX_RESPONSE_BYTES)
    )
      throw new InvitationError('UNAVAILABLE');
    reader = response.body.getReader();
    let length = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      try {
        if (bound.aborted || length + value.byteLength > MAX_RESPONSE_BYTES)
          throw new InvitationError('UNAVAILABLE');
        bytes.set(value, length);
        length += value.byteLength;
      } finally {
        value.fill(0);
      }
    }
    if (bound.aborted) throw new InvitationError('UNAVAILABLE');
    const result: unknown = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(
        bytes.subarray(0, length),
      ),
    );
    if (
      typeof result !== 'object' ||
      result === null ||
      Array.isArray(result) ||
      Object.keys(result).sort().join(',') !== 'expiresAt,invitation'
    )
      throw new InvitationError('UNAVAILABLE');
    const value = result as { invitation: unknown; expiresAt: unknown };
    if (
      typeof value.invitation !== 'string' ||
      new TextEncoder().encode(value.invitation).byteLength >= 1400 ||
      typeof value.expiresAt !== 'number' ||
      !Number.isSafeInteger(value.expiresAt) ||
      value.expiresAt <= Date.now()
    )
      throw new InvitationError('UNAVAILABLE');
    const url = new URL(value.invitation);
    if (
      url.origin !== OFFICIAL_ORIGIN ||
      url.pathname !== '/' ||
      url.search !== '' ||
      value.invitation !== `${OFFICIAL_ORIGIN}/${url.hash}`
    )
      throw new InvitationError('UNAVAILABLE');
    card = parseFragment(url.hash);
    if (
      card.mode !== 'leash' ||
      card.protocolMin !== 2 ||
      card.protocolMax !== 2
    )
      throw new InvitationError('UNAVAILABLE');
    return { ...card, requiresAccessCode: true };
  } catch {
    card?.sessionID.fill(0);
    throw new InvitationError('UNAVAILABLE');
  } finally {
    clearTimeout(timer);
    timeout.abort();
    bytes.fill(0);
    // Cancel any unread body on failure. Cleanup cannot reveal or replace the
    // stable unavailable classification with a network implementation error.
    if (reader !== undefined) {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    performance.clearResourceTimings();
  }
}
