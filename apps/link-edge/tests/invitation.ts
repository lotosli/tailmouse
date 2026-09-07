import { encode } from 'cborg';
import { ORIGIN, base64url } from '../src/api.ts';

export function invitation(overrides: Record<string, unknown> = {}): string {
  return `${ORIGIN}/#/v1/${base64url(encode({ a: 2, e: 0, m: 'leash', p: 44321, s: new Uint8Array(16).fill(7), t: 'synthetic-redacted-address', v: 1, z: 2, ...overrides }))}`;
}
