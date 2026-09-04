import { describe, expect, it } from 'vitest';
import { ProtocolError } from './values.ts';
import {
  decodeTermReset,
  decodeProcessControl,
  decodeProcessState,
  decodeOutputDropped,
  encodeProcessControl,
} from './terminal.ts';

const bytes = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value));

describe('terminal payloads', () => {
  it('preserves full native exit values and rejects invalid integer widths', () => {
    const state = {
      generation: 1,
      state: 'exited',
      pid: null,
      started_at: null,
      exit_code: null,
      signal: null,
    };
    for (const exit_code of [
      0, 255, 256, 259, 65535, 0xc000_013a, 0xffff_ffff,
    ]) {
      expect(decodeProcessState(bytes({ ...state, exit_code })).exit_code).toBe(
        exit_code,
      );
    }
    for (const exit_code of [
      -1,
      1.5,
      0x1_0000_0000,
      Number.MAX_SAFE_INTEGER,
      '37',
    ]) {
      expect(() =>
        decodeProcessState(bytes({ ...state, exit_code })),
      ).toThrowError(new ProtocolError('BAD_FRAME'));
    }
  });

  it('returns bounded immutable values without retaining an input buffer', () => {
    const cases = [
      [decodeTermReset, { generation: 1, cols: 80, rows: 24 }],
      [decodeProcessControl, { generation: 1, action: 'interrupt' }],
      [
        decodeProcessState,
        {
          generation: 2,
          state: 'exited',
          pid: 42,
          started_at: 123,
          exit_code: 130,
          signal: 'SIGINT',
          title: '<terminal> 🐈',
        },
      ],
      [
        decodeOutputDropped,
        { generation: 2, dropped_bytes: Number.MAX_SAFE_INTEGER },
      ],
    ] as const;
    for (const [decode, value] of cases) {
      const input = bytes(value);
      const decoded = decode(input);
      input.fill(0);
      expect(decoded).toEqual(value);
      expect(Object.isFrozen(decoded)).toBe(true);
      for (const malformed of [
        new Uint8Array(),
        new Uint8Array(1025),
        bytes({ ...value, secret: 'not retained' }),
      ]) {
        expect(() => decode(malformed)).toThrowError(
          new ProtocolError('BAD_FRAME'),
        );
      }
    }
  });

  it('encodes only a validated action and positive generation', () => {
    for (const action of ['interrupt', 'restart', 'terminate'] as const) {
      const value = { generation: 0xffff_ffff, action };
      expect(decodeProcessControl(encodeProcessControl(value))).toEqual(value);
    }
    expect(() =>
      encodeProcessControl({ generation: 0, action: 'interrupt' }),
    ).toThrowError(new ProtocolError('BAD_FRAME'));
    expect(() =>
      decodeProcessControl(bytes({ generation: 1, action: 'exec' })),
    ).toThrowError(new ProtocolError('BAD_FRAME'));
    expect(() =>
      decodeProcessState(
        bytes({
          generation: 1,
          state: 'running',
          pid: null,
          started_at: null,
          exit_code: null,
          signal: 3,
        }),
      ),
    ).toThrowError(new ProtocolError('BAD_FRAME'));
  });

  it('accepts optional plain-text titles with decoded UTF-8 byte bounds', () => {
    const state = {
      generation: 1,
      state: 'waiting',
      pid: null,
      started_at: null,
      exit_code: null,
      signal: null,
    };
    expect(decodeProcessState(bytes(state))).toEqual(state);
    for (const title of [
      'terminal',
      '<terminal> 🐈',
      'x'.repeat(256),
      '🐈'.repeat(64),
      '\ud800',
    ]) {
      const decoded = decodeProcessState(bytes({ ...state, title }));
      expect(decoded.title).toBe(title.toWellFormed());
      expect(Object.isFrozen(decoded)).toBe(true);
    }
    for (const title of [
      '',
      null,
      42,
      'x'.repeat(257),
      '🐈'.repeat(65),
      'bad\u001b[2J',
      'bad\u009b2J',
    ]) {
      expect(() => decodeProcessState(bytes({ ...state, title }))).toThrowError(
        new ProtocolError('BAD_FRAME'),
      );
    }
  });
});
