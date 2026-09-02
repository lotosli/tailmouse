import { afterEach, describe, expect, it, vi } from 'vitest';

import { exchangeHello, runSpike } from './spike.ts';
import type { ByteStream } from './transport/tailcat/adapter.ts';

const adapter = vi.hoisted(() => ({
  dialTailcat: vi.fn(),
  loadTailcat: vi.fn(),
}));

vi.mock('./transport/tailcat/adapter.ts', async (importOriginal) => ({
  ...(await importOriginal()),
  dialTailcat: adapter.dialTailcat,
  loadTailcat: adapter.loadTailcat,
}));

afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('M0 hello echo', () => {
  it('writes one bounded hello and accepts a fragmented exact echo', async () => {
    const { stream, writes } = fakeStream([
      new TextEncoder().encode('TMOUSE-'),
      new TextEncoder().encode('M0-HELLO'),
    ]);
    await expect(
      exchangeHello(stream, new AbortController().signal),
    ).resolves.toBe('TMOUSE-M0-HELLO');
    expect(writes).toEqual([new TextEncoder().encode('TMOUSE-M0-HELLO')]);
  });

  it('rejects truncated, empty, oversized, altered, timed out, and canceled echoes', async () => {
    const cases: Array<Array<Uint8Array | null>> = [
      [null],
      [new Uint8Array()],
      [new Uint8Array(17)],
      [new TextEncoder().encode('TMOUSE-M0-MEOW!')],
    ];
    for (const chunks of cases) {
      const { stream } = fakeStream(chunks);
      await expect(
        exchangeHello(stream, new AbortController().signal),
      ).rejects.toMatchObject({ name: 'EchoError' });
    }

    vi.useFakeTimers();
    const pending = exchangeHello(
      fakeStream([]).stream,
      new AbortController().signal,
      5,
    );
    const timedOut = expect(pending).rejects.toMatchObject({
      message: expect.stringContaining('timed out'),
    });
    await vi.advanceTimersByTimeAsync(5);
    await timedOut;

    const canceled = new AbortController();
    canceled.abort();
    await expect(
      exchangeHello(fakeStream([]).stream, canceled.signal),
    ).rejects.toMatchObject({ code: 'CANCELED' });
    await expect(
      exchangeHello(fakeStream([]).stream, new AbortController().signal, 0),
    ).rejects.toMatchObject({ message: expect.stringContaining('timed out') });
  });

  it('runs every stage through the TailMouse transport boundary and closes once', async () => {
    let echoed: Uint8Array | undefined;
    const close = vi.fn(async () => undefined);
    const stream: ByteStream = {
      close,
      read: vi.fn(async () => echoed ?? null),
      write: vi.fn(async (data: Uint8Array) => {
        echoed = data.slice();
      }),
    };
    adapter.loadTailcat.mockResolvedValue(undefined);
    adapter.dialTailcat.mockResolvedValue(stream);
    const stages: string[] = [];
    await expect(
      runSpike(
        'tcSyntheticBrowserCredential',
        new AbortController().signal,
        (stage) => {
          stages.push(stage);
        },
      ),
    ).resolves.toBe('TMOUSE-M0-HELLO');
    expect(stages).toEqual([
      'loading',
      'connecting',
      'establishing',
      'complete',
    ]);
    expect(close).toHaveBeenCalledOnce();
  });
});

function fakeStream(chunks: Array<Uint8Array | null>): {
  stream: ByteStream;
  writes: Uint8Array[];
} {
  const writes: Uint8Array[] = [];
  return {
    stream: {
      close: async () => undefined,
      read: async () =>
        chunks.length === 0
          ? new Promise<never>(() => {})
          : (chunks.shift() ?? null),
      write: async (data) => {
        writes.push(data);
      },
    },
    writes,
  };
}
