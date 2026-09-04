import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  LeashClient,
  TerminalDisplayError,
  TERMINAL_CHUNK_BYTES,
  TERMINAL_INPUT_BYTES,
} from './leash.ts';
import {
  Message,
  ProtocolError,
  type Frame,
  type Welcome,
} from './protocol/frame.ts';
import { decodeProcessControl } from './protocol/terminal.ts';

const welcome: Welcome = {
  mode: 'leash',
  expiresAt: 0,
  relay: {
    mode: 'custom-host',
    host: 'relay.example.test',
    browserPath: 'derp',
  },
  capabilities: [
    'terminal_output',
    'terminal_input',
    'resize',
    'interrupt',
    'restart',
    'terminate',
  ],
};
const json = (type: Frame['type'], value: unknown): Frame => ({
  type,
  payload: new TextEncoder().encode(JSON.stringify(value)),
});
const reset = (generation = 1) =>
  json(Message.TERM_RESET, { generation, cols: 80, rows: 24 });
const state = (name = 'running', generation = 1) =>
  json(Message.PROCESS_STATE, {
    generation,
    state: name,
    pid: 42,
    started_at: 1000,
    exit_code: null,
    signal: null,
  });
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.useRealTimers();
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  cleanups.push(resolve);
  return { promise, resolve };
}
function setup(
  options: {
    capabilities?: readonly string[];
    send?: (frame: Frame) => Promise<void>;
    display?: boolean;
  } = {},
) {
  const sent: Frame[] = [],
    fail = vi.fn();
  const client = new LeashClient(
    { ...welcome, capabilities: options.capabilities ?? welcome.capabilities },
    async (frame) => {
      sent.push({ type: frame.type, payload: frame.payload.slice() });
      await options.send?.(frame);
    },
    fail,
  );
  const display = {
    reset: vi.fn(),
    write: vi.fn(async (_data: Uint8Array) => {}),
  };
  if (options.display !== false) client.attachDisplay(display);
  cleanups.push(() => client.dispose());
  const ready = async (generation = 1) => {
    await client.receive(reset(generation));
    await client.receive(state('running', generation));
  };
  return { client, sent, display, fail, ready };
}

describe('Connection-local Leash state and bounded I/O', () => {
  it('validates mode, reset-first ordering, capabilities and display ownership', async () => {
    expect(
      () => new LeashClient({ ...welcome, mode: 'escape' }, vi.fn(), vi.fn()),
    ).toThrow(ProtocolError);
    const f = setup();
    expect(f.client.input(Uint8Array.of(1))).toBe(false);
    expect(f.client.control('restart')).toBe(false);
    expect(f.client.resize(80, 24)).toBe(false);
    await expect(f.client.receive(state())).rejects.toMatchObject({
      code: 'BAD_FRAME',
    });
    expect(
      await f.client.receive({
        type: Message.PING,
        payload: new Uint8Array(16),
      }),
    ).toBe(false);
    const observer = vi.fn(),
      unobserve = f.client.observe(observer);
    expect(() => f.client.observe(vi.fn())).toThrow(TerminalDisplayError);
    expect(() => f.client.attachDisplay(f.display)).toThrow(
      TerminalDisplayError,
    );
    await f.ready();
    expect(f.client.inspect().process?.pid).toBe(42);
    expect(Object.isFrozen(f.client.inspect())).toBe(true);
    expect(observer).toHaveBeenCalled();
    unobserve();
    unobserve();
    observer.mockClear();
    await f.client.receive(state('interrupting'));
    expect(observer).not.toHaveBeenCalled();
    expect(f.client.canInput()).toBe(true);
    const denied = setup({ capabilities: [] });
    await expect(denied.client.receive(reset())).rejects.toMatchObject({
      code: 'UNAUTHORIZED_CAPABILITY',
    });
  });

  it('waits for a mounted display and each output parse without buffering another chunk', async () => {
    const f = setup({ display: false }),
      mounted = vi.fn();
    const receiving = f.client.receive(reset()).then(mounted);
    await Promise.resolve();
    expect(mounted).not.toHaveBeenCalled();
    const parsed = deferred(),
      write = vi.fn((_data: Uint8Array) => parsed.promise);
    f.client.attachDisplay({ reset: f.display.reset, write });
    await receiving;
    const bytes = new TextEncoder().encode('\u001b[38;5;196m🐈\u001b[0m');
    const completed = vi.fn();
    const output = f.client
      .receive({ type: Message.TERM_OUTPUT, payload: bytes })
      .then(completed);
    await vi.waitFor(() =>
      expect(write).toHaveBeenCalledExactlyOnceWith(bytes),
    );
    expect(completed).not.toHaveBeenCalled();
    expect(write.mock.calls[0]?.[0]).toBe(bytes);
    parsed.resolve();
    await output;
    expect(completed).toHaveBeenCalledWith(true);
    for (const payload of [
      new Uint8Array(0),
      new Uint8Array(TERMINAL_CHUNK_BYTES + 1),
    ])
      await expect(
        f.client.receive({ type: Message.TERM_OUTPUT, payload }),
      ).rejects.toMatchObject({ code: 'BAD_FRAME' });
  });

  it('copies raw input into ordered 32 KiB frames and counts the in-flight frame in the 256 KiB limit', async () => {
    const blocked = deferred();
    let concurrent = 0,
      maximum = 0;
    const f = setup({
      send: async () => {
        maximum = Math.max(maximum, ++concurrent);
        await blocked.promise;
        concurrent--;
      },
    });
    await f.ready();
    const data = Uint8Array.from(
        { length: TERMINAL_INPUT_BYTES },
        (_, i) => i % 251,
      ),
      expected = data.slice();
    expect(f.client.input(new Uint8Array())).toBe(false);
    expect(f.client.input(data)).toBe(true);
    data.fill(0);
    expect(f.sent).toHaveLength(1);
    expect(f.client.inspect().queuedBytes).toBe(TERMINAL_INPUT_BYTES);
    expect(f.client.input(Uint8Array.of(1))).toBe(false);
    expect(f.client.inspect()).toMatchObject({
      backpressure: true,
      error: { code: 'BACKPRESSURE' },
    });
    blocked.resolve();
    await vi.waitFor(() =>
      expect(f.client.inspect().queuedBytes).toBe(
        TERMINAL_INPUT_BYTES - TERMINAL_CHUNK_BYTES,
      ),
    );
    expect(f.sent).toHaveLength(1);
    expect(f.client.resumeInput()).toBe(true);
    await vi.waitFor(() => expect(f.client.inspect().queuedBytes).toBe(0));
    expect(maximum).toBe(1);
    expect(f.sent.map((frame) => frame.payload.length)).toEqual([
      ...Array<number>(8).fill(TERMINAL_CHUNK_BYTES),
      16,
    ]);
    expect(
      Uint8Array.from(f.sent.flatMap((frame) => [...frame.payload])),
    ).toEqual(expected);
    expect(f.client.resumeInput()).toBe(false);
  });

  it('pauses on host backpressure, never retries sent bytes and visibly rejects an oversized paste atomically', async () => {
    const blocked = deferred(),
      f = setup({ send: () => blocked.promise });
    await f.ready();
    expect(
      f.client.input(new Uint8Array(TERMINAL_CHUNK_BYTES + 1).fill(9)),
    ).toBe(true);
    expect(f.client.reject(new ProtocolError('BACKPRESSURE'))).toBe(true);
    blocked.resolve();
    await vi.waitFor(() => expect(f.client.inspect().queuedBytes).toBe(1));
    expect(f.client.canInput()).toBe(false);
    f.client.resumeInput();
    await vi.waitFor(() => expect(f.sent).toHaveLength(2));
    expect(f.sent[1]?.payload).toEqual(Uint8Array.of(9));
    await vi.waitFor(() => expect(f.client.inspect().queuedBytes).toBe(0));
    expect(f.client.input(new Uint8Array(TERMINAL_INPUT_BYTES + 1))).toBe(
      false,
    );
    expect(f.client.inspect().queuedBytes).toBe(0);
    expect(f.sent).toHaveLength(2);
  });

  it('clears old input and waits for an ordered post-state PONG after a new generation', async () => {
    const blocked = deferred(),
      f = setup({ send: () => blocked.promise });
    await f.ready();
    f.client.input(new Uint8Array(TERMINAL_CHUNK_BYTES + 10).fill(3));
    await f.client.receive(reset(2));
    f.client.pongSent();
    expect(f.client.inspect().synchronizing).toBe(true);
    await f.client.receive(state('running', 2));
    expect(f.client.canControl('restart')).toBe(false);
    expect(f.client.input(Uint8Array.of(4))).toBe(false);
    await f.client.receive(reset(2));
    await f.client.receive(state('running', 2));
    blocked.resolve();
    await vi.waitFor(() => expect(f.client.inspect().queuedBytes).toBe(0));
    expect(f.sent).toHaveLength(1);
    f.client.pongSent();
    f.client.pongSent();
    expect(f.client.input(Uint8Array.of(5))).toBe(true);
    await vi.waitFor(() => expect(f.sent).toHaveLength(2));
    expect(f.sent[1]?.payload).toEqual(Uint8Array.of(5));
    for (const frame of [reset(1), reset(4), state('running', 1)])
      await expect(f.client.receive(frame)).rejects.toMatchObject({
        code: 'BAD_FRAME',
      });
  });

  it('rearms input synchronization when starting and running reset the same restarted generation', async () => {
    const f = setup();
    await f.ready();
    expect(f.client.control('restart')).toBe(true);
    await f.client.receive(reset(2));
    await f.client.receive(state('starting', 2));
    f.client.pongSent();
    // The native owner can publish starting before PTY creation, then replace
    // that empty snapshot with the running pump in this same generation.
    await f.client.receive(reset(2));
    await f.client.receive(state('running', 2));
    expect(f.client.inspect().synchronizing).toBe(true);
    expect(f.client.input(Uint8Array.of(120))).toBe(false);
    expect(f.sent.map((frame) => frame.type)).toEqual([
      Message.PROCESS_CONTROL,
    ]);
    f.client.pongSent();
    expect(f.client.canInput()).toBe(true);
    expect(f.client.input(Uint8Array.of(120))).toBe(true);
    await vi.waitFor(() => expect(f.sent).toHaveLength(2));
    expect(f.sent[1]).toEqual({
      type: Message.TERM_INPUT,
      payload: Uint8Array.of(120),
    });
  });

  it('requires an interrupt acknowledgment before accepting the return to running', async () => {
    const f = setup();
    await f.ready();
    expect(f.client.control('interrupt')).toBe(true);
    await vi.waitFor(() => expect(f.sent).toHaveLength(1));
    await f.client.receive(state('running'));
    expect(f.client.inspect().pendingControl).toBe('interrupt');
    expect(f.client.canInput()).toBe(false);
    await f.client.receive(state('interrupting'));
    expect(f.client.inspect().pendingControl).toBeUndefined();
    await f.client.receive(state('running'));
    expect(f.client.inspect().process?.state).toBe('running');
    expect(f.client.input(Uint8Array.of(113))).toBe(true);
    await vi.waitFor(() => expect(f.sent).toHaveLength(2));
    expect(f.sent[1]).toEqual({
      type: Message.TERM_INPUT,
      payload: Uint8Array.of(113),
    });
    expect(f.client.canControl('interrupt')).toBe(true);
  });

  it('coalesces resize, validates bounds and sends one authorized control with the current generation', async () => {
    const blocked = deferred(),
      f = setup({ send: () => blocked.promise });
    await f.ready();
    f.client.resize(90, 30);
    f.client.resize(100, 40);
    f.client.resize(120, 50);
    expect(f.client.control('terminate')).toBe(true);
    expect(f.client.control('restart')).toBe(false);
    await f.client.receive(state());
    expect(f.client.inspect().pendingControl).toBe('terminate');
    await f.client.receive(state('interrupting'));
    expect(f.client.inspect().pendingControl).toBe('terminate');
    blocked.resolve();
    await vi.waitFor(() => expect(f.sent).toHaveLength(3));
    expect(f.sent.map((frame) => frame.type)).toEqual([
      Message.TERM_RESIZE,
      Message.PROCESS_CONTROL,
      Message.TERM_RESIZE,
    ]);
    expect(decodeProcessControl(f.sent[1]!.payload)).toEqual({
      action: 'terminate',
      generation: 1,
    });
    const size = new DataView(f.sent[2]!.payload.buffer);
    expect([size.getUint16(0), size.getUint16(2)]).toEqual([120, 50]);
    await f.client.receive(state('terminating'));
    expect(f.client.inspect().pendingControl).toBeUndefined();
    expect(f.client.canInput()).toBe(false);
    for (const [cols, rows] of [
      [19, 5],
      [501, 5],
      [20, 4],
      [20, 201],
      [NaN, 5],
      [20, 5.5],
    ])
      expect(() => f.client.resize(cols!, rows!)).toThrow(ProtocolError);
  });

  it('keeps exit time and dropped bytes authoritative, rejects regressions and permits only restart after exit', async () => {
    const f = setup();
    await f.ready();
    await f.client.receive(
      json(Message.OUTPUT_DROPPED, { generation: 1, dropped_bytes: 4096 }),
    );
    await f.client.receive(
      json(Message.OUTPUT_DROPPED, { generation: 1, dropped_bytes: 4096 }),
    );
    expect(f.client.inspect().droppedBytes).toBe(4096);
    for (const [generation, dropped_bytes] of [
      [1, 4095],
      [2, 4097],
    ])
      await expect(
        f.client.receive(
          json(Message.OUTPUT_DROPPED, { generation, dropped_bytes }),
        ),
      ).rejects.toThrow(ProtocolError);
    await f.client.receive(state('exited'));
    const ended = f.client.inspect().endedAt;
    expect(ended).toBeTypeOf('number');
    await f.client.receive(state('exited'));
    expect(f.client.inspect().endedAt).toBe(ended);
    expect(f.client.canControl('restart')).toBe(true);
    expect(f.client.canControl('interrupt')).toBe(false);
    expect(f.client.canInput()).toBe(false);
    await f.client.receive(reset(2));
    expect(f.client.inspect()).toMatchObject({
      droppedBytes: 0,
      endedAt: undefined,
      process: undefined,
    });
  });

  it('keeps readonly and disabled actions inert and distinguishes recoverable host denials', async () => {
    const f = setup({ capabilities: ['terminal_output'] });
    await f.ready();
    expect(f.client.canInput()).toBe(false);
    expect(f.client.resize(80, 24)).toBe(false);
    for (const action of ['interrupt', 'restart', 'terminate'] as const)
      expect(f.client.control(action)).toBe(false);
    expect(f.sent).toEqual([]);
    const writable = setup();
    await writable.ready();
    for (const code of [
      'READONLY',
      'PROCESS_NOT_RUNNING',
      'RESTART_DISABLED',
      'TERMINATE_DISABLED',
      'UNAUTHORIZED_CAPABILITY',
    ] as const) {
      expect(writable.client.reject(new ProtocolError(code))).toBe(true);
      expect(writable.client.inspect().error?.code).toBe(code);
      if (code === 'READONLY') expect(writable.client.canInput()).toBe(false);
    }
    expect(writable.client.reject(new ProtocolError('EXPIRED'))).toBe(false);
  });

  it('disposes pending mount/output waits, clears queued input and makes stale calls inert', async () => {
    const f = setup({ display: false });
    const waiting = f.client.receive(reset());
    f.client.dispose();
    f.client.dispose();
    await expect(waiting).resolves.toBe(true);
    expect(() => f.client.attachDisplay(f.display)).toThrow(
      TerminalDisplayError,
    );
    expect(await f.client.receive(reset())).toBe(false);
    expect(f.client.resize(80, 24)).toBe(false);
    expect(f.client.resumeInput()).toBe(false);
    const g = setup(),
      neverParsed = deferred();
    await g.ready();
    g.display.write.mockReturnValue(neverParsed.promise);
    const output = g.client.receive({
      type: Message.TERM_OUTPUT,
      payload: Uint8Array.of(1),
    });
    await vi.waitFor(() => expect(g.display.write).toHaveBeenCalled());
    g.client.dispose();
    await expect(output).resolves.toBe(true);
    expect(g.client.inspect()).toMatchObject({ stopped: true, queuedBytes: 0 });
    const blocked = deferred(),
      h = setup({ send: () => blocked.promise });
    await h.ready();
    h.client.input(new Uint8Array(40_000).fill(9));
    h.client.dispose();
    blocked.resolve();
    await vi.waitFor(() => expect(h.client.inspect().queuedBytes).toBe(0));
    expect(h.sent).toHaveLength(1);
  });

  it('reports renderer faults safely and stops after a send failure', async () => {
    const f = setup();
    await f.ready();
    f.display.write.mockRejectedValue(new Error('private renderer detail'));
    await expect(
      f.client.receive({
        type: Message.TERM_OUTPUT,
        payload: Uint8Array.of(1),
      }),
    ).rejects.toThrow(new TerminalDisplayError());
    f.client.failDisplay();
    f.client.failDisplay();
    expect(f.fail).toHaveBeenCalledExactlyOnceWith(new TerminalDisplayError());
    const error = new Error('send failure'),
      g = setup({
        send: async () => {
          throw error;
        },
      });
    await g.ready();
    g.client.input(Uint8Array.of(1));
    await vi.waitFor(() =>
      expect(g.fail).toHaveBeenCalledExactlyOnceWith(error),
    );
    expect(g.client.inspect()).toMatchObject({ stopped: true, queuedBytes: 0 });
  });
});
