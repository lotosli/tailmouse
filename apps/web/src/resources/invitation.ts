import { strictObject } from '../protocol/values.ts';
export interface ResourceInvitation {
  v: 1;
  session: string;
  address: string;
  token: string;
  frontend_major: 1;
}
export interface Recovery {
  invitation: ResourceInvitation;
  key: string;
  member: string;
  grant: string;
  expires: number;
}
const storageKey = 'tailmouse.resource.v1';
export function parseResourceInvitation(
  fragment: string,
  hostname: string,
  testEntry = false,
): ResourceInvitation {
  if (
    !fragment.startsWith('#tm=') ||
    fragment.length > 43700 ||
    !/^[A-Za-z0-9_-]+$/u.test(fragment.slice(4))
  )
    throw new Error('Invalid sharing invitation.');
  const raw = atob(fragment.slice(4).replaceAll('-', '+').replaceAll('_', '/'));
  const bytes = Uint8Array.from(raw, (c) => c.charCodeAt(0));
  if (bytes.length > 32768) throw new Error('Invitation is too large.');
  const value = strictObject(bytes);
  if (
    Object.keys(value).sort().join(',') !==
      'address,frontend_major,session,token,v' ||
    value.v !== 1 ||
    value.frontend_major !== 1 ||
    typeof value.session !== 'string' ||
    !/^[a-f0-9]{32}$/u.test(value.session) ||
    typeof value.token !== 'string' ||
    !/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u.test(value.token) ||
    typeof value.address !== 'string' ||
    value.address.length === 0 ||
    value.address.length > 24000 ||
    (!testEntry && !hostname.startsWith(`s-${value.session}.`))
  )
    throw new Error('Invitation version or origin is incompatible.');
  return value as unknown as ResourceInvitation;
}
export function consumeRecovery(
  location: Pick<Location, 'hash' | 'hostname' | 'pathname' | 'search'>,
  history: Pick<History, 'replaceState'>,
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>,
): Recovery | null {
  const fragment = location.hash;
  if (fragment !== '')
    history.replaceState(null, '', location.pathname + location.search);
  if (fragment.startsWith('#tm=')) {
    storage.removeItem(storageKey);
    const invitation = parseResourceInvitation(
      fragment,
      location.hostname,
      location.pathname === '/.tailmouse/workspace/',
    );
    const state = { invitation, key: '', member: '', grant: '', expires: 0 };
    saveRecovery(storage, state);
    return state;
  }
  const saved = storage.getItem(storageKey);
  if (saved === null) return null;
  try {
    if (saved.length > 45000) throw new Error('Recovery too large.');
    const value = JSON.parse(saved) as Recovery;
    const fragment =
      '#tm=' +
      btoa(JSON.stringify(value.invitation))
        .replaceAll('+', '-')
        .replaceAll('/', '_')
        .replace(/=+$/u, '');
    parseResourceInvitation(
      fragment,
      location.hostname,
      location.pathname === '/.tailmouse/workspace/',
    );
    if (
      typeof value.key !== 'string' ||
      value.key.length > 512 ||
      typeof value.member !== 'string' ||
      (value.member !== '' && !/^[a-f0-9]{32}$/u.test(value.member)) ||
      typeof value.grant !== 'string' ||
      (value.grant !== '' &&
        !/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u.test(value.grant)) ||
      !Number.isSafeInteger(value.expires) ||
      (value.expires !== 0 && value.expires <= Date.now())
    )
      throw new Error('Recovery expired.');
    return value;
  } catch {
    storage.removeItem(storageKey);
    return null;
  }
}
export function saveRecovery(
  storage: Pick<Storage, 'setItem'>,
  recovery: Recovery,
): void {
  storage.setItem(storageKey, JSON.stringify(recovery));
}
export function eraseRecovery(storage: Pick<Storage, 'removeItem'>): void {
  storage.removeItem(storageKey);
}
