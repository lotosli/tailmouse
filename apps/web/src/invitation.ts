import { decode, encode } from 'cborg';

const MAX_INVITATION_BYTES = 1400;
const MAX_CARD_BYTES = 1050;
const CARD_KEYS = ['a', 'e', 'm', 'p', 's', 't', 'v', 'z'] as const;

export type InvitationMode = 'leash';

export interface MouseCard {
  readonly version: 1;
  readonly mode: InvitationMode;
  readonly address: string;
  readonly port: 44321;
  readonly sessionID: Uint8Array;
  readonly expiresAt: number;
  readonly protocolMin: number;
  readonly protocolMax: number;
  // Short locators require a separate Host proof, even if a peer advertises
  // link-only admission. This is local policy, never a MouseCard wire field.
  readonly requiresAccessCode?: true;
}

export interface ShortInvitation {
  readonly shortCode: string;
}

export class InvitationError extends Error {
  constructor(
    readonly code:
      'BAD_MOUSE_CARD' | 'EXPIRED' | 'UNAVAILABLE' = 'BAD_MOUSE_CARD',
  ) {
    super(
      code === 'UNAVAILABLE'
        ? 'This invitation is unavailable. Request a new link from the host.'
        : code === 'EXPIRED'
          ? 'This invitation has expired. Request a new link from the host.'
          : 'This invitation is invalid or unsupported. Request a new link from the host.',
    );
    this.name = 'InvitationError';
  }
}

// consumeInvitation removes the credential from visible history before it
// attempts any decoding. No browser persistence participates in this operation.
export function consumeInvitation(
  nowUnix = Math.floor(Date.now() / 1000),
): MouseCard | ShortInvitation {
  const fragment = location.hash;
  const href = location.href;
  const path = location.pathname;
  const search = location.search;
  const official = new URL(href).origin === 'https://link.tailmouse.com';
  const shortPath = official && path !== '/';
  try {
    history.replaceState(null, '', shortPath ? '/' : path + search);
  } catch {
    throw new InvitationError();
  }
  if (shortPath) {
    if (
      fragment !== '' ||
      search !== '' ||
      !/^\/[0-9A-Za-z]{6}$/u.test(path) ||
      href !== `https://link.tailmouse.com${path}`
    )
      throw new InvitationError('UNAVAILABLE');
    return { shortCode: path.slice(1) };
  }
  if (
    href.length >= MAX_INVITATION_BYTES ||
    new TextEncoder().encode(href).byteLength >= MAX_INVITATION_BYTES
  ) {
    throw new InvitationError();
  }
  return parseFragment(fragment, nowUnix);
}

export function parseFragment(
  fragment: string,
  nowUnix = Math.floor(Date.now() / 1000),
): MouseCard {
  const prefix = '#/v1/';
  if (fragment.length >= MAX_INVITATION_BYTES || !fragment.startsWith(prefix)) {
    throw new InvitationError();
  }
  const encoded = fragment.slice(prefix.length);
  if (encoded.length === 0 || !/^[A-Za-z0-9_-]+$/.test(encoded)) {
    throw new InvitationError();
  }

  let payload: Uint8Array;
  try {
    const base64 = encoded.replaceAll('-', '+').replaceAll('_', '/');
    const decoded = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='));
    if (
      decoded.length > MAX_CARD_BYTES ||
      btoa(decoded)
        .replaceAll('+', '-')
        .replaceAll('/', '_')
        .replaceAll('=', '') !== encoded
    ) {
      throw new InvitationError();
    }
    payload = Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  } catch {
    throw new InvitationError();
  }

  try {
    if (payload[0] !== 0xa8) throw new InvitationError();
    const card: unknown = decode(payload, {
      allowBigInt: false,
      allowIndefinite: false,
      allowUndefined: false,
      rejectDuplicateMapKeys: true,
      strict: true,
    });
    if (!isMouseCard(card)) {
      throw new InvitationError();
    }
    const canonical = encode(card);
    const matches =
      canonical.length === payload.length &&
      canonical.every((byte, index) => byte === payload[index]);
    canonical.fill(0);
    if (!matches) throw new InvitationError();
    if (card.e !== 0 && nowUnix >= card.e) throw new InvitationError('EXPIRED');
    return {
      address: card.t,
      expiresAt: card.e,
      mode: card.m,
      port: card.p,
      protocolMax: card.z,
      protocolMin: card.a,
      sessionID: card.s.slice(),
      version: card.v,
    };
  } catch (error: unknown) {
    if (error instanceof InvitationError) throw error;
    throw new InvitationError();
  } finally {
    payload.fill(0);
  }
}

type CardRecord = Record<(typeof CARD_KEYS)[number], unknown>;

function isMouseCard(value: unknown): value is CardRecord & {
  a: 1 | 2;
  e: number;
  m: InvitationMode;
  p: 44321;
  s: Uint8Array;
  t: string;
  v: 1;
  z: 1 | 2;
} {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const card = value as Partial<CardRecord>;
  const keys = Object.keys(value).sort();
  return (
    keys.length === CARD_KEYS.length &&
    keys.every((key, index) => key === CARD_KEYS[index]) &&
    card.v === 1 &&
    card.m === 'leash' &&
    typeof card.t === 'string' &&
    card.t.length > 0 &&
    card.p === 44321 &&
    card.s instanceof Uint8Array &&
    card.s.byteLength === 16 &&
    card.s.some((byte) => byte !== 0) &&
    typeof card.e === 'number' &&
    Number.isSafeInteger(card.e) &&
    card.e >= 0 &&
    (card.m === 'leash' && card.a === 2 && card.z === 2)
  );
}
