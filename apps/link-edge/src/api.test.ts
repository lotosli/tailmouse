import { describe, expect, it, vi, afterEach } from 'vitest';
import { encode } from 'cborg';
import {
  BODY_LIMIT,
  ORIGIN,
  RequestFailure,
  base64url,
  equalHash,
  exact,
  failure,
  randomCode,
  readJSON,
  requireEmptyBody,
  reply,
  tokenHash,
  validInvitation,
  validToken,
} from './api.ts';

import { invitation } from '../tests/invitation.ts';

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('strict invitation boundary', () => {
  it('accepts the canonical protected protocol and rejects invalid card fields', () => {
    expect(validInvitation(invitation())).toBe(true);
    for (const patch of [
      { a: 1 },
      { z: 1 },
      { v: 2 },
      { m: 'escape' },
      { p: 80 },
      { e: -1 },
      { e: 1 },
      { e: 1.1 },
      { s: new Uint8Array(16) },
      { s: new Uint8Array(15).fill(1) },
      { t: '' },
      { t: 1 },
      { extra: 1 },
    ]) {
      expect(validInvitation(invitation(patch))).toBe(false);
    }
    expect(validInvitation(invitation({ e: 3 }), 2000)).toBe(true);
    expect(validInvitation(invitation({ e: 3 }), 3000)).toBe(false);
  });
  it('rejects noncanonical encodings, foreign origins and oversized input', () => {
    for (const value of [
      null,
      4,
      {},
      '',
      'x'.repeat(1400),
      invitation().replace(ORIGIN, 'https://other.example'),
      invitation() + '=',
      `${ORIGIN}/#/v1/%20`,
      `${ORIGIN}/#/v1/A`,
      `${ORIGIN}/#/v1/`,
      `${ORIGIN}/#/v1/${base64url(encode([]))}`,
    ])
      expect(validInvitation(value)).toBe(false);
    const unordered = encode(
      {
        z: 2,
        v: 1,
        t: 'synthetic',
        s: new Uint8Array(16).fill(1),
        p: 44321,
        m: 'leash',
        e: 0,
        a: 2,
      },
      { mapSorter: () => 0 },
    );
    expect(validInvitation(`${ORIGIN}/#/v1/${base64url(unordered)}`)).toBe(
      false,
    );
    expect(exact([], [])).toBe(false);
    expect(exact(null, [])).toBe(false);
  });
});

describe('bounded JSON', () => {
  function streamRequest(body: ReadableStream<Uint8Array>): Request {
    const init = {
      method: 'POST',
      body,
      duplex: 'half',
      headers: { 'content-type': 'application/json' },
    };
    return new Request(ORIGIN, init);
  }
  const request = (
    body: BodyInit | null,
    headers: Record<string, string> = { 'content-type': 'application/json' },
  ) => new Request(ORIGIN, { method: 'POST', body, headers });
  it('accepts only a bounded JSON UTF-8 body', async () => {
    expect(await readJSON(request('{"x":1}'))).toEqual({ x: 1 });
    expect(
      await readJSON(
        request('{"x":1}', {
          'content-type': 'application/json; charset=UTF-8',
          'content-length': '7',
        }),
      ),
    ).toEqual({ x: 1 });
    for (const input of [
      request(null),
      request('{}', {}),
      request('{}', { 'content-type': 'text/plain' }),
      request('{}', {
        'content-type': 'application/json',
        'content-encoding': 'gzip',
      }),
      request('{}', {
        'content-type': 'application/json',
        'content-length': 'oops',
      }),
      request('{}', {
        'content-type': 'application/json',
        'content-length': String(BODY_LIMIT + 1),
      }),
      request(' '.repeat(BODY_LIMIT + 1)),
      request('{'),
      request(new Uint8Array([255])),
    ])
      await expect(readJSON(input)).rejects.toBeInstanceOf(RequestFailure);
  });
  it('rejects a stalled or failed stream and releases its reader', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ cancel });
    const pending = readJSON(streamRequest(stream));
    const rejection = expect(pending).rejects.toMatchObject({ status: 503 });
    await vi.advanceTimersByTimeAsync(10_000);
    await rejection;
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(stream.locked).toBe(false);
    const broken = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error('synthetic-private-input'));
      },
    });
    await expect(readJSON(streamRequest(broken))).rejects.toThrow(
      'invalid_request',
    );
    expect(broken.locked).toBe(false);
  });
  it('accepts semantically empty HTTP bodies but rejects payloads and stalled streams', async () => {
    for (const body of [null, '', new Uint8Array()]) {
      await expect(
        requireEmptyBody(request(body, { 'content-length': '0' })),
      ).resolves.toBeUndefined();
    }
    for (const input of [
      request('x'),
      request(' '),
      request('{}'),
      request('', { 'content-length': '1' }),
      request('', { 'content-length': 'invalid' }),
      request('', { 'content-encoding': 'gzip' }),
    ])
      await expect(requireEmptyBody(input)).rejects.toMatchObject({
        status: 400,
      });
    vi.useFakeTimers();
    const stream = new ReadableStream<Uint8Array>();
    const pending = requireEmptyBody(streamRequest(stream));
    const rejected = expect(pending).rejects.toMatchObject({ status: 503 });
    await vi.advanceTimersByTimeAsync(10_000);
    await rejected;
    expect(stream.locked).toBe(false);
  });
});

describe('non-secret replies and management capability', () => {
  it('never caches either failures or success', async () => {
    for (const status of [400, 404, 405, 409, 413, 429, 503]) {
      const response = failure(status);
      expect(response.status).toBe(status);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('referrer-policy')).toBe('no-referrer');
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      expect(Object.keys(await response.json())).toEqual(['error']);
      expect(response.headers.get('retry-after')).toBe(
        status === 429 ? '60' : null,
      );
    }
    expect(await reply(null, 204).text()).toBe('');
    expect(reply({ ok: true }).headers.get('cache-control')).toBe('no-store');
  });
  it('hashes and compares canonical 256-bit management values', async () => {
    const first = base64url(new Uint8Array(32).fill(7));
    const second = base64url(new Uint8Array(32).fill(8));
    expect(validToken(first)).toBe(true);
    for (const bad of [null, 'a', first + '=', first.slice(0, 42) + 'B'])
      expect(validToken(bad)).toBe(false);
    const hash = await tokenHash(first);
    expect(hash).not.toBe(first);
    expect(equalHash(hash, await tokenHash(first))).toBe(true);
    expect(equalHash(hash, await tokenHash(second))).toBe(false);
    expect(equalHash(hash, '')).toBe(false);
  });
  it('samples six case-sensitive characters without modulo bias or an infinite loop', () => {
    vi.spyOn(crypto, 'getRandomValues').mockImplementationOnce((bytes) => {
      const data = bytes as Uint8Array;
      data.fill(255);
      data.set([248, 249, 0, 9, 10, 35, 36, 61]);
      return bytes;
    });
    expect(randomCode()).toBe('09AZaz');
    vi.spyOn(crypto, 'getRandomValues').mockImplementationOnce((bytes) => {
      (bytes as Uint8Array).fill(255);
      return bytes;
    });
    expect(() => randomCode()).toThrow('invalid_request');
    vi.restoreAllMocks();
    expect(randomCode()).toMatch(/^[0-9A-Za-z]{6}$/u);
  });
});
