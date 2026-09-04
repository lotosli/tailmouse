import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

import type { ByteStream } from '../transport/tailcat/adapter.ts';
import {
  encodeFrame,
  FrameDecoder,
  MAX_FRAME_LENGTH,
  MAX_TERMINAL_PAYLOAD,
  Message,
  messageName,
  ProtocolError,
  writeFrame,
  type Frame,
  type MessageType,
  type Peer,
  type ProtocolState,
} from './frame.ts';

const encoder = new TextEncoder();

describe('TMOUSE/1 shared conformance corpus', () => {
  it('decodes every case and re-encodes accepted frames byte for byte', async () => {
    for (const fixture of loadFixtures()) {
      const wire = materialize(fixture.wire);
      const chunks = splitWire(wire, fixture.fragments);
      const stream = fakeStream(chunks);
      const decoder = new FrameDecoder(stream);
      const operation = decoder.read(
        fixture.receiver,
        fixture.state,
        new AbortController().signal,
      );
      if (!fixture.expect.accepted) {
        await expect(operation, fixture.id).rejects.toMatchObject({
          code: fixture.expect.error,
          message: expect.not.stringContaining('synthetic-test-agent'),
        });
        continue;
      }

      const frame = await operation;
      expect(frame, fixture.id).not.toBeNull();
      if (frame === null) throw new Error('accepted fixture ended cleanly');
      expect(messageName(frame.type), fixture.id).toBe(fixture.expect.message);
      expect(frame.selectedProtocol, fixture.id).toBe(
        fixture.expect.selected_protocol,
      );
      const encoded = encodeFrame(
        opposite(fixture.receiver),
        fixture.state,
        frame,
      );
      expect(encoded, fixture.id).toEqual(wire);
      frame.payload.fill(0);
      encoded.fill(0);
      wire.fill(0);
    }
  });

  it('property-checks bounded arbitrary streams without leaking parser internals', async () => {
    let seed = 0x544d4f55;
    const next = (): number => {
      seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
      return seed;
    };
    for (let index = 0; index < 512; index += 1) {
      const wire = new Uint8Array(next() % 128);
      for (let offset = 0; offset < wire.byteLength; offset += 1) {
        wire[offset] = next() & 0xff;
      }
      if (wire.byteLength >= 6 && index % 2 === 0) {
        new DataView(wire.buffer).setUint32(0, wire.byteLength - 4);
        wire[5] = 0;
      }
      try {
        const frame = await new FrameDecoder(fakeStream([wire.slice()])).read(
          'host',
          'active-escape',
          new AbortController().signal,
        );
        if (frame !== null) {
          expect(frame.payload.byteLength).toBeLessThanOrEqual(
            MAX_FRAME_LENGTH - 2,
          );
          expect(() =>
            encodeFrame('browser', 'active-escape', frame),
          ).not.toThrow();
          frame.payload.fill(0);
        }
      } catch (error) {
        expect(error).toBeInstanceOf(ProtocolError);
      }
      wire.fill(0);
    }
  });
});

describe('TMOUSE/1 stream behavior', () => {
  it('retains bounded surplus bytes for the next frame and reports clean EOF', async () => {
    const ping = encodeFrame('host', 'active-escape', {
      type: Message.PING,
      payload: new Uint8Array(16),
    });
    const combined = new Uint8Array(ping.byteLength * 2);
    combined.set(ping);
    combined.set(ping, ping.byteLength);
    const decoder = new FrameDecoder(fakeStream([combined]));
    const signal = new AbortController().signal;
    expect((await decoder.read('browser', 'active-escape', signal))?.type).toBe(
      Message.PING,
    );
    expect((await decoder.read('browser', 'active-escape', signal))?.type).toBe(
      Message.PING,
    );
    await expect(
      decoder.read('browser', 'active-escape', signal),
    ).resolves.toBe(null);
  });

  it('rejects empty chunks, partial headers, concurrent reads, and oversized buffers', async () => {
    const signal = new AbortController().signal;
    await expect(
      new FrameDecoder(fakeStream([new Uint8Array()])).read(
        'host',
        'await-client-hello',
        signal,
      ),
    ).rejects.toMatchObject({ code: 'BAD_FRAME' });
    await expect(
      new FrameDecoder(fakeStream([new Uint8Array([0, 0]), null])).read(
        'host',
        'await-client-hello',
        signal,
      ),
    ).rejects.toMatchObject({ code: 'BAD_FRAME' });
    await expect(
      new FrameDecoder(fakeStream([new Uint8Array(MAX_FRAME_LENGTH + 5)])).read(
        'host',
        'await-client-hello',
        signal,
      ),
    ).rejects.toMatchObject({ code: 'FRAME_TOO_LARGE' });

    let finishRead: ((value: Uint8Array | null) => void) | undefined;
    const pending = fakeStream([], {
      read: () =>
        new Promise<Uint8Array | null>((resolve) => {
          finishRead = resolve;
        }),
    });
    const decoder = new FrameDecoder(pending);
    const first = decoder.read('host', 'await-client-hello', signal);
    await expect(
      decoder.read('host', 'await-client-hello', signal),
    ).rejects.toMatchObject({ code: 'BAD_FRAME' });
    finishRead?.(null);
    await expect(first).resolves.toBeNull();
  });

  it('closes blocked reads and writes on cancellation', async () => {
    const readController = new AbortController();
    let finishRead: ((value: Uint8Array | null) => void) | undefined;
    const readClose = vi.fn(async () => finishRead?.(null));
    const readStream = fakeStream([], {
      close: readClose,
      read: () =>
        new Promise<Uint8Array | null>((resolve) => {
          finishRead = resolve;
        }),
    });
    const reading = new FrameDecoder(readStream).read(
      'host',
      'await-client-hello',
      readController.signal,
    );
    readController.abort();
    await expect(reading).rejects.toMatchObject({ code: 'CANCELED' });
    expect(readClose).toHaveBeenCalledOnce();

    const writeController = new AbortController();
    let finishWrite: (() => void) | undefined;
    const writeClose = vi.fn(async () => finishWrite?.());
    const writeStream = fakeStream([], {
      close: writeClose,
      write: () =>
        new Promise<void>((resolve) => {
          finishWrite = resolve;
        }),
    });
    const writing = writeFrame(
      writeStream,
      'host',
      'active-escape',
      { type: Message.PING, payload: new Uint8Array(16) },
      writeController.signal,
    );
    writeController.abort();
    await expect(writing).rejects.toMatchObject({ code: 'CANCELED' });
    expect(writeClose).toHaveBeenCalledOnce();
  });

  it('writes one frame and redacts stream failures', async () => {
    const stream = fakeStream([]);
    await writeFrame(
      stream,
      'host',
      'active-escape',
      { type: Message.PING, payload: new Uint8Array(16) },
      new AbortController().signal,
    );
    expect(stream.writes).toHaveLength(1);
    expect(stream.writes[0]).toEqual(
      encodeFrame('host', 'active-escape', {
        type: Message.PING,
        payload: new Uint8Array(16),
      }),
    );

    const failure = writeFrame(
      fakeStream([], {
        write: async () => {
          throw new Error('tcCredentialMustNeverEscapeTheBoundary');
        },
      }),
      'host',
      'active-escape',
      { type: Message.PING, payload: new Uint8Array(16) },
      new AbortController().signal,
    );
    await expect(failure).rejects.toEqual(new ProtocolError('INTERNAL'));
  });
});

describe('TMOUSE/1 validation', () => {
  it('keeps JSON number, null, nesting, and f32 boundaries interoperable', () => {
    const hello = JSON.stringify(validHello())
      .replace('"protocol_min":1', '"protocol_min":1e0')
      .replace('"protocol_max":1', '"protocol_max":1.0');
    expect(() =>
      encodeFrame('browser', 'await-client-hello', {
        type: Message.CLIENT_HELLO,
        payload: encoder.encode(hello),
      }),
    ).not.toThrow();
    expect(() => helloFrame({ ...validHello(), terminal: null })).toThrowError(
      expect.objectContaining({ code: 'BAD_FRAME' }),
    );
    expect(() =>
      encodeFrame('host', 'active-escape', {
        type: Message.GAME_INIT,
        payload: encoder.encode(`{"x":${'['.repeat(32)}0${']'.repeat(32)}}`),
      }),
    ).toThrowError(expect.objectContaining({ code: 'BAD_FRAME' }));
    expect(() =>
      encodeFrame('browser', 'active-escape', {
        type: Message.GAME_INPUT,
        payload: validGameInput({ x: 0.6, y: 0.8 }),
      }),
    ).not.toThrow();
  });

  it('exposes the complete fixed registry and rejects unknown types', () => {
    expect(Object.entries(Message)).toHaveLength(18);
    for (const [name, type] of Object.entries(Message)) {
      expect(messageName(type)).toBe(name);
    }
    expect(() => messageName(0xff as MessageType)).toThrowError(
      new ProtocolError('BAD_FRAME'),
    );
  });

  it('rejects wrong direction, mode, size, and invalid binary fields', () => {
    const invalid: Array<{
      frame: Frame;
      sender: Peer;
      state: ProtocolState;
      code: string;
    }> = [
      {
        frame: { type: Message.TERM_INPUT, payload: encoder.encode('a') },
        sender: 'browser',
        state: 'active-escape',
        code: 'MODE_MISMATCH',
      },
      {
        frame: { type: Message.GAME_INPUT, payload: validGameInput() },
        sender: 'browser',
        state: 'active-leash',
        code: 'MODE_MISMATCH',
      },
      {
        frame: { type: Message.PING, payload: new Uint8Array(16) },
        sender: 'host',
        state: 'await-client-hello',
        code: 'BAD_FRAME',
      },
      {
        frame: { type: Message.TERM_INPUT, payload: new Uint8Array() },
        sender: 'browser',
        state: 'active-leash',
        code: 'BAD_FRAME',
      },
      {
        frame: {
          type: Message.TERM_OUTPUT,
          payload: new Uint8Array(MAX_TERMINAL_PAYLOAD + 1),
        },
        sender: 'host',
        state: 'active-leash',
        code: 'FRAME_TOO_LARGE',
      },
      {
        frame: {
          type: Message.TERM_RESIZE,
          payload: Uint8Array.of(0, 19, 0, 4),
        },
        sender: 'browser',
        state: 'active-leash',
        code: 'BAD_FRAME',
      },
      {
        frame: {
          type: Message.GAME_INPUT,
          payload: validGameInput({ sequence: 0 }),
        },
        sender: 'browser',
        state: 'active-escape',
        code: 'BAD_FRAME',
      },
      {
        frame: {
          type: Message.GAME_INPUT,
          payload: validGameInput({ x: 1, y: 1 }),
        },
        sender: 'browser',
        state: 'active-escape',
        code: 'BAD_FRAME',
      },
      {
        frame: {
          type: Message.GAME_INPUT,
          payload: validGameInput({ flags: 2 }),
        },
        sender: 'browser',
        state: 'active-escape',
        code: 'BAD_FRAME',
      },
      {
        frame: {
          type: Message.GAME_SNAPSHOT,
          payload: validGameSnapshot({ sequence: 0 }),
        },
        sender: 'host',
        state: 'active-escape',
        code: 'BAD_FRAME',
      },
      {
        frame: {
          type: Message.GAME_SNAPSHOT,
          payload: validGameSnapshot({ x: 48 }),
        },
        sender: 'host',
        state: 'active-escape',
        code: 'BAD_FRAME',
      },
      {
        frame: {
          type: Message.GAME_SNAPSHOT,
          payload: validGameSnapshot({ flags: 1 }),
        },
        sender: 'host',
        state: 'active-escape',
        code: 'BAD_FRAME',
      },
    ];
    for (const test of invalid) {
      expect(() =>
        encodeFrame(test.sender, test.state, test.frame),
      ).toThrowError(expect.objectContaining({ code: test.code }));
    }
  });

  it('strictly validates nested JSON and handshake fields', () => {
    const invalidJSON = [
      '1',
      '{} {}',
      '{"x":{"a":1,"a":2}}',
      '{"x":[1,]}',
      '{"x":"unterminated}',
      '\uFEFF{}',
    ];
    for (const text of invalidJSON) {
      expect(() =>
        encodeFrame('host', 'active-escape', {
          type: Message.GAME_INIT,
          payload: encoder.encode(text),
        }),
      ).toThrowError(expect.objectContaining({ code: 'BAD_FRAME' }));
    }
    expect(() =>
      encodeFrame('host', 'active-escape', {
        type: Message.GAME_INIT,
        payload: materialize(
          loadFixtures().find(
            (fixture) => fixture.id === 'game-init-canonical',
          )!.wire,
        ).slice(6),
      }),
    ).not.toThrow();

    const hello = validHello();
    for (const mutate of [
      (value: Record<string, unknown>) => (value.protocol_min = 0),
      (value: Record<string, unknown>) => (value.protocol_max = 0),
      (value: Record<string, unknown>) => (value.mode = 'admin'),
      (value: Record<string, unknown>) => (value.session_id = 'ABC'),
      (value: Record<string, unknown>) => (value.extra = true),
      (value: Record<string, unknown>) => (value.client = {}),
      (value: Record<string, unknown>) =>
        (value.terminal = { cols: 19, rows: 4 }),
    ]) {
      const value = structuredClone(hello);
      mutate(value);
      expect(() => helloFrame(value)).toThrowError(
        expect.objectContaining({ code: 'BAD_FRAME' }),
      );
    }
    const incompatible = structuredClone(hello);
    incompatible.protocol_min = 2;
    incompatible.protocol_max = 2;
    expect(() => helloFrame(incompatible)).toThrowError(
      expect.objectContaining({ code: 'PROTOCOL_MISMATCH' }),
    );
  });
});

interface FixtureCase {
  readonly id: string;
  readonly receiver: Peer;
  readonly state: ProtocolState;
  readonly wire: {
    readonly hex?: string;
    readonly prefix_hex?: string;
    readonly repeat_hex?: string;
    readonly repeat_count?: number;
  };
  readonly fragments?: number[];
  readonly expect: {
    readonly accepted: boolean;
    readonly message?: string;
    readonly error?: string;
    readonly selected_protocol?: number;
  };
}

function loadFixtures(): FixtureCase[] {
  const path = new URL(
    '../../../../protocol/fixtures/v1/frames.json',
    import.meta.url,
  );
  const corpus = JSON.parse(readFileSync(path, 'utf8')) as {
    cases: FixtureCase[];
  };
  return corpus.cases;
}

function materialize(wire: FixtureCase['wire']): Uint8Array {
  const hex =
    wire.hex ??
    `${wire.prefix_hex}${wire.repeat_hex?.repeat(wire.repeat_count ?? 0)}`;
  return Uint8Array.from(Buffer.from(hex, 'hex'));
}

function splitWire(wire: Uint8Array, fragments?: number[]): Uint8Array[] {
  if (!fragments) return [wire.slice()];
  const chunks: Uint8Array[] = [];
  let offset = 0;
  for (const size of fragments) {
    chunks.push(wire.slice(offset, offset + size));
    offset += size;
  }
  return chunks;
}

function fakeStream(
  chunks: Array<Uint8Array | null>,
  overrides: Partial<ByteStream> = {},
): ByteStream & { writes: Uint8Array[] } {
  const writes: Uint8Array[] = [];
  return {
    close: overrides.close ?? (async () => {}),
    read: overrides.read ?? (async () => chunks.shift() ?? null),
    write:
      overrides.write ??
      (async (value) => {
        writes.push(value.slice());
      }),
    writes,
  };
}

function opposite(peer: Peer): Peer {
  return peer === 'host' ? 'browser' : 'host';
}

function validGameInput(
  options: { sequence?: number; x?: number; y?: number; flags?: number } = {},
): Uint8Array {
  const payload = new Uint8Array(24);
  const view = new DataView(payload.buffer);
  view.setUint32(0, options.sequence ?? 1);
  view.setFloat32(12, options.x ?? 0.75);
  view.setFloat32(16, options.y ?? -0.25);
  payload[20] = options.flags ?? 0;
  return payload;
}

function validGameSnapshot(
  options: { sequence?: number; x?: number; flags?: number } = {},
): Uint8Array {
  const payload = new Uint8Array(44);
  const view = new DataView(payload.buffer);
  view.setUint32(0, options.sequence ?? 1);
  view.setFloat32(16, options.x ?? 4.5);
  view.setFloat32(20, 3.5);
  view.setFloat32(24, 10.5);
  view.setFloat32(28, 7.5);
  payload[41] = 1;
  payload[42] = options.flags ?? 0;
  return payload;
}

function validHello(): Record<string, unknown> {
  return {
    protocol_min: 1,
    protocol_max: 1,
    session_id: '000102030405060708090a0b0c0d0e0f',
    mode: 'escape',
    client: {
      name: 'tailmouse-web',
      version: '0.1.0',
      platform: 'test',
      user_agent: '',
    },
  };
}

function helloFrame(value: Record<string, unknown>): Uint8Array {
  return encodeFrame('browser', 'await-client-hello', {
    type: Message.CLIENT_HELLO,
    payload: encoder.encode(JSON.stringify(value)),
  });
}
