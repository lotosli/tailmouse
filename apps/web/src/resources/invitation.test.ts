import { describe, expect, it, vi } from 'vitest';
import {
  consumeRecovery,
  eraseRecovery,
  parseResourceInvitation,
  saveRecovery,
} from './invitation.ts';

const invite = {
  v: 1,
  session: 'a'.repeat(32),
  address: 'synthetic-transport-address',
  token: 'A'.repeat(43),
  frontend_major: 1,
};
const fragment = (value: unknown) =>
  '#tm=' +
  btoa(JSON.stringify(value))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '');
const locationFor = (hash = fragment(invite)) => ({
  hash,
  hostname: 'tailmouse.test',
  pathname: '/.tailmouse/workspace/',
  search: '',
});
function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (k: string) => values.get(k) ?? null,
    setItem: (k: string, v: string) => {
      values.set(k, v);
    },
    removeItem: (k: string) => {
      values.delete(k);
    },
  };
}
describe('resource invitation recovery boundary', () => {
  it('erases the invitation before any storage or parsing operation', () => {
    const order: string[] = [];
    const saved = storage();
    const original = saved.removeItem;
    saved.removeItem = (key) => {
      order.push('storage');
      original(key);
    };
    const recovery = consumeRecovery(
      locationFor(),
      {
        replaceState: () => {
          order.push('erase');
        },
      },
      saved,
    );
    expect(order[0]).toBe('erase');
    expect(recovery?.invitation).toEqual(invite);
    expect(
      consumeRecovery(locationFor(''), { replaceState: vi.fn() }, saved),
    ).toEqual(recovery);
    eraseRecovery(saved);
    expect(
      consumeRecovery(locationFor(''), { replaceState: vi.fn() }, saved),
    ).toBeNull();
  });
  it('checks the session hostname outside the explicit private test path', () => {
    expect(() =>
      parseResourceInvitation(fragment(invite), 'tailmouse.test'),
    ).toThrow('origin');
    expect(
      parseResourceInvitation(
        fragment(invite),
        `s-${invite.session}.tailmouse.test`,
      ),
    ).toEqual(invite);
    expect(() => parseResourceInvitation('#other', '', true)).toThrow();
    expect(() =>
      parseResourceInvitation('#tm=' + 'A'.repeat(44000), '', true),
    ).toThrow();
  });
  it.each([
    { ...invite, extra: true },
    { ...invite, v: 2 },
    { ...invite, token: 'bad' },
    { ...invite, session: '../' },
    { ...invite, address: '' },
    { ...invite, frontend_major: 2 },
  ])('rejects incompatible or unbounded invitation fields', (value) => {
    expect(() => parseResourceInvitation(fragment(value), '', true)).toThrow();
  });
  it('discards expired, corrupt or invalid stored grants and does not reuse them', () => {
    for (const saved of [
      'bad-json',
      'x'.repeat(45001),
      JSON.stringify({
        invitation: invite,
        key: '',
        member: '',
        grant: '',
        expires: 1,
      }),
      JSON.stringify({
        invitation: invite,
        key: '',
        member: 'invalid',
        grant: '',
        expires: 0,
      }),
      JSON.stringify({
        invitation: invite,
        key: '',
        member: '',
        grant: 'invalid',
        expires: 0,
      }),
      JSON.stringify({
        invitation: invite,
        key: 'x'.repeat(513),
        member: '',
        grant: '',
        expires: 0,
      }),
    ]) {
      const store = storage();
      store.setItem('tailmouse.resource.v1', saved);
      expect(
        consumeRecovery(locationFor(''), { replaceState: vi.fn() }, store),
      ).toBeNull();
      expect(store.getItem('tailmouse.resource.v1')).toBeNull();
    }
  });
  it('does not silently bypass unavailable recovery storage', () => {
    expect(() =>
      saveRecovery(
        {
          setItem: () => {
            throw new Error('quota');
          },
        },
        {
          invitation: invite as never,
          key: '',
          member: '',
          grant: '',
          expires: 0,
        },
      ),
    ).toThrow('quota');
  });
});
