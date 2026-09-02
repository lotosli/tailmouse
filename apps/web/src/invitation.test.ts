import { encode } from 'cborg';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  consumeInvitation,
  InvitationError,
  parseFragment,
} from './invitation.ts';

const address = 'tcSyntheticBrowserCredential';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('invitation', () => {
  it('decodes the bounded v1 fields without retaining unrelated card data', () => {
    expect(parseFragment(fragment())).toEqual({ address, mode: 'escape' });
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
    expect(consumeInvitation()).toEqual({ address, mode: 'escape' });
    expect(replaceState).toHaveBeenCalledWith(null, '', '/app?view=compact');
  });

  it('rejects malformed, oversized, duplicate, and unsupported cards safely', () => {
    const invalid = [
      '',
      '#/v2/abc',
      '#/v1/',
      '#/v1/not+padded',
      '#/v1/A',
      fragment({ p: 80 }),
      fragment({ m: 'admin' }),
      fragment({ s: new Uint8Array(15) }),
      fragment({ extra: true }),
      '#/v1/uQFhAWFhAg', // {"a": 1, "a": 2}
    ];
    for (const value of invalid) {
      expect(() => parseFragment(value)).toThrow(InvitationError);
    }

    const replaceState = vi.fn();
    vi.stubGlobal('location', {
      hash: fragment(),
      href: `https://mouse.example/#/v1/${'x'.repeat(1400)}`,
      pathname: '/',
      search: '',
    });
    vi.stubGlobal('history', { replaceState });
    expect(() => consumeInvitation()).toThrow(InvitationError);
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
