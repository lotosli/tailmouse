import { decode } from 'cborg';

const MAX_INVITATION_BYTES = 1400;
const CARD_KEYS = ['a', 'e', 'm', 'p', 's', 't', 'v', 'z'] as const;

export type InvitationMode = 'escape' | 'leash';

export interface SpikeInvitation {
  readonly mode: InvitationMode;
  readonly address: string;
}

export class InvitationError extends Error {
  constructor() {
    super(
      'This invitation is invalid or unsupported. Request a new link from the host.',
    );
    this.name = 'InvitationError';
  }
}

// consumeInvitation removes the credential from visible history before it
// attempts any decoding. It returns only the two values needed by the M0 spike.
export function consumeInvitation(): SpikeInvitation {
  const fragment = location.hash;
  const invitationBytes = new TextEncoder().encode(location.href).byteLength;
  history.replaceState(null, '', location.pathname + location.search);
  if (invitationBytes >= MAX_INVITATION_BYTES) {
    throw new InvitationError();
  }
  return parseFragment(fragment);
}

export function parseFragment(fragment: string): SpikeInvitation {
  const prefix = '#/v1/';
  if (!fragment.startsWith(prefix)) {
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
    payload = Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  } catch {
    throw new InvitationError();
  }

  try {
    const card: unknown = decode(payload, {
      allowBigInt: false,
      allowIndefinite: false,
      allowUndefined: false,
      rejectDuplicateMapKeys: true,
      strict: true,
    });
    if (!isSpikeCard(card)) {
      throw new InvitationError();
    }
    return { address: card.t, mode: card.m };
  } catch {
    throw new InvitationError();
  } finally {
    payload.fill(0);
  }
}

type CardRecord = Record<(typeof CARD_KEYS)[number], unknown>;

function isSpikeCard(value: unknown): value is CardRecord & {
  m: InvitationMode;
  t: string;
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
    (card.m === 'escape' || card.m === 'leash') &&
    typeof card.t === 'string' &&
    card.t.length > 0 &&
    card.p === 44321 &&
    card.s instanceof Uint8Array &&
    card.s.byteLength === 16 &&
    typeof card.e === 'number' &&
    Number.isSafeInteger(card.e) &&
    card.e >= 0 &&
    card.a === 1 &&
    card.z === 1
  );
}
