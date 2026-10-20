import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BUILD } from '../build.ts';

const fixtureURL = new URL(
  '../../../../protocol/fixtures/v1/frames.json',
  import.meta.url,
);
const categories = [
  'boundary',
  'compatibility',
  'fragmented',
  'illegal-state',
  'malformed',
  'oversized',
  'valid',
] as const;
const receivers = ['browser', 'host'];
const states = [
  'active-leash',
  'active-leash',
  'await-auth-proof',
  'await-client-hello',
  'await-server-welcome',
];
const credentialPatterns = [
  /\btc[A-Za-z0-9_-]{40,}\b/u,
  /nodekey:|discokey:|private key|#\/v1\//iu,
];

describe('shared TMOUSE/1 frame fixtures', () => {
  it('reports mode-specific protocol identifiers without a continuous range', () => {
    expect(BUILD.protocols).toEqual({ leash: 2, resource: 2 });
    expect(BUILD).not.toHaveProperty('protocolMin');
    expect(BUILD).not.toHaveProperty('protocolMax');
  });

  it('uses the bounded v1 schema and contains every required category', () => {
    const raw = readFileSync(fixtureURL);
    expect(raw.byteLength).toBeLessThanOrEqual(256 * 1024);
    const corpus: unknown = JSON.parse(raw.toString('utf8'));
    expect(isRecord(corpus) && Object.keys(corpus).sort()).toEqual([
      'cases',
      'schema',
    ]);
    if (!isRecord(corpus)) throw new Error('invalid fixture corpus');
    expect(corpus.schema).toBe('tailmouse.tmouse-fixtures/v1');
    expect(Array.isArray(corpus.cases)).toBe(true);
    if (!Array.isArray(corpus.cases)) throw new Error('invalid fixture cases');

    const seenIDs = new Set<string>();
    const seenCategories = new Set<string>();
    for (const value of corpus.cases) {
      const fixture = validateFixture(value);
      expect(seenIDs.has(fixture.id)).toBe(false);
      seenIDs.add(fixture.id);
      seenCategories.add(fixture.category);

      const wire = materialize(fixture.wire);
      expect(wire.byteLength).toBeLessThanOrEqual(32_772);
      if (fixture.expect.accepted) {
        expect(wire.byteLength).toBeGreaterThanOrEqual(6);
        expect(new DataView(wire.buffer).getUint32(0)).toBe(
          wire.byteLength - 4,
        );
      }
      if (fixture.fragments) {
        expect(fixture.fragments.every((size) => size > 0)).toBe(true);
        expect(fixture.fragments.reduce((sum, size) => sum + size, 0)).toBe(
          wire.byteLength,
        );
      }
      expectCredentialFree(fixture.id, wire);
    }
    expect([...seenCategories].sort()).toEqual(categories);
    expectCredentialFree('raw corpus', raw);
  });
});

interface Fixture {
  readonly id: string;
  readonly category: string;
  readonly receiver: string;
  readonly state: string;
  readonly wire: Record<string, unknown>;
  readonly fragments?: number[];
  readonly expect: { readonly accepted: boolean };
}

function validateFixture(value: unknown): Fixture {
  if (!isRecord(value)) throw new Error('invalid fixture');
  const expectedKeys = [
    'category',
    'description',
    'expect',
    ...(value.fragments === undefined ? [] : ['fragments']),
    'id',
    'receiver',
    'state',
    'wire',
  ].sort();
  expect(Object.keys(value).sort()).toEqual(expectedKeys);
  expect(value.id).toMatch(/^[a-z0-9-]+$/u);
  expect(categories).toContain(value.category);
  expect(receivers).toContain(value.receiver);
  expect(states).toContain(value.state);
  expect(value.description).toEqual(expect.any(String));
  expect(isRecord(value.wire)).toBe(true);
  expect(isRecord(value.expect)).toBe(true);
  if (!isRecord(value.wire) || !isRecord(value.expect)) {
    throw new Error('invalid fixture fields');
  }
  expect(typeof value.expect.accepted).toBe('boolean');
  if (value.expect.accepted) {
    expect(Object.keys(value.expect).sort()).toEqual([
      'accepted',
      'message',
      ...(value.expect.selected_protocol === undefined
        ? []
        : ['selected_protocol']),
    ]);
    expect(value.expect.message).toEqual(expect.any(String));
    expect(value.expect.error).toBeUndefined();
    if (value.expect.selected_protocol !== undefined) {
      expect([1, 2]).toContain(value.expect.selected_protocol);
    }
  } else {
    expect(Object.keys(value.expect).sort()).toEqual(['accepted', 'error']);
    expect(value.expect.error).toEqual(expect.any(String));
    expect(value.expect.message).toBeUndefined();
  }
  if (value.fragments !== undefined) {
    expect(
      Array.isArray(value.fragments) &&
        value.fragments.every(Number.isSafeInteger),
    ).toBe(true);
  }
  return value as unknown as Fixture;
}

function materialize(wire: Record<string, unknown>): Uint8Array {
  if (typeof wire.hex === 'string') {
    expect(Object.keys(wire)).toEqual(['hex']);
    expect(wire.hex).toMatch(/^(?:[0-9a-f]{2})+$/u);
    const decoded = Uint8Array.from(Buffer.from(wire.hex, 'hex'));
    expect(Buffer.from(decoded).toString('hex')).toBe(wire.hex);
    return decoded;
  }
  expect(Object.keys(wire).sort()).toEqual([
    'prefix_hex',
    'repeat_count',
    'repeat_hex',
  ]);
  expect(wire.prefix_hex).toEqual(expect.any(String));
  expect(wire.repeat_hex).toMatch(/^[0-9a-f]{2}$/u);
  expect(Number.isSafeInteger(wire.repeat_count)).toBe(true);
  if (
    typeof wire.prefix_hex !== 'string' ||
    typeof wire.repeat_hex !== 'string' ||
    typeof wire.repeat_count !== 'number' ||
    wire.repeat_count <= 0 ||
    wire.repeat_count > 32_766
  ) {
    throw new Error('invalid fixture template');
  }
  return Uint8Array.from(
    Buffer.from(
      wire.prefix_hex + wire.repeat_hex.repeat(wire.repeat_count),
      'hex',
    ),
  );
}

function expectCredentialFree(name: string, value: Uint8Array) {
  const text = Buffer.from(value).toString('utf8');
  for (const pattern of credentialPatterns) {
    expect(pattern.test(text), `${name} contains credential-shaped data`).toBe(
      false,
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
