import { encode } from 'cborg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { consumeInvitation, InvitationError } from './invitation.ts';
import {
  discardShortInvitationTimings,
  resolveShortInvitation,
} from './short-invitation.ts';

const now = 1_700_000_000_000;
const origin = 'https://link.tailmouse.com';
const unavailable = new InvitationError('UNAVAILABLE');
const fetcher = vi.fn<typeof fetch>();

function invitation(overrides: Record<string, unknown> = {}): string {
  return `${origin}/#/v1/${Buffer.from(
    encode({
      a: 2,
      e: 0,
      m: 'leash',
      p: 44321,
      s: new Uint8Array(16).fill(7),
      t: 'tcSyntheticResolvedCredential',
      v: 1,
      z: 2,
      ...overrides,
    }),
  ).toString('base64url')}`;
}

function reply(
  value: unknown = { invitation: invitation(), expiresAt: now + 900_000 },
) {
  return new Response(JSON.stringify(value), {
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
    },
  });
}

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(now);
  vi.stubGlobal('fetch', fetcher);
  fetcher.mockResolvedValue(reply());
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  fetcher.mockReset();
});

function locationAt(href: string) {
  const current = new URL(href);
  const replaceState = vi.fn((_data: unknown, _title: string, path: string) => {
    current.href = new URL(path, current).href;
  });
  vi.stubGlobal('location', current);
  vi.stubGlobal('history', { replaceState });
  return { current, replaceState };
}

describe('short invitation input', () => {
  it('consumes exact case once and clears the path before any async work', () => {
    const { current, replaceState } = locationAt(`${origin}/T6wxZ8`);
    expect(consumeInvitation()).toEqual({ shortCode: 'T6wxZ8' });
    expect(replaceState).toHaveBeenCalledExactlyOnceWith(null, '', '/');
    expect(current.href).toBe(`${origin}/`);
    expect(() => consumeInvitation()).toThrow(InvitationError);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects ambiguous, malformed and noncanonical official inputs after erasure', () => {
    for (const path of [
      '/T6wxZ8#synthetic',
      '/T6wxZ8?code=synthetic',
      '/T6wxZ',
      '/T6wxZ80',
      '/T6wx_8',
      '/T6wxZ8/',
      '/%546wxZ8',
      '/index.html',
    ]) {
      const { current } = locationAt(origin + path);
      expect(() => consumeInvitation()).toThrow(unavailable);
      expect(current.href).toBe(`${origin}/`);
    }
    locationAt(`https://user@link.tailmouse.com/T6wxZ8`);
    expect(() => consumeInvitation()).toThrow(unavailable);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects short paths on self-hosted origins and keeps full fragments API-free', () => {
    locationAt('https://selfhost.example/T6wxZ8');
    expect(() => consumeInvitation()).toThrow(InvitationError);
    locationAt(invitation());
    expect(consumeInvitation()).toMatchObject({ mode: 'leash' });
    locationAt(invitation().replace(origin, 'https://selfhost.example/app'));
    expect(consumeInvitation()).toMatchObject({ mode: 'leash' });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('bounded short invitation resolver', () => {
  it('clears delayed resolver timings without retaining unrelated entries and disconnects on disposal', () => {
    locationAt(`${origin}/`);
    let deliver: PerformanceObserverCallback | undefined;
    const observe = vi.fn();
    const disconnect = vi.fn();
    vi.stubGlobal(
      'PerformanceObserver',
      class {
        constructor(callback: PerformanceObserverCallback) {
          deliver = callback;
        }
        observe = observe;
        disconnect = disconnect;
      },
    );
    const clear = vi.spyOn(performance, 'clearResourceTimings');
    const dispose = discardShortInvitationTimings();
    expect(observe).toHaveBeenCalledExactlyOnceWith({ type: 'resource' });
    const notify = (name: string) =>
      deliver!(
        { getEntries: () => [{ name }] } as PerformanceObserverEntryList,
        {} as PerformanceObserver,
      );
    notify(`${origin}/assets/app-hash.js`);
    expect(clear).not.toHaveBeenCalled();
    notify(`${origin}/api/v1/short-invitations/T6wxZ8`);
    expect(clear).toHaveBeenCalledOnce();
    dispose();
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it('resolves one memory-only protected card without auth or cache material', async () => {
    const clearTimings = vi.spyOn(performance, 'clearResourceTimings');
    const card = await resolveShortInvitation(
      'T6wxZ8',
      new AbortController().signal,
    );
    expect(card).toMatchObject({
      mode: 'leash',
      protocolMin: 2,
      protocolMax: 2,
      requiresAccessCode: true,
      sessionID: new Uint8Array(16).fill(7),
    });
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(
      '/api/v1/short-invitations/T6wxZ8',
      {
        method: 'GET',
        signal: expect.any(AbortSignal),
        mode: 'same-origin',
        credentials: 'omit',
        redirect: 'error',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
        headers: { Accept: 'application/json' },
      },
    );
    expect(clearTimings).toHaveBeenCalledOnce();
  });

  it('rejects invalid code and pre-aborted work before a request', async () => {
    for (const code of ['', 'T6wxZ8/', 'T6wxZ80', 'T6wx_8'])
      await expect(
        resolveShortInvitation(code, new AbortController().signal),
      ).rejects.toThrow(unavailable);
    const controller = new AbortController();
    controller.abort();
    await expect(
      resolveShortInvitation('T6wxZ8', controller.signal),
    ).rejects.toThrow(unavailable);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('leaves the lease maximum to the server when browser clocks differ', async () => {
    fetcher.mockResolvedValueOnce(
      reply({
        invitation: invitation(),
        expiresAt: now + 905_000,
      }),
    );
    await expect(
      resolveShortInvitation('T6wxZ8', new AbortController().signal),
    ).resolves.toMatchObject({ mode: 'leash', requiresAccessCode: true });
  });

  it('uses the same bounded failure for unknown, expired, wrong-case, deleted and network failures', async () => {
    for (const status of [400, 404, 410, 429, 500]) {
      fetcher.mockResolvedValueOnce(
        new Response('tcSyntheticPrivateError', { status }),
      );
      await expect(
        resolveShortInvitation('t6wxz8', new AbortController().signal),
      ).rejects.toThrow(unavailable);
    }
    fetcher.mockRejectedValueOnce(new Error('tcSyntheticPrivateError'));
    await expect(
      resolveShortInvitation('T6wxZ8', new AbortController().signal),
    ).rejects.toThrow(unavailable);
  });

  it('rejects cacheable, redirected, incorrectly typed or oversized replies', async () => {
    const redirected = reply();
    Object.defineProperty(redirected, 'redirected', { value: true });
    const responses = [
      new Response(null),
      new Response('not-json'),
      redirected,
      new Response('{}', { headers: { 'content-type': 'application/json' } }),
      new Response('x'.repeat(2049), {
        headers: {
          'content-type': 'application/json',
          'cache-control': 'no-store',
        },
      }),
    ];
    for (const length of ['2049', 'bad', '-1']) {
      const response = reply();
      response.headers.set('content-length', length);
      responses.push(response);
    }
    for (const response of responses) {
      fetcher.mockResolvedValueOnce(response);
      await expect(
        resolveShortInvitation('T6wxZ8', new AbortController().signal),
      ).rejects.toThrow(unavailable);
    }
  });

  it('rejects wrong schema, expiry, mode, protocol and full URL without retaining decoded bytes', async () => {
    const values: unknown[] = [
      null,
      [],
      true,
      {},
      { invitation: invitation(), expiresAt: now, extra: true },
    ];
    for (const expiresAt of [
      now - 1,
      now,
      Number.MAX_SAFE_INTEGER + 1,
      now + 0.5,
      'later',
      null,
    ])
      values.push({ invitation: invitation(), expiresAt });
    for (const invalid of [
      3,
      'bad',
      `${origin}/#/v1/${'a'.repeat(1400)}`,
      invitation({ m: 'escape', a: 1, z: 1 }),
      invitation({ a: 1 }),
      invitation({ e: now / 1000 }),
      invitation({ v: 2 }),
      invitation().replace(origin, 'https://untrusted.example'),
      invitation().replace('/#', '/path#'),
      invitation().replace('/#', '/?extra#'),
      invitation().replace(origin, 'https://user@link.tailmouse.com'),
    ])
      values.push({ invitation: invalid, expiresAt: now + 10_000 });
    for (const value of values) {
      fetcher.mockResolvedValueOnce(reply(value));
      await expect(
        resolveShortInvitation('T6wxZ8', new AbortController().signal),
      ).rejects.toThrow(unavailable);
    }
    fetcher.mockResolvedValueOnce(
      new Response('{"incomplete":', {
        headers: {
          'content-type': 'application/json',
          'cache-control': 'no-store',
        },
      }),
    );
    await expect(
      resolveShortInvitation('T6wxZ8', new AbortController().signal),
    ).rejects.toThrow(unavailable);
  });

  it('erases streamed partial bytes and cancels when input overflows', async () => {
    const first = new Uint8Array(1024).fill(77);
    const second = new Uint8Array(1025).fill(88);
    const cancel = vi.fn();
    fetcher.mockResolvedValueOnce(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(first);
            controller.enqueue(second);
          },
          cancel,
        }),
        {
          headers: {
            'content-type': 'application/json',
            'cache-control': 'no-store',
          },
        },
      ),
    );
    await expect(
      resolveShortInvitation('T6wxZ8', new AbortController().signal),
    ).rejects.toThrow(unavailable);
    expect(first.every((byte) => byte === 0)).toBe(true);
    expect(second.every((byte) => byte === 0)).toBe(true);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('bounds stalled requests by cancellation and the fixed ten-second timeout', async () => {
    vi.useFakeTimers();
    fetcher.mockImplementation(
      (_url, options) =>
        new Promise((_resolve, reject) => {
          options!.signal!.addEventListener(
            'abort',
            () => reject(new Error('private cancellation')),
            { once: true },
          );
        }),
    );
    const controller = new AbortController();
    const canceled = expect(
      resolveShortInvitation('T6wxZ8', controller.signal),
    ).rejects.toThrow(unavailable);
    controller.abort();
    await canceled;
    const timed = expect(
      resolveShortInvitation('T6wxZ8', new AbortController().signal),
    ).rejects.toThrow(unavailable);
    await vi.advanceTimersByTimeAsync(9999);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await timed;
    expect(vi.getTimerCount()).toBe(0);
  });
});
