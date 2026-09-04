import { encode } from 'cborg';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  consumeInvitation,
  InvitationError,
  parseFragment,
} from './invitation.ts';

const address = 'tcSyntheticBrowserCredential';
const now = 1_700_000_000;
const expectedCard = {
  address,
  expiresAt: now + 600,
  mode: 'escape',
  port: 44321,
  protocolMax: 1,
  protocolMin: 1,
  sessionID: new Uint8Array(16).fill(7),
  version: 1,
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('invitation', () => {
  it('agrees with the shared compatible-range corpus without claiming another codec', () => {
    const corpus = JSON.parse(
      readFileSync(
        new URL(
          '../../../protocol/fixtures/v1/mousecards.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ) as {
      cases: Array<{
        id: string;
        accept: boolean;
        protocolMin?: number;
        protocolMax?: number;
        hex: string;
      }>;
    };
    expect(corpus.cases).toHaveLength(14);
    for (const fixture of corpus.cases) {
      const encoded =
        '#/v1/' + Buffer.from(fixture.hex, 'hex').toString('base64url');
      if (fixture.accept) {
        expect(parseFragment(encoded, now), fixture.id).toMatchObject({
          protocolMin: fixture.protocolMin,
          protocolMax: fixture.protocolMax,
        });
      } else {
        expect(() => parseFragment(encoded, now), fixture.id).toThrow(
          InvitationError,
        );
      }
    }
  });
  it('decodes every bounded v1 field and retains a valid session ID after buffer erasure', () => {
    expect(parseFragment(fragment(), now)).toEqual(expectedCard);
    expect(parseFragment(fragment({ m: 'leash' }), now).mode).toBe('leash');
    vi.spyOn(Date, 'now').mockReturnValue(now * 1000);
    expect(parseFragment(fragment())).toEqual(expectedCard);
  });

  it('removes the fragment before returning the in-memory connection values', () => {
    const replaceState = vi.fn();
    const hash = fragment();
    vi.stubGlobal('location', {
      hash,
      href: `https://mouse.example/app?view=compact${hash}`,
      pathname: '/app',
      search: '?view=compact',
    });
    vi.stubGlobal('history', { replaceState });
    expect(consumeInvitation(now)).toEqual(expectedCard);
    expect(replaceState).toHaveBeenCalledWith(null, '', '/app?view=compact');
  });

  it('rejects malformed, oversized, duplicate, and unsupported cards safely', () => {
    const invalid = [
      '',
      '#/v2/abc',
      '#/v1/',
      '#/v1/not+padded',
      '#/v1/A',
      '#/v1/AB',
      '#/v1/AA=',
      '#/v1/AA\n',
      `#/v1/${'A'.repeat(1400)}`,
      fragment({ v: 2 }),
      fragment({ p: 80 }),
      fragment({ m: 'admin' }),
      fragment({ s: new Uint8Array(15) }),
      fragment({ s: new Uint8Array(16) }),
      fragment({ s: Array.from({ length: 16 }, () => 7) }),
      fragment({ t: '' }),
      fragment({ t: 42 }),
      fragment({ e: -1 }),
      fragment({ e: 1.5 }),
      fragment({ e: Number.MAX_SAFE_INTEGER + 1 }),
      fragment({ a: 0 }),
      fragment({ z: 0 }),
      fragment({ extra: true }),
      '#/v1/uQFhAWFhAg', // {"a": 1, "a": 2}
    ];
    for (const value of invalid) {
      expect(() => parseFragment(value, now)).toThrow(InvitationError);
      expect(() => parseFragment(value, now)).not.toThrow(address);
    }

    const replaceState = vi.fn();
    vi.stubGlobal('location', {
      hash: fragment(),
      href: `https://mouse.example/#/v1/${'x'.repeat(1400)}`,
      pathname: '/',
      search: '',
    });
    vi.stubGlobal('history', { replaceState });
    expect(() => consumeInvitation(now)).toThrow(InvitationError);
    expect(replaceState).toHaveBeenCalledOnce();
  });

  it('rejects noncanonical CBOR, trailing bytes, missing and duplicate keys', () => {
    const canonical = Buffer.from(fragment().slice(5), 'base64url');
    const duplicate = Buffer.from(canonical);
    duplicate[duplicate.length - 2] = 0x61; // Replace the last key z with a.
    const candidates = [
      Buffer.concat([canonical, Buffer.from([0])]),
      Buffer.concat([Buffer.from([0xd9, 0xd9, 0xf7]), canonical]),
      Buffer.concat([
        canonical.subarray(0, 3),
        Buffer.from([0x18, 0x01]),
        canonical.subarray(4),
      ]),
      Buffer.concat([
        Buffer.from([0xa8]),
        canonical.subarray(-3),
        canonical.subarray(4, -3),
        canonical.subarray(1, 4),
      ]),
      Buffer.concat([Buffer.from([0xa7]), canonical.subarray(4)]),
      duplicate,
    ];
    for (const bytes of candidates) {
      expect(() =>
        parseFragment(`#/v1/${bytes.toString('base64url')}`, now),
      ).toThrow(InvitationError);
    }
  });

  it('rejects expiry at the exact boundary but accepts host lifetime and safe future expiry', () => {
    expect(parseFragment(fragment({ e: 0 }), now).expiresAt).toBe(0);
    expect(
      parseFragment(fragment({ e: Number.MAX_SAFE_INTEGER }), now).expiresAt,
    ).toBe(Number.MAX_SAFE_INTEGER);
    expect(parseFragment(fragment({ e: now + 1 }), now).expiresAt).toBe(
      now + 1,
    );
    for (const expiry of [now - 1, now]) {
      expect(() => parseFragment(fragment({ e: expiry }), now)).toThrow(
        new InvitationError('EXPIRED'),
      );
    }
  });

  it('consumes the fragment once, clears history state, and never recovers from storage', () => {
    const location = {
      hash: fragment(),
      href: `https://mouse.example/${fragment()}`,
      pathname: '/',
      search: '',
    };
    const replaceState = vi.fn(() => {
      location.hash = '';
      location.href = 'https://mouse.example/';
    });
    const storage = { getItem: vi.fn(), setItem: vi.fn() };
    vi.stubGlobal('location', location);
    vi.stubGlobal('history', { replaceState });
    vi.stubGlobal('localStorage', storage);
    vi.stubGlobal('sessionStorage', storage);
    expect(consumeInvitation(now)).toEqual(expectedCard);
    expect(() => consumeInvitation(now)).toThrow(InvitationError);
    expect(replaceState).toHaveBeenCalledWith(null, '', '/');
    expect(storage.getItem).not.toHaveBeenCalled();
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it('fails closed if history cleanup fails, without exposing the browser exception', () => {
    vi.stubGlobal('location', {
      hash: fragment(),
      href: 'https://mouse.example/',
      pathname: '/',
      search: '',
    });
    vi.stubGlobal('history', {
      replaceState: () => {
        throw new Error(address);
      },
    });
    expect(() => consumeInvitation(now)).toThrow(new InvitationError());
  });

  it('checks UTF-8 URL size as well as character size after removing the fragment', () => {
    const replaceState = vi.fn();
    vi.stubGlobal('location', {
      hash: fragment(),
      href: `https://mouse.example/${'é'.repeat(700)}`,
      pathname: '/',
      search: '',
    });
    vi.stubGlobal('history', { replaceState });
    expect(() => consumeInvitation(now)).toThrow(InvitationError);
    expect(replaceState).toHaveBeenCalledOnce();
  });
});

function fragment(overrides: Record<string, unknown> = {}): string {
  const card = {
    a: 1,
    e: 1_700_000_600,
    m: 'escape',
    p: 44321,
    s: new Uint8Array(16).fill(7),
    t: address,
    v: 1,
    z: 1,
    ...overrides,
  };
  return `#/v1/${Buffer.from(encode(card)).toString('base64url')}`;
}
