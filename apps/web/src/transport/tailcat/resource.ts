import type { ByteStream } from './adapter.ts';

declare const __TAILMOUSE_RESOURCE_ASSETS__: {
  runtime: string;
  wasm: string;
  bytes: number;
};
export class ResourceTransport {
  readonly #worker: Worker;
  readonly #pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  #next = 0;
  #closed = false;
  constructor() {
    if (
      typeof Worker === 'undefined' ||
      typeof WebAssembly === 'undefined' ||
      typeof ReadableStream === 'undefined' ||
      typeof ArrayBuffer.prototype.transfer !== 'function'
    )
      throw new Error('BROWSER_UNSUPPORTED');
    this.#worker = new Worker(
      new URL('./resource-worker.ts', import.meta.url),
      { type: 'module', name: 'TailMouse transport' },
    );
    this.#worker.onmessage = (
      event: MessageEvent<{
        id?: number;
        ok?: boolean;
        value?: unknown;
        fatal?: boolean;
      }>,
    ) => {
      if (event.data.fatal === true) {
        this.close();
        return;
      }
      const entry = this.#pending.get(event.data.id ?? -1);
      if (entry === undefined) return;
      this.#pending.delete(event.data.id!);
      clearTimeout(entry.timer);
      if (event.data.ok === true) entry.resolve(event.data.value);
      else entry.reject(new Error('Transport operation failed.'));
    };
    this.#worker.onerror = () => this.close();
  }
  async start(
    address: string,
    key: string,
    loaded?: () => void,
  ): Promise<string> {
    await this.call('load', 0, null, 60_000);
    loaded?.();
    const value = await this.call('open', 0, { address, key }, 65_000);
    if (typeof value !== 'string' || value.length > 512)
      throw new Error('Invalid transport identity.');
    return value;
  }
  call(
    op: string,
    stream: number,
    value: unknown,
    timeout = 35_000,
  ): Promise<unknown> {
    if (this.#closed || this.#pending.size >= 160)
      return Promise.reject(new Error('Transport unavailable.'));
    const id = ++this.#next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error('Transport operation timed out.'));
      }, timeout);
      this.#pending.set(id, { resolve, reject, timer });
      this.#worker.postMessage({
        id,
        op,
        stream,
        value,
        ...(op === 'load' ? { assets: __TAILMOUSE_RESOURCE_ASSETS__ } : {}),
      });
    });
  }
  async dial(priority = 0): Promise<ByteStream> {
    const id = await this.call('dial', 0, priority);
    if (typeof id !== 'number')
      throw new Error('Transport stream unavailable.');
    let closed = false;
    return {
      read: async () => {
        const value = await this.call('read', id, null, 0x7fffffff);
        if (value === null || value instanceof Uint8Array) return value;
        throw new Error('Invalid transport data.');
      },
      write: async (data) => {
        if (closed) throw new Error('Stream closed.');
        await this.call('write', id, data);
      },
      close: async () => {
        if (!closed) {
          closed = true;
          await this.call('close', id, null);
        }
      },
    };
  }
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#worker.terminate();
    for (const item of this.#pending.values()) {
      clearTimeout(item.timer);
      item.reject(new Error('Transport closed.'));
    }
    this.#pending.clear();
  }
}
