import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  decodeGameInit,
  encodeGameInit,
  decodeGameInput,
  encodeGameInput,
  decodeGameSnapshot,
  encodeGameSnapshot,
  decodeGameEvent,
  encodeGameEvent,
  decodeGameResult,
  encodeGameResult,
  gameResultMessage,
  type GameInit,
  type GameInput,
  type GameSnapshot,
  type GameResult,
} from './game.ts';
import { ProtocolError } from './values.ts';

interface Fixture {
  readonly id: string;
  readonly state: string;
  readonly receiver: 'host' | 'browser';
  readonly wire: { readonly hex?: string };
  readonly expect: { readonly accepted: boolean; readonly error?: string };
}
const corpus = JSON.parse(
  readFileSync(
    new URL('../../../../protocol/fixtures/v1/frames.json', import.meta.url),
    'utf8',
  ),
) as { cases: Fixture[] };
const fixtures = corpus.cases.filter(
  (value) => value.id.startsWith('game-') && value.state === 'active-escape',
);
const text = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value));
const payload = (id: string): Uint8Array =>
  Uint8Array.from(
    Buffer.from(
      corpus.cases.find((value) => value.id === id)!.wire.hex!,
      'hex',
    ),
  ).slice(6);

function roundTrip(
  type: number,
  bytes: Uint8Array,
  sender: 'host' | 'browser',
): Uint8Array {
  switch (type) {
    case 0x20:
      return encodeGameInit(decodeGameInit(bytes));
    case 0x21:
      return encodeGameInput(decodeGameInput(bytes));
    case 0x22:
      return encodeGameSnapshot(decodeGameSnapshot(bytes));
    case 0x23:
      return encodeGameEvent(decodeGameEvent(bytes, sender), sender);
    case 0x24:
      return encodeGameResult(decodeGameResult(bytes));
    default:
      throw new Error('invalid test message');
  }
}

describe('typed Escape wire payloads', () => {
  it('uses every shared game fixture and re-encodes canonical bytes', () => {
    const seen = new Set<number>();
    for (const fixture of fixtures) {
      const wire = Uint8Array.from(Buffer.from(fixture.wire.hex!, 'hex'));
      const operation = () =>
        roundTrip(
          wire[4]!,
          wire.slice(6),
          fixture.receiver === 'host' ? 'browser' : 'host',
        );
      if (!fixture.expect.accepted) {
        expect(operation, fixture.id).toThrowError(
          expect.objectContaining({ code: fixture.expect.error }),
        );
      } else {
        expect(operation(), fixture.id).toEqual(wire.slice(6));
        seen.add(wire[4]!);
      }
    }
    expect([...seen].sort((left, right) => left - right)).toEqual([
      0x20, 0x21, 0x22, 0x23, 0x24,
    ]);
  });

  it('bounds decoding before parsing and returns only classified failures', () => {
    for (let type = 0x20; type <= 0x24; type += 1) {
      for (const size of [0, 1, 2, 23, 25, 43, 45, 16_385]) {
        expect(() =>
          roundTrip(type, new Uint8Array(size).fill(32), 'host'),
        ).toThrow(ProtocolError);
      }
    }
    expect(() =>
      decodeGameEvent(payload('game-event-countdown'), 'unknown' as 'host'),
    ).toThrow(ProtocolError);
  });

  it('accepts integral JSON spellings and rejects null or missing point fields', () => {
    const initial = new TextDecoder().decode(payload('game-init-canonical'));
    const alternate = initial
      .replace('"width":48', '"width":4.8e1')
      .replace('"round_duration_ms":45000', '"round_duration_ms":45000.0');
    expect(
      decodeGameInit(new TextEncoder().encode(alternate)).round_duration_ms,
    ).toBe(45000);
    for (const replacement of [
      '"mouse":null',
      '"mouse":{"x":3.5}',
      '"mouse":{"x":3.5,"y":null}',
      '"mouse":{"x":48,"y":3.5}',
      '"mouse":{"x":-1,"y":3.5}',
    ]) {
      expect(() =>
        decodeGameInit(
          new TextEncoder().encode(
            initial.replace('"mouse":{"x":3.5,"y":3.5}', replacement),
          ),
        ),
      ).toThrow(ProtocolError);
    }
  });

  it('never exposes mutable source bytes or initial-world state', () => {
    const bytes = payload('game-init-canonical');
    const initial = decodeGameInit(bytes);
    bytes.fill(0);
    expect(initial.mouse).toEqual({ x: 3.5, y: 3.5 });
    for (const value of [
      initial,
      initial.map,
      initial.map.rows,
      initial.mouse,
      initial.cat,
      initial.cheeses,
      initial.cheeses[0],
      initial.exit,
      initial.constants,
      initial.presentation,
    ]) {
      expect(Object.isFrozen(value)).toBe(true);
    }
    expect(() => {
      (initial.mouse as { x: number }).x = 99;
    }).toThrow(TypeError);
    expect(decodeGameInit(payload('game-init-canonical')).mouse.x).toBe(3.5);
  });

  it('preserves all u64 bits, f32 values, flags and snapshot phases', () => {
    for (const timestamp of [0n, 1n, (1n << 53n) + 1n, (1n << 64n) - 1n]) {
      for (const sequence of [1, 300, 0xffffffff]) {
        for (const dash of [false, true]) {
          const value: GameInput = {
            sequence,
            clientTimeMS: timestamp,
            velocityX: Math.fround(0.6),
            velocityY: Math.fround(-0.8),
            dash,
          };
          const bytes = encodeGameInput(value),
            decoded = decodeGameInput(bytes);
          expect(decoded).toEqual(value);
          bytes.fill(0);
          expect(decoded).toEqual(value);
          expect(Object.isFrozen(decoded)).toBe(true);
        }
        for (let collectedMask = 0; collectedMask < 4; collectedMask += 1) {
          for (const phase of [0, 1, 2]) {
            const value: GameSnapshot = {
              sequence,
              acceptedInputSequence: 0,
              elapsedMS: timestamp,
              mouse: { x: 3.5, y: 3.5 },
              cat: { x: 40.5, y: 14.5 },
              remainingMS: 0,
              dashCooldownMS: 0,
              collectedMask,
              phase,
              exitOpen: collectedMask === 3,
            };
            expect(decodeGameSnapshot(encodeGameSnapshot(value))).toEqual(
              value,
            );
          }
        }
      }
    }
  });

  it('rejects binary encoder values before integer truncation or f32 overflow', () => {
    const input = decodeGameInput(payload('game-input-full-u64'));
    for (const patch of [
      { sequence: 0 },
      { sequence: 0x100000000 },
      { sequence: 1.2 },
      { clientTimeMS: -1n },
      { clientTimeMS: 1n << 64n },
      { velocityX: Infinity },
      { velocityX: NaN },
      { velocityX: 1, velocityY: 1 },
      { dash: null },
    ]) {
      expect(() =>
        encodeGameInput({ ...input, ...patch } as GameInput),
      ).toThrow(ProtocolError);
    }
    const snapshot = decodeGameSnapshot(payload('game-snapshot-full-u64'));
    for (const patch of [
      { sequence: 0 },
      { acceptedInputSequence: -1 },
      { elapsedMS: -1n },
      { elapsedMS: 1n << 64n },
      { remainingMS: 45001 },
      { dashCooldownMS: 5001 },
      { collectedMask: 4 },
      { phase: 3 },
      { exitOpen: false },
      { mouse: { x: 47.999999999, y: 3.5 } },
      { mouse: { x: -1, y: 0 } },
      { cat: { x: NaN, y: 0 } },
    ]) {
      expect(() => encodeGameSnapshot({ ...snapshot, ...patch })).toThrow(
        ProtocolError,
      );
    }
  });

  it('rejects noncanonical result prose and illegal outbound JSON without leaking it', () => {
    const initial = decodeGameInit(payload('game-init-canonical'));
    const invalid = { ...initial, seed: 'untrusted-peer-text' };
    expect(() => encodeGameInit(invalid)).toThrowError(
      expect.objectContaining({
        message: expect.not.stringContaining(invalid.seed),
      }),
    );
    expect(() =>
      encodeGameInit({ ...initial, mouse: { x: NaN, y: 3.5 } }),
    ).toThrow(ProtocolError);
    const cyclic = { ...initial, map: {} };
    cyclic.map = cyclic;
    expect(() => encodeGameInit(cyclic as unknown as GameInit)).toThrow(
      ProtocolError,
    );
    expect(() =>
      encodeGameEvent(
        { sequence: 1, event: 'exit_requested', value: null },
        'host',
      ),
    ).toThrow(ProtocolError);
    const result = decodeGameResult(payload('game-result-escaped'));
    expect(() =>
      encodeGameResult({ ...result, message: 'untrusted-peer-text' }),
    ).toThrowError(
      expect.objectContaining({
        message: expect.not.stringContaining('untrusted-peer-text'),
      }),
    );
    expect(() => encodeGameResult({ ...result, elapsed_ms: NaN })).toThrow(
      ProtocolError,
    );
    expect(gameResultMessage('unknown', 0)).toBe('');
    for (const field of ['elapsed_ms', 'rtt_p50_ms', 'rtt_p95_ms']) {
      expect(() => decodeGameResult(text({ ...result, [field]: '0' }))).toThrow(
        ProtocolError,
      );
    }
    const largest: GameResult = {
      ...result,
      elapsed_ms: Number.MAX_SAFE_INTEGER,
      rtt_p50_ms: Number.MAX_SAFE_INTEGER,
      rtt_p95_ms: Number.MAX_SAFE_INTEGER,
      jitter_ms: null,
      relay: 'official',
      message: gameResultMessage('escaped', Number.MAX_SAFE_INTEGER),
    };
    expect(decodeGameResult(encodeGameResult(largest))).toEqual(largest);
  });

  it('property-checks bounded arbitrary and mutated payloads', () => {
    let state = 0x544d4f55;
    const next = () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state;
    };
    const seeds = [
      'game-init-canonical',
      'game-input-full-u64',
      'game-snapshot-full-u64',
      'game-event-countdown',
      'game-result-escaped',
    ].map(payload);
    for (let index = 0; index < 1024; index += 1) {
      const type = 0x20 + (index % 5);
      const bytes =
        index % 2 === 0
          ? seeds[index % 5]!.slice()
          : new Uint8Array(next() % 256);
      for (
        let mutation = 0;
        mutation < 4 && bytes.byteLength > 0;
        mutation += 1
      )
        bytes[next() % bytes.byteLength] = next() & 0xff;
      try {
        const canonical = roundTrip(
          type,
          bytes,
          type === 0x21 ? 'browser' : 'host',
        );
        expect(canonical.byteLength).toBeLessThanOrEqual(16384);
        expect(
          roundTrip(type, canonical, type === 0x21 ? 'browser' : 'host'),
        ).toEqual(canonical);
      } catch (error) {
        expect(error).toBeInstanceOf(ProtocolError);
        expect((error as ProtocolError).message).not.toContain(
          'untrusted-peer-text',
        );
      }
    }
  });
});
