import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EscapeClient } from './escape.ts';
import {
  Message,
  ProtocolError,
  type Frame,
  type Welcome,
} from './protocol/frame.ts';
import {
  decodeGameInit,
  decodeGameInput,
  encodeGameSnapshot,
  encodeGameEvent,
  encodeGameResult,
  type GameInput,
  type GameSnapshot,
  type GameResult,
} from './protocol/game.ts';

const corpus = JSON.parse(
  readFileSync(
    new URL('../../../protocol/fixtures/v1/frames.json', import.meta.url),
    'utf8',
  ),
) as {
  cases: Array<{ id: string; wire: { hex: string } }>;
};
const initFrame = (): Frame => ({
  type: Message.GAME_INIT,
  payload: Uint8Array.from(
    Buffer.from(
      corpus.cases.find((entry) => entry.id === 'game-init-canonical')!.wire
        .hex,
      'hex',
    ),
  ).slice(6),
});
const init = decodeGameInit(initFrame().payload);
const welcome: Welcome = {
  mode: 'escape',
  expiresAt: 0,
  relay: {
    mode: 'custom-host',
    host: 'relay.example.test',
    browserPath: 'derp',
  },
  capabilities: ['dash', 'game_input', 'game_view'],
};
function snapshot(values: Partial<GameSnapshot> = {}): Frame {
  return {
    type: Message.GAME_SNAPSHOT,
    payload: encodeGameSnapshot({
      sequence: 1,
      acceptedInputSequence: 0,
      elapsedMS: 0n,
      remainingMS: 45000,
      mouse: init.mouse,
      cat: init.cat,
      dashCooldownMS: 0,
      collectedMask: 0,
      phase: 0,
      exitOpen: false,
      ...values,
    }),
  };
}
function result(values: Partial<GameResult> = {}): Frame {
  return {
    type: Message.GAME_RESULT,
    payload: encodeGameResult({
      outcome: 'caught',
      elapsed_ms: 1000,
      relay: welcome.relay.host,
      rtt_p50_ms: 40,
      rtt_p95_ms: 60,
      jitter_ms: 10,
      message: 'The connection was too good.',
      ...values,
    }),
  };
}
function event(
  sequence: number,
  name = 'countdown',
  value: number | null = 3,
): Frame {
  return {
    type: Message.GAME_EVENT,
    payload: encodeGameEvent({ sequence, event: name, value }, 'host'),
  };
}
const clients: EscapeClient[] = [];
function setup(
  options: {
    capabilities?: readonly string[];
    blocked?: boolean;
    start?: boolean;
  } = {},
) {
  const inputs: GameInput[] = [];
  const releases: Array<() => void> = [];
  const fail = vi.fn();
  const send = vi.fn(async (frame: Frame) => {
    inputs.push(decodeGameInput(frame.payload));
    if (options.blocked)
      await new Promise<void>((resolve) => releases.push(resolve));
  });
  const client = new EscapeClient(
    { ...welcome, capabilities: options.capabilities ?? welcome.capabilities },
    send,
    fail,
  );
  clients.push(client);
  if (options.start !== false) {
    client.receive(initFrame());
    client.receive(snapshot());
  }
  return { client, send, fail, inputs, releases };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  for (const client of clients.splice(0)) client.dispose();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('Escape connection-local flow control', () => {
  it('predicts immediately through a blocked writer without modifying host state or accepting stale snapshots', async () => {
    const { client, inputs, releases } = setup({ blocked: true });
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    // Initialize again only after a result, as the real round lifecycle requires.
    client.receive(result({ elapsed_ms: 0 }));
    expect(client.predict()).toBeUndefined();
    client.receive(initFrame());
    client.receive(snapshot({ sequence: 2, phase: 1 }));
    const authoritative = client.inspect().snapshot;
    client.move(1, 0);
    now = 16;
    expect(client.predict()?.mouse.x).toBeCloseTo(init.mouse.x + 0.096);
    expect(inputs).toHaveLength(0);
    now = 50;
    await vi.advanceTimersByTimeAsync(50);
    client.predict();
    expect(inputs).toHaveLength(1);
    now = 100;
    expect(client.predict()?.mouse.x).toBeCloseTo(init.mouse.x + 0.6);
    client.receive(snapshot({ sequence: 1, mouse: { x: 10.5, y: 3.5 } }));
    expect(client.inspect().snapshot).toBe(authoritative);
    expect(client.predict()?.mouse.x).toBeCloseTo(init.mouse.x + 0.6);
    expect(client.inspect().snapshot?.mouse).toEqual(init.mouse);
    expect(client.inspect().result).toBeUndefined();
    client.dispose();
    releases.shift()!();
    expect(client.predict()).toBeUndefined();
    expect(client.move(1, 0)).toBe(false);
  });

  it('keeps readonly prediction stationary and starts every new round without old intent or dust', () => {
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const readonly = setup({ capabilities: ['game_view'] }).client;
    readonly.receive(snapshot({ sequence: 2, phase: 1 }));
    expect(readonly.move(1, 0)).toBe(false);
    now = 50;
    expect(readonly.predict()?.mouse).toEqual(init.mouse);
    const { client } = setup();
    client.receive(snapshot({ sequence: 2, phase: 1 }));
    client.move(1, 0);
    now = 100;
    client.receive(
      snapshot({ sequence: 3, phase: 1, mouse: { x: 10.5, y: 3.5 } }),
    );
    expect(client.predict()?.dust).toBeDefined();
    client.receive(result());
    expect(client.predict()).toBeUndefined();
    client.receive(initFrame());
    client.receive(snapshot({ sequence: 4, phase: 1 }));
    now = 150;
    expect(client.predict()).toEqual({ mouse: init.mouse, dust: undefined });
  });

  it('waits for initialization and the first snapshot, then sends exactly 20 current intents per second', async () => {
    const { client, inputs } = setup({ start: false });
    expect(client.move(1, 0)).toBe(false);
    expect(client.dash()).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(inputs).toHaveLength(0);
    client.receive(initFrame());
    await vi.advanceTimersByTimeAsync(1000);
    expect(inputs).toHaveLength(0);
    client.receive(snapshot());
    expect(client.move(1, 1)).toBe(true);
    await vi.advanceTimersByTimeAsync(49);
    expect(inputs).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(951);
    expect(inputs).toHaveLength(20);
    expect(inputs.map((input) => input.sequence)).toEqual(
      Array.from({ length: 20 }, (_, index) => index + 1),
    );
    expect(inputs[0]!.velocityX).toBeCloseTo(Math.SQRT1_2);
    expect(inputs[0]!.velocityY).toBeCloseTo(Math.SQRT1_2);
    expect(typeof inputs[0]!.clientTimeMS).toBe('bigint');
    expect(client.move(0, 0)).toBe(true);
    await vi.advanceTimersByTimeAsync(50);
    expect(inputs.at(-1)).toMatchObject({
      velocityX: 0,
      velocityY: 0,
      dash: false,
    });
    client.dispose();
    client.dispose();
    await vi.advanceTimersByTimeAsync(1000);
    expect(inputs).toHaveLength(21);
    expect(client.inspect()).toMatchObject({ queued: 0, stopped: true });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps one write in flight and replaces all unsent movement during a 300 ms pause', async () => {
    const { client, inputs, releases } = setup({ blocked: true });
    client.move(1, 0);
    await vi.advanceTimersByTimeAsync(50);
    for (let tick = 0; tick < 6; tick++) {
      client.move(tick % 2 ? -1 : 1, 0);
      await vi.advanceTimersByTimeAsync(50);
      expect(client.inspect()).toMatchObject({ queued: 1, inFlight: true });
      expect(inputs).toHaveLength(1);
    }
    client.move(0, -1);
    releases.shift()!();
    await vi.advanceTimersByTimeAsync(50);
    expect(inputs).toHaveLength(2);
    expect(inputs[1]).toMatchObject({
      sequence: 2,
      velocityX: 0,
      velocityY: -1,
      dash: false,
    });
    client.dispose();
    releases.shift()!();
    await vi.advanceTimersByTimeAsync(1000);
    expect(inputs).toHaveLength(2);
    expect(client.inspect().inFlight).toBe(false);
  });

  it('preserves eight accepted dash events in order and rejects the ninth without dropping one', async () => {
    const { client, inputs, releases } = setup({ blocked: true });
    await vi.advanceTimersByTimeAsync(50);
    for (let index = 0; index < 8; index++) {
      client.move(index / 8, 0);
      expect(client.dash()).toBe(true);
      await vi.advanceTimersByTimeAsync(50);
    }
    expect(client.dash()).toBe(false);
    expect(client.inspect()).toMatchObject({
      queued: 9,
      inFlight: true,
      backpressure: true,
    });
    client.move(0, 0);
    for (let index = 0; index < 8; index++) {
      releases.shift()!();
      await vi.advanceTimersByTimeAsync(50);
      expect(inputs[index + 1]).toMatchObject({
        sequence: index + 2,
        dash: true,
        velocityX: index / 8,
      });
    }
    releases.shift()!();
    await vi.advanceTimersByTimeAsync(50);
    expect(inputs.at(-1)).toMatchObject({
      dash: false,
      velocityX: 0,
      velocityY: 0,
    });
    expect(client.inspect().backpressure).toBe(false);
    client.dispose();
    releases.shift()!();
    await vi.advanceTimersByTimeAsync(0);
  });

  it('fails closed on write failure and sequence exhaustion without retrying or retaining queued events', async () => {
    const { client, send, fail } = setup();
    send.mockRejectedValueOnce(new ProtocolError('BACKPRESSURE'));
    client.dash();
    await vi.advanceTimersByTimeAsync(1000);
    expect(send).toHaveBeenCalledTimes(1);
    expect(fail).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ code: 'BACKPRESSURE' }),
    );
    expect(client.inspect()).toMatchObject({ stopped: true, queued: 0 });
    const exhausted = setup({ start: false });
    exhausted.client.receive(initFrame());
    exhausted.client.receive(snapshot({ acceptedInputSequence: 0xffffffff }));
    await vi.advanceTimersByTimeAsync(50);
    expect(exhausted.send).not.toHaveBeenCalled();
    expect(exhausted.fail).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ code: 'BAD_FRAME' }),
    );
  });

  it('uses host capabilities and rejects invalid local intent before mutation', async () => {
    const readonly = setup({ capabilities: ['game_view'] });
    expect(readonly.client.move(1, 0)).toBe(false);
    expect(readonly.client.dash()).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(readonly.send).not.toHaveBeenCalled();
    const noDash = setup({ capabilities: ['game_input', 'game_view'] });
    expect(noDash.client.dash()).toBe(false);
    for (const [x, y] of [
      [NaN, 0],
      [0, Infinity],
      [2, 0],
      [0, -2],
    ]) {
      expect(() => noDash.client.move(x!, y!)).toThrowError(ProtocolError);
    }
    await vi.advanceTimersByTimeAsync(50);
    expect(noDash.inputs[0]).toMatchObject({ velocityX: 0, velocityY: 0 });
    const noView = setup({ capabilities: [], start: false });
    expect(() => noView.client.receive(initFrame())).toThrowError(
      ProtocolError,
    );
    expect(
      () =>
        new EscapeClient(
          { ...welcome, mode: 'leash' },
          noDash.send,
          noDash.fail,
        ),
    ).toThrowError(expect.objectContaining({ code: 'MODE_MISMATCH' }));
  });

  it('rejects invalid ordering and round state before mutation while discarding stale sequence numbers', () => {
    const { client } = setup({ start: false });
    expect(
      client.receive({ type: Message.PING, payload: new Uint8Array(16) }),
    ).toBe(false);
    for (const frame of [snapshot(), event(1), result()])
      expect(() => client.receive(frame)).toThrowError(ProtocolError);
    client.receive(initFrame());
    expect(() => client.receive(initFrame())).toThrowError(ProtocolError);
    client.receive(snapshot());
    const first = client.inspect().snapshot;
    // Structurally valid stale snapshots cannot rewind or alter state.
    client.receive(snapshot({ mouse: { x: 0, y: 0 } }));
    expect(client.inspect().snapshot).toBe(first);
    for (const values of [
      { elapsedMS: 45001n, remainingMS: 0 },
      { remainingMS: 44000 },
      { mouse: { x: 0, y: 0 } },
      { phase: 0, elapsedMS: 1n, remainingMS: 44999 },
      { phase: 0, collectedMask: 1 },
      { phase: 0, dashCooldownMS: 5 },
      { acceptedInputSequence: 1 },
    ]) {
      expect(() =>
        client.receive(snapshot({ ...values, sequence: 2 })),
      ).toThrowError(ProtocolError);
      expect(client.inspect().snapshot).toBe(first);
    }
    client.receive(
      snapshot({
        sequence: 2,
        phase: 1,
        elapsedMS: 100n,
        remainingMS: 44900,
        collectedMask: 1,
      }),
    );
    for (const values of [
      { phase: 0, elapsedMS: 0n, remainingMS: 45000, collectedMask: 0 },
      { phase: 1, elapsedMS: 99n, remainingMS: 44901, collectedMask: 1 },
      { phase: 1, elapsedMS: 100n, remainingMS: 44900, collectedMask: 0 },
    ])
      expect(() =>
        client.receive(snapshot({ ...values, sequence: 3 })),
      ).toThrowError(ProtocolError);
    client.receive(
      snapshot({
        sequence: 3,
        phase: 2,
        elapsedMS: 100n,
        remainingMS: 44900,
        collectedMask: 1,
      }),
    );
    expect(() => client.receive(snapshot({ sequence: 4 }))).toThrowError(
      ProtocolError,
    );
    client.receive(event(1));
    const previousEvent = client.inspect().event;
    client.receive(event(1, 'connection_paused', null));
    expect(client.inspect().event).toBe(previousEvent);
    client.receive(event(2, 'connection_resumed', null));
    expect(client.inspect().event?.event).toBe('connection_resumed');
    expect(Object.isFrozen(client.inspect())).toBe(true);
    expect(Object.isFrozen(client.inspect().snapshot?.mouse)).toBe(true);
  });

  it('continues acknowledged input sequences on reconnect without replaying an old connection queue', async () => {
    const old = setup({ blocked: true });
    old.client.move(1, 0);
    old.client.dash();
    await vi.advanceTimersByTimeAsync(50);
    old.client.dash();
    old.client.dispose();
    const next = setup({ start: false });
    next.client.receive(initFrame());
    next.client.receive(
      snapshot({
        sequence: 51,
        acceptedInputSequence: 41,
        elapsedMS: 1000n,
        remainingMS: 44000,
        phase: 2,
      }),
    );
    await vi.advanceTimersByTimeAsync(50);
    expect(next.inputs[0]).toMatchObject({
      sequence: 42,
      velocityX: 0,
      velocityY: 0,
      dash: false,
    });
    next.client.receive(
      snapshot({
        sequence: 52,
        acceptedInputSequence: 42,
        elapsedMS: 1000n,
        remainingMS: 44000,
        phase: 1,
      }),
    );
    expect(() =>
      next.client.receive(
        snapshot({
          sequence: 53,
          acceptedInputSequence: 41,
          elapsedMS: 1000n,
          remainingMS: 44000,
          phase: 1,
        }),
      ),
    ).toThrowError(ProtocolError);
    old.releases.shift()!();
    await vi.advanceTimersByTimeAsync(50);
    expect(old.inputs).toHaveLength(1);
    expect(next.inputs.at(-1)?.sequence).toBe(43);
  });

  it('accepts one result, validates its relay/time, and clears intent before a subsequent round', async () => {
    const { client, inputs } = setup();
    client.receive(
      snapshot({ sequence: 2, phase: 1, elapsedMS: 1000n, remainingMS: 44000 }),
    );
    for (const frame of [
      result({ elapsed_ms: 45001 }),
      result({ elapsed_ms: 999 }),
      result({ relay: 'other.example.test' }),
    ]) {
      expect(() => client.receive(frame)).toThrowError(ProtocolError);
      expect(client.inspect().result).toBeUndefined();
    }
    client.move(1, 0);
    client.dash();
    await vi.advanceTimersByTimeAsync(50);
    client.dash();
    client.receive(result());
    expect(client.inspect()).toMatchObject({
      queued: 0,
      result: { outcome: 'caught' },
    });
    expect(client.move(1, 0)).toBe(false);
    expect(client.dash()).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(inputs).toHaveLength(1);
    for (const frame of [result(), event(1), snapshot({ sequence: 3 })])
      expect(() => client.receive(frame)).toThrowError(ProtocolError);
    client.receive(initFrame());
    await vi.advanceTimersByTimeAsync(1000);
    expect(inputs).toHaveLength(1);
    client.receive(snapshot({ sequence: 3, acceptedInputSequence: 1 }));
    await vi.advanceTimersByTimeAsync(50);
    expect(inputs[1]).toMatchObject({
      sequence: 2,
      velocityX: 0,
      velocityY: 0,
      dash: false,
    });
    client.dispose();
    expect(client.receive(initFrame())).toBe(false);
  });
});
