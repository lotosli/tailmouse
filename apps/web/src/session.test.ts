import { afterEach, describe, expect, it, vi } from 'vitest';

import type { MouseCard } from './invitation.ts';
import {
  authChallengeFrame,
  closeFrame,
  decodeAuthProof,
  encodeFrame,
  errorFrame,
  Message,
  type Frame,
} from './protocol/frame.ts';
import {
  canonicalAccessCode,
  connectSession,
  createAccessProof,
  negotiateSession,
} from './session.ts';
import type { ByteStream, LoadOptions } from './transport/tailcat/adapter.ts';

const adapter = vi.hoisted(() => ({
  dialTailcat: vi.fn(),
  loadTailcat: vi.fn(),
}));
vi.mock('./transport/tailcat/adapter.ts', async (original) => ({
  ...(await original()),
  ...adapter,
}));

const card: MouseCard = {
  address: 'tcSyntheticSessionCredential',
  expiresAt: 0,
  mode: 'leash',
  port: 44321,
  protocolMax: 2,
  protocolMin: 2,
  sessionID: new Uint8Array(16).fill(7),
  version: 1,
};

afterEach(() => {
  vi.resetAllMocks();
  vi.useRealTimers();
});

describe('Access proof', () => {
  it('canonicalizes only ASCII case, spaces, and hyphens', () => {
    for (const input of [
      '23456789ABCDEFGH',
      '2345-6789-ABCD-EFGH',
      ' 2345 6789 abcd efgh ',
    ]) {
      expect(canonicalAccessCode(input)).toBe('23456789ABCDEFGH');
    }
    for (const input of [
      '23456789ABCDEFG',
      '23456789ABCDEFGHH',
      '23456789ABCDEFIH',
      '23456789ABCDEF0H',
      '2345_6789_ABCD_EFGH',
      '2345\t6789 ABCD EFGH',
      '２３４５６７８９ＡＢＣＤＥＦＧＨ',
    ]) {
      expect(() => canonicalAccessCode(input), input).toThrow(
        expect.objectContaining({ code: 'AUTH_FAILED' }),
      );
    }
  });

  it('matches the protocol vector and binds proofs to the session and fresh challenge', async () => {
    const sessionID = Uint8Array.from({ length: 16 }, (_, index) => index);
    const challenge = Uint8Array.from({ length: 32 }, (_, index) => index);
    const proof = await createAccessProof(
      '2345-6789-abcd-efgh',
      sessionID,
      challenge,
    );
    expect(Buffer.from(proof).toString('base64url')).toBe(
      'V0OMGOWhH9n8r-cwHjkH06dDCyNQrZQgrlxJXDmzl4s',
    );
    const otherSession = sessionID.slice();
    otherSession[0]! ^= 1;
    const otherChallenge = challenge.slice();
    otherChallenge[31]! ^= 1;
    const crossSession = await createAccessProof(
      '23456789ABCDEFGH',
      otherSession,
      challenge,
    );
    const freshChallenge = await createAccessProof(
      '23456789ABCDEFGH',
      sessionID,
      otherChallenge,
    );
    expect(crossSession).not.toEqual(proof);
    expect(freshChallenge).not.toEqual(proof);
    expect(proof).toEqual(
      await createAccessProof('23456789ABCDEFGH', sessionID, challenge),
    );
  });

  it('rejects malformed binding inputs before invoking Web Crypto', async () => {
    await expect(
      createAccessProof(
        '23456789ABCDEFGH',
        new Uint8Array(15),
        new Uint8Array(32),
      ),
    ).rejects.toMatchObject({ code: 'BAD_FRAME' });
    await expect(
      createAccessProof(
        '23456789ABCDEFGH',
        new Uint8Array(16),
        new Uint8Array(31),
      ),
    ).rejects.toMatchObject({ code: 'BAD_FRAME' });
  });

  it('answers one protected Leash challenge before accepting Welcome', async () => {
    const challenge = Uint8Array.from({ length: 32 }, (_, index) => index);
    const leashCard = { ...card, mode: 'leash' as const, protocolMin: 2 };
    const peer = protectedPeer(challenge, welcome('leash', undefined, 'code'));
    const stages: string[] = [];
    const session = await negotiateSession(
      peer.stream,
      leashCard,
      new AbortController().signal,
      '2345-6789-abcd-efgh',
      (stage) => stages.push(stage),
    );
    expect(stages).toEqual(['authenticating', 'admitting']);
    expect(peer.writes.map((bytes) => bytes[4])).toEqual([
      Message.CLIENT_HELLO,
      Message.AUTH_PROOF,
    ]);
    const proofFrame = {
      type: Message.AUTH_PROOF,
      payload: peer.writes[1]!.slice(6),
    } as const;
    const proof = decodeAuthProof(proofFrame);
    await expect(
      createAccessProof('23456789ABCDEFGH', leashCard.sessionID, challenge),
    ).resolves.toEqual(proof);
    proof.fill(0);
    await session.close();
  });

  it('closes a challenged attempt without sending a proof when the code is absent', async () => {
    const peer = protectedPeer(
      new Uint8Array(32).fill(9),
      welcome('leash', undefined, 'code'),
    );
    await expect(
      negotiateSession(
        peer.stream,
        { ...card, mode: 'leash', protocolMin: 2 },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'AUTH_REQUIRED', retryable: false });
    expect(peer.writes.map((bytes) => bytes[4])).toEqual([
      Message.CLIENT_HELLO,
    ]);
    expect(peer.stream.close).toHaveBeenCalledExactlyOnceWith({
      graceful: false,
    });
  });

  it('preserves the Host authentication failure after sending one proof', async () => {
    const peer = protectedPeer(
      new Uint8Array(32).fill(10),
      errorFrame('AUTH_FAILED'),
    );
    await expect(
      negotiateSession(
        peer.stream,
        { ...card, mode: 'leash', protocolMin: 2 },
        new AbortController().signal,
        '23456789ABCDEFGH',
      ),
    ).rejects.toMatchObject({ code: 'AUTH_FAILED', retryable: true });
    expect(peer.writes.map((bytes) => bytes[4])).toEqual([
      Message.CLIENT_HELLO,
      Message.AUTH_PROOF,
    ]);
    expect(peer.stream.close).toHaveBeenCalledExactlyOnceWith({
      graceful: true,
    });
  });

  it('rejects a duplicate challenge after the proof', async () => {
    const challenge = new Uint8Array(32).fill(11);
    const peer = protectedPeer(challenge, authChallengeFrame(challenge));
    await expect(
      negotiateSession(
        peer.stream,
        { ...card, mode: 'leash', protocolMin: 2 },
        new AbortController().signal,
        '23456789ABCDEFGH',
      ),
    ).rejects.toMatchObject({ code: 'BAD_FRAME', retryable: false });
    expect(peer.stream.close).toHaveBeenCalledExactlyOnceWith({
      graceful: false,
    });
  });

  it('fails closed when canceled while deriving a protected proof', async () => {
    const digest = Promise.withResolvers<ArrayBuffer>();
    const digestSpy = vi
      .spyOn(globalThis.crypto.subtle, 'digest')
      .mockReturnValueOnce(digest.promise);
    const controller = new AbortController();
    const peer = protectedPeer(
      new Uint8Array(32).fill(12),
      welcome('leash', undefined, 'code'),
    );
    const connecting = negotiateSession(
      peer.stream,
      { ...card, mode: 'leash', protocolMin: 2 },
      controller.signal,
      '23456789ABCDEFGH',
    );
    await vi.waitFor(() => expect(digestSpy).toHaveBeenCalled());
    controller.abort();
    digest.resolve(new ArrayBuffer(32));
    await expect(connecting).rejects.toMatchObject({ code: 'CANCELED' });
    expect(peer.writes.map((bytes) => bytes[4])).toEqual([
      Message.CLIENT_HELLO,
    ]);
    expect(peer.stream.close).toHaveBeenCalledOnce();
  });
});

describe('Browser session ownership', () => {
  it.each([2, 65_535])(
    'advertises only implemented version 2 when an invitation maximum is %i',
    async (protocolMax) => {
      const peer = fakePeer();
      const session = await negotiateSession(
        peer.stream,
        { ...card, protocolMax },
        new AbortController().signal,
      );
      const hello = JSON.parse(
        new TextDecoder().decode(peer.writes[0]!.slice(6)),
      ) as Record<string, unknown>;
      expect(hello.protocol_min).toBe(2);
      expect(hello.protocol_max).toBe(2);
      await expect(session.close()).resolves.toBe('normal');
      expect(peer.pendingRead()).toBe(false);
    },
  );
  it('keeps truncated handshakes and peer BAD_FRAME retry hints terminal', async () => {
    const encoded = encodeFrame('host', 'await-server-welcome', welcome());
    for (const length of [1, 4, 5, 6, encoded.length - 1]) {
      const peer = fakePeer(null);
      peer.push(encoded.slice(0, length));
      peer.push(null);
      await expect(
        negotiateSession(peer.stream, card, new AbortController().signal),
      ).rejects.toMatchObject({ code: 'BAD_FRAME', retryable: false });
      expect(peer.stream.close).toHaveBeenCalledExactlyOnceWith({
        graceful: false,
      });
    }
    const peer = fakePeer();
    const session = await negotiateSession(
      peer.stream,
      card,
      new AbortController().signal,
    );
    peer.push(
      encodeFrame(
        'host',
        'active-leash',
        jsonFrame(Message.ERROR, {
          code: 'BAD_FRAME',
          message: 'transport ended within a frame',
          retryable: true,
        }),
      ),
    );
    await expect(session.done).rejects.toMatchObject({
      code: 'BAD_FRAME',
      retryable: false,
    });
  });

  it('allows only an explicit new session after established frame truncation', async () => {
    const ping = encodeFrame('host', 'active-leash', {
      type: Message.PING,
      payload: new Uint8Array(16),
    });
    for (const mode of ['leash'] as const) {
      for (const length of [1, 4, 5, 6, ping.length - 1]) {
        const peer = fakePeer(welcome(mode, ['terminal_output']));
        const session = await negotiateSession(
          peer.stream,
          { ...card, mode },
          new AbortController().signal,
        );
        peer.push(ping.slice(0, length));
        peer.push(null);
        await expect(session.done).rejects.toMatchObject({
          code: 'DISCONNECTED',
          retryable: true,
        });
        expect(peer.stream.close).toHaveBeenCalledExactlyOnceWith({
          graceful: false,
        });
        expect(peer.writes.map((wire) => wire[4])).toEqual([
          Message.CLIENT_HELLO,
        ]);
        expect(session.inspectMetrics().framesRx).toBe(1);
        expect(peer.pendingRead()).toBe(false);
      }
    }
  });

  it('notifies oversized input before closing without reading its body', async () => {
    for (const [mode, prefix] of [
      ['leash', new Uint8Array([0, 0x10, 0, 1])],
      ['leash', new Uint8Array([0, 0, 0x80, 1, Message.TERM_OUTPUT, 0])],
    ] as const) {
      const peer = fakePeer(welcome(mode, ['terminal_output']));
      const session = await negotiateSession(
        peer.stream,
        { ...card, mode },
        new AbortController().signal,
      );
      peer.push(prefix);
      await expect(session.done).rejects.toMatchObject({
        code: 'FRAME_TOO_LARGE',
      });
      const errors = peer.writes.filter((wire) => wire[4] === Message.ERROR);
      expect(errors).toHaveLength(1);
      const payload: unknown = JSON.parse(
        new TextDecoder().decode(errors[0]!.slice(6)),
      );
      expect(payload).toEqual({
        code: 'FRAME_TOO_LARGE',
        message: 'TMOUSE/1 frame exceeds its limit.',
        retryable: false,
      });
      expect(peer.stream.close).toHaveBeenCalledExactlyOnceWith({
        graceful: true,
      });
      expect(peer.pendingRead()).toBe(false);
      if (session.terminal) expect(session.terminal.canInput()).toBe(false);
    }
  });

  it('preserves oversized failure when its notification fails or stalls', async () => {
    vi.useFakeTimers();
    for (const stalled of [false, true]) {
      const peer = fakePeer();
      const session = await negotiateSession(
        peer.stream,
        card,
        new AbortController().signal,
      );
      const failure = session.done.catch((error: unknown) => error);
      let release: (() => void) | undefined;
      peer.stream.write = async (wire) => {
        expect(wire[4]).toBe(Message.ERROR);
        if (stalled)
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        throw new Error('tcSyntheticNotificationFailure');
      };
      peer.stream.close.mockImplementation(async () => {
        release?.();
      });
      peer.push(new Uint8Array([0, 0x10, 0, 1]));
      await vi.advanceTimersByTimeAsync(0);
      if (stalled) {
        expect(peer.stream.close).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1999);
        expect(peer.stream.close).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
      }
      expect(await failure).toMatchObject({
        code: 'FRAME_TOO_LARGE',
        retryable: false,
      });
      expect(peer.stream.close).toHaveBeenCalledOnce();
      expect(peer.pendingRead()).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    }
  });

  it('discards queued terminal input and bounds an in-flight write before an oversized notification', async () => {
    vi.useFakeTimers();
    for (const writable of [true, false]) {
      const peer = fakePeer(
        welcome('leash', ['terminal_input', 'terminal_output']),
      );
      const session = await negotiateSession(
        peer.stream,
        { ...card, mode: 'leash' },
        new AbortController().signal,
      );
      const failure = session.done.catch((error: unknown) => error);
      const terminal = session.terminal!;
      terminal.attachDisplay({ reset() {}, async write() {} });
      peer.push(
        encodeFrame(
          'host',
          'active-leash',
          jsonFrame(Message.TERM_RESET, { generation: 1, cols: 80, rows: 24 }),
        ),
      );
      peer.push(
        encodeFrame(
          'host',
          'active-leash',
          jsonFrame(Message.PROCESS_STATE, {
            generation: 1,
            state: 'running',
            pid: 42,
            started_at: 1000,
            exit_code: null,
            signal: null,
          }),
        ),
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(terminal.canInput()).toBe(true);
      const write = peer.stream.write;
      let release!: () => void;
      let concurrent = 0,
        maximum = 0;
      peer.stream.write = async (wire) => {
        maximum = Math.max(maximum, ++concurrent);
        try {
          await write(wire);
          if (wire[4] === Message.TERM_INPUT)
            await new Promise<void>((resolve) => {
              release = resolve;
            });
        } finally {
          concurrent--;
        }
      };
      peer.stream.close.mockImplementation(async () => {
        release();
      });
      terminal.input(new Uint8Array(40_000).fill(7));
      await vi.advanceTimersByTimeAsync(0);
      expect(release).toBeTypeOf('function');
      peer.push(new Uint8Array([0, 0x10, 0, 1]));
      await vi.advanceTimersByTimeAsync(0);
      expect(terminal.canInput()).toBe(false);
      expect(terminal.inspect().queuedBytes).toBe(0);
      if (writable) release();
      else await vi.advanceTimersByTimeAsync(2000);
      expect(await failure).toMatchObject({ code: 'FRAME_TOO_LARGE' });
      expect(maximum).toBe(1);
      expect(
        peer.writes.filter((wire) => wire[4] === Message.TERM_INPUT),
      ).toHaveLength(1);
      expect(
        peer.writes.filter((wire) => wire[4] === Message.ERROR),
      ).toHaveLength(writable ? 1 : 0);
      expect(peer.stream.close).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    }
  });

  it('does not echo a peer oversized-error notification', async () => {
    const peer = fakePeer();
    const session = await negotiateSession(
      peer.stream,
      card,
      new AbortController().signal,
    );
    peer.push(
      encodeFrame(
        'host',
        'active-leash',
        jsonFrame(Message.ERROR, {
          code: 'FRAME_TOO_LARGE',
          message: 'tcSyntheticPeerSecret',
          retryable: false,
        }),
      ),
    );
    await expect(session.done).rejects.toMatchObject({
      code: 'FRAME_TOO_LARGE',
    });
    expect(
      peer.writes.filter((wire) => wire[4] === Message.ERROR),
    ).toHaveLength(0);
    expect(peer.stream.close).toHaveBeenCalledExactlyOnceWith({
      graceful: true,
    });
  });

  it('shares the Leash reader and writer, waits for output parsing and resumes only unsent input after backpressure', async () => {
    const peer = fakePeer(
      welcome('leash', ['restart', 'terminal_input', 'terminal_output']),
    );
    const session = await negotiateSession(
      peer.stream,
      { ...card, mode: 'leash' },
      new AbortController().signal,
    );
    const terminal = session.terminal!;
    let parsed!: () => void;
    const display = {
      reset: vi.fn(),
      write: vi.fn(
        (_data: Uint8Array) =>
          new Promise<void>((resolve) => {
            parsed = resolve;
          }),
      ),
    };
    terminal.attachDisplay(display);
    const push = (type: Frame['type'], value: unknown) =>
      peer.push(encodeFrame('host', 'active-leash', jsonFrame(type, value)));
    push(Message.TERM_RESET, { generation: 1, cols: 80, rows: 24 });
    const process = {
      generation: 1,
      state: 'running',
      pid: 42,
      started_at: 1000,
      exit_code: null,
      signal: null,
    };
    push(Message.PROCESS_STATE, process);
    await vi.waitFor(() => expect(terminal.canInput()).toBe(true));
    const bytes = new TextEncoder().encode('\u001b[31m🐈\u001b[0m');
    peer.push(
      encodeFrame('host', 'active-leash', {
        type: Message.TERM_OUTPUT,
        payload: bytes,
      }),
    );
    push(Message.OUTPUT_DROPPED, { generation: 1, dropped_bytes: 123 });
    await vi.waitFor(() => expect(display.write).toHaveBeenCalled());
    const held = display.write.mock.calls[0]![0];
    expect(held).toEqual(bytes);
    expect(terminal.inspect().droppedBytes).toBe(0);
    parsed();
    await vi.waitFor(() => expect(terminal.inspect().droppedBytes).toBe(123));
    expect(held.every((byte) => byte === 0)).toBe(true);
    const write = peer.stream.write;
    let release!: () => void,
      concurrent = 0,
      maximum = 0,
      blocked = true;
    peer.stream.write = async (wire) => {
      maximum = Math.max(maximum, ++concurrent);
      try {
        await write(wire);
        if (blocked && wire[4] === Message.TERM_INPUT) {
          blocked = false;
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
      } finally {
        concurrent--;
      }
    };
    terminal.input(new Uint8Array(40_000).fill(9));
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    push(Message.ERROR, {
      code: 'BACKPRESSURE',
      message: 'untrusted host detail',
      retryable: false,
    });
    await vi.waitFor(() => expect(terminal.inspect().backpressure).toBe(true));
    release();
    await vi.waitFor(() => expect(terminal.inspect().queuedBytes).toBe(7234));
    expect(
      peer.writes.filter((frame) => frame[4] === Message.TERM_INPUT),
    ).toHaveLength(1);
    terminal.resumeInput();
    await vi.waitFor(() => expect(terminal.inspect().queuedBytes).toBe(0));
    expect(maximum).toBe(1);
    expect(
      peer.writes
        .filter((frame) => frame[4] === Message.TERM_INPUT)
        .map((frame) => frame.length - 6),
    ).toEqual([32766, 7234]);
    push(Message.ERROR, {
      code: 'READONLY',
      message: 'private peer text',
      retryable: true,
    });
    await vi.waitFor(() =>
      expect(terminal.inspect().error?.code).toBe('READONLY'),
    );
    expect(terminal.inspect().error?.message).not.toContain('private');
    await session.close();
    expect(terminal.inspect()).toMatchObject({ stopped: true, queuedBytes: 0 });
  });

  it('enables new-generation input only after the serialized PONG write completes', async () => {
    const peer = fakePeer(
      welcome('leash', ['terminal_input', 'terminal_output']),
    );
    const session = await negotiateSession(
      peer.stream,
      { ...card, mode: 'leash' },
      new AbortController().signal,
    );
    const terminal = session.terminal!;
    terminal.attachDisplay({ reset: vi.fn(), write: async () => {} });
    for (const generation of [1, 2]) {
      peer.push(
        encodeFrame(
          'host',
          'active-leash',
          jsonFrame(Message.TERM_RESET, { generation, cols: 80, rows: 24 }),
        ),
      );
      peer.push(
        encodeFrame(
          'host',
          'active-leash',
          jsonFrame(Message.PROCESS_STATE, {
            generation,
            state: 'running',
            pid: 42,
            started_at: 1000,
            exit_code: null,
            signal: null,
          }),
        ),
      );
    }
    await vi.waitFor(() =>
      expect(terminal.inspect().process?.generation).toBe(2),
    );
    expect(terminal.canInput()).toBe(false);
    const write = peer.stream.write;
    let release!: () => void;
    peer.stream.write = async (bytes) => {
      await write(bytes);
      if (bytes[4] === Message.PONG)
        await new Promise<void>((resolve) => {
          release = resolve;
        });
    };
    peer.push(
      encodeFrame('host', 'active-leash', {
        type: Message.PING,
        payload: new Uint8Array(16),
      }),
    );
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    expect(terminal.input(Uint8Array.of(3))).toBe(false);
    release();
    await vi.waitFor(() => expect(terminal.canInput()).toBe(true));
    terminal.input(Uint8Array.of(4));
    await vi.waitFor(() =>
      expect(peer.writes.at(-1)?.[4]).toBe(Message.TERM_INPUT),
    );
    expect(peer.writes.slice(-2).map((bytes) => bytes[4])).toEqual([
      Message.PONG,
      Message.TERM_INPUT,
    ]);
    await session.close();
  });

  it.each(['unmounted', 'unparsed'] as const)(
    'cancels an %s Leash display without leaving the session waiting',
    async (mode) => {
      const peer = fakePeer(welcome('leash', ['terminal_output'])),
        controller = new AbortController();
      const session = await negotiateSession(
        peer.stream,
        { ...card, mode: 'leash' },
        controller.signal,
      );
      const outcome = expect(session.done).rejects.toMatchObject({
        code: 'CANCELED',
      });
      const write = vi.fn(async () => new Promise<void>(() => {}));
      if (mode === 'unparsed')
        session.terminal!.attachDisplay({ reset: vi.fn(), write });
      peer.push(
        encodeFrame(
          'host',
          'active-leash',
          jsonFrame(Message.TERM_RESET, { generation: 1, cols: 80, rows: 24 }),
        ),
      );
      peer.push(
        encodeFrame('host', 'active-leash', {
          type: Message.TERM_OUTPUT,
          payload: Uint8Array.of(65),
        }),
      );
      await vi.waitFor(() =>
        expect(session.terminal!.inspect().reset).toBeDefined(),
      );
      if (mode === 'unparsed')
        await vi.waitFor(() => expect(write).toHaveBeenCalled());
      controller.abort();
      await outcome;
      expect(session.terminal!.inspect().stopped).toBe(true);
      expect(peer.stream.close).toHaveBeenCalledTimes(1);
    },
  );

  it('propagates a safe terminal renderer failure through connection teardown', async () => {
    const peer = fakePeer(welcome('leash', ['terminal_output']));
    const session = await negotiateSession(
      peer.stream,
      { ...card, mode: 'leash' },
      new AbortController().signal,
    );
    const outcome = expect(session.done).rejects.toMatchObject({
      name: 'TerminalDisplayError',
      message: 'The terminal display failed. Reconnect to try again.',
    });
    session.terminal!.attachDisplay({
      reset: () => {
        throw new Error('private display detail');
      },
      write: async () => {},
    });
    peer.push(
      encodeFrame(
        'host',
        'active-leash',
        jsonFrame(Message.TERM_RESET, { generation: 1, cols: 80, rows: 24 }),
      ),
    );
    await outcome;
    expect(peer.stream.close).toHaveBeenCalledExactlyOnceWith({
      graceful: false,
    });
  });

  it('sends one ping per second, measures local RTT, and stops all timers on close', async () => {
    vi.useFakeTimers();
    let monotonic = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => monotonic);
    const peer = fakePeer();
    const session = await negotiateSession(
      peer.stream,
      card,
      new AbortController().signal,
    );
    expect(session.inspectMetrics().samples).toBe(0);
    await vi.advanceTimersByTimeAsync(999);
    expect(peer.writes).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(peer.writes.at(-1)?.[4]).toBe(Message.PING);
    monotonic = 1040;
    peer.push(
      encodeFrame('host', 'active-leash', {
        type: Message.PONG,
        payload: peer.writes.at(-1)!.slice(6),
      }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(session.inspectMetrics()).toMatchObject({
      samples: 1,
      rttMs: 40,
      jitterMs: 0,
      p50Ms: 40,
      p95Ms: 40,
      framesTx: 2,
      framesRx: 2,
    });
    expect(session.inspectMetrics().bytesTx).toBeGreaterThan(22);
    expect(session.inspectMetrics().bytesRx).toBeGreaterThan(22);
    await session.close();
    const sent = peer.writes.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(peer.writes).toHaveLength(sent);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('accepts already-in-flight peer traffic during local close without applying effects', async () => {
    const peer = fakePeer(welcome(), false);
    const session = await negotiateSession(
      peer.stream,
      card,
      new AbortController().signal,
    );
    const closing = session.close();
    peer.push(
      encodeFrame('host', 'active-leash', {
        type: Message.PING,
        payload: new Uint8Array(16),
      }),
    );
    peer.push(
      encodeFrame('host', 'active-leash', {
        type: Message.PONG,
        payload: new Uint8Array(16),
      }),
    );
    peer.push(encodeFrame('host', 'active-leash', closeFrame('normal')));
    await expect(closing).resolves.toBe('normal');
    expect(peer.writes.map((bytes) => bytes[4])).toEqual([
      Message.CLIENT_HELLO,
      Message.CLOSE,
    ]);
    expect(session.inspectMetrics().samples).toBe(0);
  });
  it('negotiates HELLO/WELCOME, answers ping, and closes exactly once', async () => {
    const peer = fakePeer();
    adapter.dialTailcat.mockResolvedValue(peer.stream);
    adapter.loadTailcat.mockImplementationOnce(async (options: LoadOptions) => {
      options.onProgress?.(50);
      options.onProgress?.(100);
    });
    const stages: Array<[string, number | undefined]> = [];
    const session = await connectSession(
      card,
      new AbortController().signal,
      (stage, progress) => stages.push([stage, progress]),
    );
    expect(stages).toEqual([
      ['loading', 0],
      ['loading', 50],
      ['loading', 100],
      ['connecting', undefined],
      ['establishing', undefined],
      ['admitting', undefined],
    ]);
    expect(adapter.dialTailcat).toHaveBeenCalledWith(
      card.address,
      expect.anything(),
    );
    expect(session.welcome.capabilities).toEqual(['terminal_output']);
    expect(Object.isFrozen(session.welcome)).toBe(true);
    const hello = JSON.parse(
      new TextDecoder().decode(peer.writes[0]!.slice(6)),
    ) as Record<string, unknown>;
    expect(hello.session_id).toBe('07'.repeat(16));
    const ping = new Uint8Array(16).fill(3);
    peer.push(
      encodeFrame('host', 'active-leash', {
        type: Message.PING,
        payload: ping,
      }),
    );
    await vi.waitFor(() => expect(peer.writes.at(-1)?.[4]).toBe(Message.PONG));
    expect(peer.writes.at(-1)?.slice(6)).toEqual(ping);
    const closed = session.close();
    expect(session.close()).toBe(closed);
    await expect(closed).resolves.toBe('normal');
    expect(session.close()).toBe(closed);
    expect(peer.stream.close).toHaveBeenCalledExactlyOnceWith({
      graceful: true,
    });
    expect(peer.pendingRead()).toBe(false);
  });

  it('uses host capabilities for readonly Leash and acknowledges host expiry', async () => {
    const peer = fakePeer(welcome('leash', ['terminal_output']));
    const session = await negotiateSession(
      peer.stream,
      { ...card, mode: 'leash' },
      new AbortController().signal,
    );
    expect(session.welcome.mode).toBe('leash');
    expect(session.welcome.capabilities).toEqual(['terminal_output']);
    peer.push(encodeFrame('host', 'active-leash', closeFrame('expired')));
    await expect(session.done).resolves.toBe('expired');
    expect(peer.writes.at(-1)?.[4]).toBe(Message.CLOSE);
    expect(peer.stream.close).toHaveBeenCalledExactlyOnceWith({
      graceful: true,
    });
  });

  it('classifies rejected handshakes without exposing peer text or retry hints', async () => {
    const rejected = fakePeer(
      jsonFrame(Message.ERROR, {
        code: 'SESSION_BUSY',
        message: 'tcSyntheticSecretDoNotDisplay',
        retryable: false,
      }),
    );
    await expect(
      negotiateSession(rejected.stream, card, new AbortController().signal),
    ).rejects.toMatchObject({
      code: 'SESSION_BUSY',
      retryable: true,
      message: 'Another browser is controlling this session.',
    });
    expect(rejected.stream.close).toHaveBeenCalledExactlyOnceWith({
      graceful: true,
    });
    const mismatch = fakePeer(welcome('leash', ['terminal_output']));
    await expect(
      negotiateSession(
        mismatch.stream,
        { ...card, mode: 'unsupported' as typeof card.mode },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'BAD_FRAME' });
    expect(mismatch.stream.close).toHaveBeenCalledExactlyOnceWith({
      graceful: false,
    });
  });

  it('does not connect canceled or expired invitations', async () => {
    const canceled = new AbortController();
    canceled.abort();
    await expect(
      connectSession(card, canceled.signal, vi.fn()),
    ).rejects.toMatchObject({ code: 'CANCELED' });
    await expect(
      connectSession(
        { ...card, expiresAt: 1 },
        new AbortController().signal,
        vi.fn(),
      ),
    ).rejects.toMatchObject({ code: 'EXPIRED' });
    expect(adapter.loadTailcat).not.toHaveBeenCalled();
    expect(adapter.dialTailcat).not.toHaveBeenCalled();
  });

  it('bounds the handshake and joins aborted reads', async () => {
    vi.useFakeTimers();
    const peer = fakePeer(null);
    const pending = negotiateSession(
      peer.stream,
      card,
      new AbortController().signal,
    );
    const result = expect(pending).rejects.toMatchObject({
      code: 'HANDSHAKE_TIMEOUT',
      retryable: true,
    });
    await vi.advanceTimersByTimeAsync(10_000);
    await result;
    expect(peer.pendingRead()).toBe(false);
    const controller = new AbortController();
    const abortedPeer = fakePeer(null);
    const aborted = negotiateSession(
      abortedPeer.stream,
      card,
      controller.signal,
    );
    const abortResult = expect(aborted).rejects.toMatchObject({
      code: 'CANCELED',
    });
    controller.abort();
    await abortResult;
  });

  it('distinguishes EOF from a graceful close and permits manual reconnect', async () => {
    const peer = fakePeer();
    const session = await negotiateSession(
      peer.stream,
      card,
      new AbortController().signal,
    );
    peer.push(null);
    await expect(session.done).rejects.toMatchObject({
      code: 'DISCONNECTED',
      retryable: true,
    });
    expect(peer.stream.close).toHaveBeenCalledExactlyOnceWith({
      graceful: false,
    });
    const beforeWelcome = fakePeer(null);
    beforeWelcome.push(null);
    await expect(
      negotiateSession(
        beforeWelcome.stream,
        card,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'DISCONNECTED' });
  });

  it('enforces a close deadline when the host stops replying', async () => {
    vi.useFakeTimers();
    const peer = fakePeer(welcome(), false);
    const session = await negotiateSession(
      peer.stream,
      card,
      new AbortController().signal,
    );
    const result = expect(session.close()).rejects.toMatchObject({
      code: 'CLOSE_TIMEOUT',
      retryable: false,
    });
    await vi.advanceTimersByTimeAsync(2000);
    await result;
    expect(peer.pendingRead()).toBe(false);
  });

  it('force-closes on cancellation and rejects unexpected mode data', async () => {
    const controller = new AbortController();
    const peer = fakePeer();
    const session = await negotiateSession(
      peer.stream,
      card,
      controller.signal,
    );
    controller.abort();
    await expect(session.done).rejects.toMatchObject({ code: 'CANCELED' });
    expect(peer.pendingRead()).toBe(false);
    const invalid = fakePeer();
    const other = await negotiateSession(
      invalid.stream,
      card,
      new AbortController().signal,
    );
    invalid.push(new Uint8Array([0, 0, 0, 2, 0x24, 0]));
    await expect(other.done).rejects.toMatchObject({ code: 'BAD_FRAME' });
    expect(invalid.stream.close).toHaveBeenCalledExactlyOnceWith({
      graceful: false,
    });
  });

  it('rejects buffered trailing bytes after CLOSE and preserves the first failure', async () => {
    const peer = fakePeer();
    const session = await negotiateSession(
      peer.stream,
      card,
      new AbortController().signal,
    );
    const encoded = encodeFrame('host', 'active-leash', closeFrame('normal'));
    const extra = new Uint8Array(encoded.length + 1);
    extra.set(encoded);
    peer.push(extra);
    await expect(session.done).rejects.toMatchObject({ code: 'BAD_FRAME' });
    const rejected = fakePeer();
    const other = await negotiateSession(
      rejected.stream,
      card,
      new AbortController().signal,
    );
    rejected.stream.close.mockImplementation(async () => {
      throw new Error('tcSyntheticSecret');
    });
    rejected.push(
      encodeFrame(
        'host',
        'active-leash',
        jsonFrame(Message.ERROR, {
          code: 'EXPIRED',
          message: 'tcSyntheticPeerText',
          retryable: true,
        }),
      ),
    );
    await expect(other.done).rejects.toMatchObject({ code: 'EXPIRED' });
  });

  it('reports transport close failure after a successful protocol close', async () => {
    const peer = fakePeer();
    const session = await negotiateSession(
      peer.stream,
      card,
      new AbortController().signal,
    );
    peer.stream.close.mockRejectedValue(new Error('synthetic close failure'));
    await expect(session.close()).rejects.toThrow('synthetic close failure');
  });

  it('allows reconnect after stream I/O failures without retrying peer INTERNAL errors', async () => {
    for (const operation of ['read', 'write'] as const) {
      const handshake = fakePeer();
      if (operation === 'read') {
        handshake.stream.read = async () => {
          throw new Error('tcSyntheticReadSecret');
        };
      } else {
        handshake.stream.write = async () => {
          throw new Error('tcSyntheticWriteSecret');
        };
      }
      await expect(
        negotiateSession(handshake.stream, card, new AbortController().signal),
      ).rejects.toMatchObject({ code: 'DISCONNECTED', retryable: true });
    }
    const failedRead = fakePeer();
    const originalRead = failedRead.stream.read;
    let reads = 0;
    failedRead.stream.read = async () => {
      if (++reads === 2) throw new Error('tcSyntheticReadSecret');
      return originalRead();
    };
    const reading = await negotiateSession(
      failedRead.stream,
      card,
      new AbortController().signal,
    );
    await expect(reading.done).rejects.toMatchObject({
      code: 'DISCONNECTED',
      retryable: true,
    });

    const failedWrite = fakePeer();
    const originalWrite = failedWrite.stream.write;
    failedWrite.stream.write = async (bytes) => {
      if (bytes[4] === Message.PONG) throw new Error('tcSyntheticWriteSecret');
      await originalWrite(bytes);
    };
    const writing = await negotiateSession(
      failedWrite.stream,
      card,
      new AbortController().signal,
    );
    failedWrite.push(
      encodeFrame('host', 'active-leash', {
        type: Message.PING,
        payload: new Uint8Array(16),
      }),
    );
    await expect(writing.done).rejects.toMatchObject({
      code: 'DISCONNECTED',
      retryable: true,
    });

    const rejected = fakePeer(
      jsonFrame(Message.ERROR, {
        code: 'INTERNAL',
        message: 'tcSyntheticPeerSecret',
        retryable: true,
      }),
    );
    await expect(
      negotiateSession(rejected.stream, card, new AbortController().signal),
    ).rejects.toMatchObject({ code: 'INTERNAL', retryable: false });
  });

  it('bounds a stalled write, releases it on close, and preserves reconnect eligibility', async () => {
    vi.useFakeTimers();
    const peer = fakePeer();
    const session = await negotiateSession(
      peer.stream,
      card,
      new AbortController().signal,
    );
    let release: (() => void) | undefined;
    peer.stream.write = async () =>
      new Promise<void>((resolve) => {
        release = resolve;
      });
    peer.stream.close.mockImplementation(async () => {
      release?.();
    });
    peer.push(
      encodeFrame('host', 'active-leash', {
        type: Message.PING,
        payload: new Uint8Array(16),
      }),
    );
    const outcome = expect(session.done).rejects.toMatchObject({
      code: 'DISCONNECTED',
      retryable: true,
    });
    await vi.advanceTimersByTimeAsync(2000);
    await outcome;
    expect(peer.pendingRead()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});

function welcome(
  mode: 'leash' = 'leash',
  capabilities = mode === 'leash'
    ? ['terminal_output']
    : ['terminal_input', 'terminal_output'],
  accessMode: 'code' | 'link' = 'link',
): Frame {
  return jsonFrame(Message.SERVER_WELCOME, {
    protocol: 2,
    mode,
    session_state: 'active',
    expires_at: 0,
    relay: {
      mode: 'official',
      host: 'relay.example.com',
      browser_path: 'derp',
    },
    capabilities,
    ...(mode === 'leash' ? { access_mode: accessMode } : {}),
  });
}

function jsonFrame(type: Frame['type'], value: unknown): Frame {
  return { type, payload: new TextEncoder().encode(JSON.stringify(value)) };
}

function fakePeer(initial: Frame | null = welcome(), acknowledgeClose = true) {
  const chunks: Array<Uint8Array | null> = [];
  const writes: Uint8Array[] = [];
  let reader: ((chunk: Uint8Array | null) => void) | undefined;
  const push = (chunk: Uint8Array | null): void => {
    if (reader !== undefined) {
      const resolve = reader;
      reader = undefined;
      resolve(chunk);
    } else chunks.push(chunk);
  };
  const stream = {
    read: async (): Promise<Uint8Array | null> => {
      if (chunks.length > 0) return chunks.shift()!;
      if (reader !== undefined) throw new Error('Concurrent read');
      return new Promise((resolve) => {
        reader = resolve;
      });
    },
    write: async (bytes: Uint8Array): Promise<void> => {
      writes.push(bytes.slice());
      if (bytes[4] === Message.CLIENT_HELLO && initial !== null) {
        push(encodeFrame('host', 'await-server-welcome', initial));
      }
      if (bytes[4] === Message.CLOSE && acknowledgeClose) {
        push(encodeFrame('host', 'active-leash', closeFrame('normal')));
      }
    },
    close: vi.fn(async (_options?: Parameters<ByteStream['close']>[0]) => {
      if (reader !== undefined) push(null);
    }),
  } satisfies ByteStream;
  return { stream, push, writes, pendingRead: () => reader !== undefined };
}

function protectedPeer(challenge: Uint8Array, admission: Frame) {
  const peer = fakePeer(null);
  peer.stream.write = async (bytes: Uint8Array): Promise<void> => {
    peer.writes.push(bytes.slice());
    if (bytes[4] === Message.CLIENT_HELLO) {
      peer.push(
        encodeFrame(
          'host',
          'await-server-welcome',
          authChallengeFrame(challenge),
        ),
      );
    }
    if (bytes[4] === Message.AUTH_PROOF) {
      peer.push(encodeFrame('host', 'await-server-welcome', admission));
    }
    if (bytes[4] === Message.CLOSE) {
      peer.push(encodeFrame('host', 'active-leash', closeFrame('normal')));
    }
  };
  return peer;
}
