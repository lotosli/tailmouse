import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ResourceTransport } from './resource.ts';

class TransportWorker {
  static current: TransportWorker;
  onmessage: ((event: MessageEvent) => void) | undefined;
  onerror: (() => void) | undefined;
  messages: { id: number; op: string; value: unknown }[] = [];
  stopped = false;
  constructor() {
    TransportWorker.current = this;
  }
  postMessage(message: { id: number; op: string; value: unknown }) {
    this.messages.push(message);
  }
  terminate() {
    this.stopped = true;
  }
  reply(value?: unknown, ok = true) {
    const message = this.messages.shift()!;
    this.onmessage?.({ data: { id: message.id, ok, value } } as MessageEvent);
  }
}
const transports: ResourceTransport[] = [];
function transport() {
  const value = new ResourceTransport();
  transports.push(value);
  return value;
}
beforeEach(() => {
  vi.stubGlobal('Worker', TransportWorker);
});
afterEach(() => {
  for (const value of transports.splice(0)) value.close();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('resource worker boundary', () => {
  it('reports runtime readiness only after load completes and opens before dialing', async () => {
    const value = transport();
    const loaded = vi.fn();
    const start = value.start('synthetic-address', '', loaded);
    const worker = TransportWorker.current;
    expect(loaded).not.toHaveBeenCalled();
    expect(worker.messages[0]?.op).toBe('load');
    worker.reply();
    await Promise.resolve();
    expect(loaded).toHaveBeenCalledOnce();
    expect(worker.messages[0]?.op).toBe('open');
    worker.reply('synthetic-key');
    expect(await start).toBe('synthetic-key');
    const dialing = value.dial(3);
    worker.reply(9);
    const stream = await dialing;
    const reading = stream.read();
    worker.reply(new Uint8Array([1, 2]));
    expect(await reading).toEqual(new Uint8Array([1, 2]));
    const writing = stream.write(new Uint8Array([3]));
    worker.reply();
    await writing;
    const ended = stream.read();
    worker.reply(null);
    expect(await ended).toBeNull();
    const closing = stream.close();
    worker.reply();
    await closing;
    await stream.close();
    await expect(stream.write(new Uint8Array())).rejects.toThrow('closed');
  });
  it('fails bounded operations and never returns worker error detail', async () => {
    vi.useFakeTimers();
    const value = transport();
    const worker = TransportWorker.current;
    const call = value.call('test', 0, null, 10);
    const rejected = expect(call).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(11);
    await rejected;
    worker.messages.shift();
    const failed = value.call('test', 0, null);
    const failure = expect(failed).rejects.toThrow(
      'Transport operation failed.',
    );
    worker.reply('synthetic-private-address', false);
    await failure;
    const pending = Array.from({ length: 160 }, () =>
      value.call('read', 1, null).catch((e: unknown) => e),
    );
    await expect(value.call('read', 1, null)).rejects.toThrow('unavailable');
    worker.onmessage?.({ data: { fatal: true } } as MessageEvent);
    expect(worker.stopped).toBe(true);
    expect(
      (await Promise.all(pending)).every(
        (e) => e instanceof Error && e.message === 'Transport closed.',
      ),
    ).toBe(true);
    await expect(value.call('read', 1, null)).rejects.toThrow('unavailable');
  });
  it('rejects invalid identity, stream ids and stream payloads', async () => {
    const value = transport();
    const worker = TransportWorker.current;
    const start = value.start('', '');
    worker.reply();
    await Promise.resolve();
    worker.reply(123);
    await expect(start).rejects.toThrow('identity');
    const badDial = value.dial();
    worker.reply('not-a-number');
    await expect(badDial).rejects.toThrow('stream unavailable');
    const goodDial = value.dial();
    worker.reply(1);
    const stream = await goodDial;
    const read = stream.read();
    worker.reply('not-bytes');
    await expect(read).rejects.toThrow('Invalid transport data');
    worker.onerror?.();
    expect(worker.stopped).toBe(true);
  });
  it('gives an actionable unsupported-browser signal before creating a worker', () => {
    vi.stubGlobal('Worker', undefined);
    expect(() => transport()).toThrow('BROWSER_UNSUPPORTED');
  });
});
