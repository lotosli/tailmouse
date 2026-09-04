import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  TailcatTransportError,
  dialTailcat,
  type ByteStream,
} from './adapter.ts';

const secret = 'tcSyntheticBearerCredential';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('loadTailcat', () => {
  it('loads only local runtime assets and waits for bridge readiness', async () => {
    vi.resetModules();
    const { loadTailcat } = await import('./adapter.ts');
    const dial = vi.fn();
    const run = vi.fn(() => {
      vi.stubGlobal('tailcatDial', dial);
      getRuntimeGlobal().onTailcatReady?.();
    });
    installLocation();
    installScriptLoader(() => {
      vi.stubGlobal(
        'Go',
        class {
          readonly importObject = {};
          readonly run = run;
        },
      );
    });
    const response = wasmResponse();
    const fetchMock = vi.fn(async () => response);
    vi.stubGlobal('fetch', fetchMock);
    const instantiate = vi.fn(async (source: Response) => {
      await source.arrayBuffer();
      return { instance: {} as WebAssembly.Instance };
    });
    vi.stubGlobal('WebAssembly', { instantiateStreaming: instantiate });

    await loadTailcat({
      runtimeScriptURL: './assets/wasm_exec.js',
      wasmURL: './assets/tailcat.wasm',
      timeoutMs: 100,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      new URL('https://tailmouse.test/app/assets/tailcat.wasm'),
      expect.objectContaining({
        cache: 'force-cache',
        credentials: 'same-origin',
        referrerPolicy: 'no-referrer',
      }),
    );
    expect(instantiate).toHaveBeenCalledWith(expect.any(Response), {});
    expect(response.bodyUsed).toBe(true);
    expect(run).toHaveBeenCalledOnce();
  });

  it('rejects remote, credentialed, and fragmented asset URLs', async () => {
    vi.resetModules();
    const { loadTailcat } = await import('./adapter.ts');
    installLocation();
    for (const runtimeScriptURL of [
      'https://cdn.example/wasm_exec.js',
      'https://user@tailmouse.test/wasm_exec.js',
      './wasm_exec.js#credential',
    ]) {
      await expect(
        loadTailcat({ runtimeScriptURL, timeoutMs: 10 }),
      ).rejects.toMatchObject({ code: 'ASSET_URL_INVALID' });
    }
  });

  it('classifies script, runtime, fetch, compile, and readiness failures', async () => {
    vi.resetModules();
    const scriptFailure = await import('./adapter.ts');
    installLocation();
    installScriptLoader(undefined, true);
    await expect(
      scriptFailure.loadTailcat({ timeoutMs: 50 }),
    ).rejects.toMatchObject({
      code: 'RUNTIME_SCRIPT_FAILED',
    });

    vi.resetModules();
    installLocation();
    installScriptLoader(() => {});
    const missingRuntime = await import('./adapter.ts');
    await expect(
      missingRuntime.loadTailcat({ timeoutMs: 50 }),
    ).rejects.toMatchObject({
      code: 'RUNTIME_MISSING',
    });

    vi.resetModules();
    installLocation();
    installGo(() => {});
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false })),
    );
    const badFetch = await import('./adapter.ts');
    await expect(badFetch.loadTailcat({ timeoutMs: 50 })).rejects.toMatchObject(
      {
        code: 'WASM_FETCH_FAILED',
      },
    );

    vi.resetModules();
    installLocation();
    installGo(() => {});
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => wasmResponse()),
    );
    vi.stubGlobal('WebAssembly', {
      instantiateStreaming: vi.fn(async () => {
        throw new Error(secret);
      }),
    });
    const badCompile = await import('./adapter.ts');
    await expect(
      badCompile.loadTailcat({ timeoutMs: 50 }),
    ).rejects.toMatchObject({
      code: 'WASM_COMPILE_FAILED',
    });

    vi.resetModules();
    installLocation();
    installGo(() => new Promise<void>(() => {}));
    installSuccessfulFetch();
    const timeout = await import('./adapter.ts');
    await expect(timeout.loadTailcat({ timeoutMs: 5 })).rejects.toMatchObject({
      code: 'LOAD_TIMEOUT',
    });
  });
});

describe('Wasm download progress', () => {
  it.each(['network', 'status', 'no-body'] as const)(
    'rejects %s before compilation without claiming complete progress',
    async (failure) => {
      vi.resetModules();
      const { loadTailcat } = await import('./adapter.ts');
      installLocation();
      installGo(() => {});
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          if (failure === 'network') throw new Error(secret);
          return new Response(null, {
            status: failure === 'status' ? 503 : 200,
          });
        }),
      );
      const compile = vi.fn();
      vi.stubGlobal('WebAssembly', { instantiateStreaming: compile });
      const progress: number[] = [];
      await expect(
        loadTailcat({ onProgress: (value) => progress.push(value) }),
      ).rejects.toMatchObject({
        code: 'WASM_FETCH_FAILED',
        message: 'Tailcat WebAssembly failed to download.',
      });
      expect(progress).toEqual([0]);
      expect(compile).not.toHaveBeenCalled();
    },
  );

  it.each([
    { headers: { 'Content-Length': '16' }, bytes: 16 },
    {
      headers: { 'Content-Length': '8', 'Content-Encoding': 'identity' },
      bytes: 8,
    },
    {
      headers: { 'Content-Length': '4', 'Content-Encoding': 'gzip' },
      bytes: 8,
    },
    { headers: {}, bytes: 8 },
    { headers: { 'Content-Length': 'invalid' }, bytes: 8 },
    { headers: { 'Content-Length': '-1' }, bytes: 8 },
    { headers: { 'Content-Length': '1.5' }, bytes: 8 },
  ])('counts one decoded stream with $headers', async ({ headers, bytes }) => {
    vi.resetModules();
    const { loadTailcat } = await import('./adapter.ts');
    installLocation();
    installGo(() => {
      vi.stubGlobal('tailcatDial', vi.fn());
      getRuntimeGlobal().onTailcatReady?.();
    });
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(value) {
        controller = value;
      },
    });
    const source = new Response(body, {
      headers: { ...headers, 'Content-Type': 'application/wasm' },
    });
    const fetch = vi.fn(async () => source);
    vi.stubGlobal('fetch', fetch);
    let consumed: ArrayBuffer | undefined;
    const compile = vi.fn(async (response: Response) => {
      consumed = await response.arrayBuffer();
      return { instance: {} as WebAssembly.Instance };
    });
    vi.stubGlobal('WebAssembly', { instantiateStreaming: compile });
    const progress: number[] = [];
    const pending = loadTailcat({
      timeoutMs: 2000,
      onProgress: (value) => progress.push(value),
    });
    await vi.waitFor(() => expect(compile).toHaveBeenCalledOnce());
    expect(progress).toEqual([0]);
    for (const percent of [25, 50, 75, 99]) {
      controller.enqueue(new Uint8Array());
      controller.enqueue(new Uint8Array(bytes / 4).fill(42));
      await vi.waitFor(() => expect(progress.at(-1)).toBe(percent));
    }
    expect(consumed).toBeUndefined();
    controller.close();
    await pending;
    expect(progress).toEqual([0, 25, 50, 75, 99, 100]);
    expect(new Uint8Array(consumed!)).toEqual(new Uint8Array(bytes).fill(42));
    expect(source.bodyUsed).toBe(true);
    expect(fetch).toHaveBeenCalledOnce();
    expect(compile.mock.calls[0]![0].headers.get('Content-Type')).toBe(
      'application/wasm',
    );
    const cachedProgress: number[] = [];
    await loadTailcat({ onProgress: (value) => cachedProgress.push(value) });
    expect(cachedProgress).toEqual([100]);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('cancels the owned body on early compilation failure and redacts errors', async () => {
    vi.resetModules();
    const { loadTailcat } = await import('./adapter.ts');
    installLocation();
    installGo(() => {});
    const canceled = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(new ReadableStream({ cancel: canceled }), {
            headers: { 'Content-Type': 'application/wasm' },
          }),
      ),
    );
    vi.stubGlobal('WebAssembly', {
      instantiateStreaming: vi.fn(async () => {
        throw new Error(secret);
      }),
    });
    const progress: number[] = [];
    await expect(
      loadTailcat({ onProgress: (value) => progress.push(value) }),
    ).rejects.toMatchObject({
      code: 'WASM_COMPILE_FAILED',
      message: 'Tailcat WebAssembly failed to initialize.',
    });
    await vi.waitFor(() => expect(canceled).toHaveBeenCalledOnce());
    expect(progress).not.toContain(100);
  });

  it.each(['abort', 'timeout', 'body-error'] as const)(
    'stops progress and releases a partial download on %s',
    async (failure) => {
      vi.useFakeTimers();
      vi.resetModules();
      const { loadTailcat } = await import('./adapter.ts');
      installLocation();
      installGo(() => {});
      const canceled = vi.fn();
      let body!: ReadableStreamDefaultController<Uint8Array>;
      vi.stubGlobal(
        'fetch',
        vi.fn(
          async () =>
            new Response(
              new ReadableStream<Uint8Array>({
                start(controller) {
                  body = controller;
                },
                cancel: canceled,
              }),
              { headers: { 'Content-Type': 'application/wasm' } },
            ),
        ),
      );
      const compile = vi.fn(async (response: Response) => {
        await response.arrayBuffer();
        return { instance: {} as WebAssembly.Instance };
      });
      vi.stubGlobal('WebAssembly', { instantiateStreaming: compile });
      const controller = new AbortController();
      const progress: number[] = [];
      const pending = loadTailcat({
        signal: controller.signal,
        timeoutMs: 2000,
        onProgress: (value) => progress.push(value),
      }).then(
        () => undefined,
        (error: unknown) => error,
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(compile).toHaveBeenCalledOnce();
      body.enqueue(new Uint8Array(4));
      await vi.advanceTimersByTimeAsync(0);
      expect(progress).toEqual([0, 50]);
      if (failure === 'abort') controller.abort();
      else if (failure === 'body-error') body.error(new Error(secret));
      else {
        await vi.advanceTimersByTimeAsync(1999);
        expect(canceled).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
      }
      const error = await pending;
      expect(error).toMatchObject({
        code:
          failure === 'abort'
            ? 'CANCELED'
            : failure === 'timeout'
              ? 'LOAD_TIMEOUT'
              : 'WASM_COMPILE_FAILED',
      });
      expect((error as Error).message).not.toContain(secret);
      await vi.advanceTimersByTimeAsync(0);
      expect(canceled).toHaveBeenCalledTimes(failure === 'body-error' ? 0 : 1);
      expect(progress).toEqual([0, 50]);
      expect(vi.getTimerCount()).toBe(0);

      // Failed attempts do not retain the previous percentage or runtime promise.
      installGo(() => {
        vi.stubGlobal('tailcatDial', vi.fn());
        getRuntimeGlobal().onTailcatReady?.();
      });
      installSuccessfulFetch();
      const retryProgress: number[] = [];
      await loadTailcat({ onProgress: (value) => retryProgress.push(value) });
      expect(retryProgress).toEqual([0, 99, 100]);
      expect(vi.getTimerCount()).toBe(0);
    },
  );
});

describe('dialTailcat', () => {
  it('uses port 44321 and exposes an owned bounded byte stream', async () => {
    const source = new Uint8Array([1, 2, 3]);
    const read = vi
      .fn<() => Promise<unknown>>()
      .mockResolvedValueOnce(source)
      .mockResolvedValueOnce(null);
    const write = vi.fn(async (_data: Uint8Array) => undefined);
    const close = vi.fn();
    const raw = {
      port: 44321,
      read,
      write,
      close,
      closeWrite: async () => undefined,
    };
    const dial = vi.fn(async () => raw);
    vi.stubGlobal('tailcatDial', dial);

    const stream = await dialTailcat(secret, { timeoutMs: 100 });
    expect(dial).toHaveBeenCalledWith({
      addr: secret,
      port: 44321,
      verbose: false,
    });
    const chunk = await stream.read();
    expect(chunk).toEqual(source);
    expect(chunk).not.toBe(source);
    expect(await stream.read()).toBeNull();
    const data = new Uint8Array([4, 5]);
    await stream.write(data);
    expect(write).toHaveBeenCalledWith(data);
    expect(write.mock.calls[0]?.[0]).not.toBe(data);
    await stream.close();
    await stream.close();
    expect(close).toHaveBeenCalledOnce();
    await expect(stream.read()).rejects.toMatchObject({
      code: 'STREAM_CLOSED',
    });
    await expect(stream.write(data)).rejects.toMatchObject({
      code: 'STREAM_CLOSED',
    });
  });

  it('half-closes, consumes EOF, then releases the runtime on graceful completion', async () => {
    const order: string[] = [];
    const stream = await streamFrom({
      closeWrite: async () => {
        order.push('fin');
      },
      read: async () => {
        order.push('eof');
        return null;
      },
      close: () => {
        order.push('close');
      },
    });
    await Promise.all([
      stream.close({ graceful: true }),
      stream.close({ graceful: true }),
    ]);
    expect(order).toEqual(['fin', 'eof', 'close']);
  });

  it('rejects unread data and half-close failures while still force-closing once', async () => {
    for (const overrides of [
      { read: async () => new Uint8Array([1]) },
      {
        closeWrite: async () => {
          throw new Error(secret);
        },
      },
    ]) {
      const close = vi.fn();
      const stream = await streamFrom({ ...overrides, close });
      await expect(stream.close({ graceful: true })).rejects.toSatisfy(
        safeError('CLOSE_FAILED'),
      );
      expect(close).toHaveBeenCalledOnce();
    }
  });

  it('bounds graceful close and raw close and honors cancellation', async () => {
    vi.useFakeTimers();
    const forceClose = vi.fn();
    const stream = await streamFrom({
      closeWrite: () => new Promise(() => {}),
      close: forceClose,
    });
    const result = stream
      .close({ graceful: true })
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(2000);
    expect(await result).toSatisfy(safeError('CLOSE_FAILED'));
    expect(forceClose).toHaveBeenCalledOnce();

    const stuck = await streamFrom({ close: () => new Promise(() => {}) });
    const stuckResult = stuck.close().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(2000);
    expect(await stuckResult).toSatisfy(safeError('CLOSE_FAILED'));

    const controller = new AbortController();
    controller.abort();
    const canceledClose = vi.fn();
    const canceled = await streamFrom({ close: canceledClose });
    await expect(
      canceled.close({ graceful: true, signal: controller.signal }),
    ).rejects.toSatisfy(safeError('CANCELED'));
    expect(canceledClose).toHaveBeenCalledOnce();
  });

  it('never creates a second reader when graceful close overlaps a read', async () => {
    let completeRead: ((value: unknown) => void) | undefined;
    const closeWrite = vi.fn(async () => undefined);
    const stream = await streamFrom({
      read: () =>
        new Promise((resolve) => {
          completeRead = resolve;
        }),
      closeWrite,
    });
    const read = stream.read();
    await expect(stream.close({ graceful: true })).rejects.toSatisfy(
      safeError('CLOSE_FAILED'),
    );
    expect(closeWrite).not.toHaveBeenCalled();
    completeRead?.(null);
    await expect(read).resolves.toBeNull();
  });

  it('closes malformed connection objects and reports no upstream detail', async () => {
    const close = vi.fn(() => {
      throw new Error(secret);
    });
    vi.stubGlobal(
      'tailcatDial',
      vi.fn(async () => ({ port: 1, close })),
    );
    await expect(dialTailcat(secret)).rejects.toSatisfy(
      safeError('CONNECTION_INCOMPATIBLE'),
    );
    expect(close).toHaveBeenCalledOnce();
  });

  it('bounds dial time and honors cancellation', async () => {
    vi.stubGlobal(
      'tailcatDial',
      vi.fn(() => new Promise(() => {})),
    );
    await expect(dialTailcat(secret, { timeoutMs: 5 })).rejects.toMatchObject({
      code: 'DIAL_TIMEOUT',
    });

    const controller = new AbortController();
    controller.abort();
    await expect(
      dialTailcat(secret, { signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'CANCELED' });
  });

  it.each([
    { rejectAt: 59_999, code: 'DIAL_FAILED' },
    { rejectAt: 60_001, code: 'DIAL_TIMEOUT' },
  ] as const)(
    'retains the first safe dial outcome when upstream rejects at $rejectAt ms',
    async ({ rejectAt, code }) => {
      vi.useFakeTimers();
      const dial = vi.fn(
        () =>
          new Promise((_, reject) => {
            setTimeout(() => reject(new Error(secret)), rejectAt);
          }),
      );
      vi.stubGlobal('tailcatDial', dial);
      const result = expect(dialTailcat(secret)).rejects.toSatisfy(
        safeError(code),
      );
      await vi.advanceTimersByTimeAsync(60_000);
      await result;
      await vi.advanceTimersByTimeAsync(1);
      expect(dial).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('redacts dial, read, write, and close failures', async () => {
    vi.stubGlobal(
      'tailcatDial',
      vi.fn(async () => {
        throw new Error(secret);
      }),
    );
    await expect(dialTailcat(secret)).rejects.toSatisfy(
      safeError('DIAL_FAILED'),
    );

    const readStream = await streamFrom({
      read: async () => {
        throw new Error(secret);
      },
    });
    await expect(readStream.read()).rejects.toSatisfy(safeError('READ_FAILED'));

    const writeStream = await streamFrom({
      write: async () => {
        throw new Error(secret);
      },
    });
    await expect(writeStream.write(new Uint8Array([1]))).rejects.toSatisfy(
      safeError('WRITE_FAILED'),
    );

    const closeStream = await streamFrom({
      close: () => {
        throw new Error(secret);
      },
    });
    await expect(closeStream.close()).rejects.toSatisfy(
      safeError('CLOSE_FAILED'),
    );
  });

  it('rejects malformed, oversized, and concurrent stream operations', async () => {
    const oversized = new Uint8Array((1 << 20) + 1);
    const malformedRead = await streamFrom({ read: async () => secret });
    await expect(malformedRead.read()).rejects.toMatchObject({
      code: 'READ_FAILED',
    });

    const oversizedRead = await streamFrom({ read: async () => oversized });
    await expect(oversizedRead.read()).rejects.toMatchObject({
      code: 'CHUNK_TOO_LARGE',
    });

    const oversizedWrite = await streamFrom();
    await expect(oversizedWrite.write(oversized)).rejects.toMatchObject({
      code: 'CHUNK_TOO_LARGE',
    });

    let releaseRead: (() => void) | undefined;
    const concurrentRead = await streamFrom({
      read: () =>
        new Promise<null>((resolve) => {
          releaseRead = () => resolve(null);
        }),
    });
    const pendingRead = concurrentRead.read();
    await expect(concurrentRead.read()).rejects.toMatchObject({
      code: 'READ_IN_PROGRESS',
    });
    releaseRead?.();
    await pendingRead;

    let releaseWrite: (() => void) | undefined;
    const concurrentWrite = await streamFrom({
      write: () =>
        new Promise<void>((resolve) => {
          releaseWrite = resolve;
        }),
    });
    const pendingWrite = concurrentWrite.write(new Uint8Array([1]));
    await expect(
      concurrentWrite.write(new Uint8Array([2])),
    ).rejects.toMatchObject({
      code: 'WRITE_IN_PROGRESS',
    });
    releaseWrite?.();
    await pendingWrite;
  });
});

function installLocation(): void {
  vi.stubGlobal('location', {
    href: 'https://tailmouse.test/app/',
    origin: 'https://tailmouse.test',
  });
}

function installScriptLoader(onLoad?: () => void, fail = false): void {
  const head = {
    append: vi.fn((script: HTMLScriptElement) => {
      queueMicrotask(() => {
        if (fail) {
          script.onerror?.(new Event('error'));
        } else {
          onLoad?.();
          script.onload?.(new Event('load'));
        }
      });
    }),
  };
  vi.stubGlobal('document', {
    createElement: vi.fn(() => ({
      async: false,
      onerror: null,
      onload: null,
      remove: vi.fn(),
      src: '',
    })),
    head,
  });
}

function installGo(run: () => Promise<void> | void): void {
  vi.stubGlobal(
    'Go',
    class {
      readonly importObject = {};
      readonly run = run;
    },
  );
}

function installSuccessfulFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => wasmResponse()),
  );
  vi.stubGlobal('WebAssembly', {
    instantiateStreaming: vi.fn(async (response: Response) => {
      await response.arrayBuffer();
      return { instance: {} as WebAssembly.Instance };
    }),
  });
}

function wasmResponse(): Response {
  return new Response(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]), {
    headers: { 'Content-Type': 'application/wasm', 'Content-Length': '8' },
  });
}

function getRuntimeGlobal(): typeof globalThis & {
  onTailcatReady?: () => void;
} {
  return globalThis as typeof globalThis & { onTailcatReady?: () => void };
}

function safeError(code: string): (error: unknown) => boolean {
  return (error: unknown): boolean =>
    error instanceof TailcatTransportError &&
    error.code === code &&
    !error.message.includes(secret);
}

async function streamFrom(
  overrides: Partial<{
    read(): Promise<unknown>;
    write(data: Uint8Array): Promise<unknown>;
    closeWrite(): Promise<unknown>;
    close(): unknown;
  }> = {},
): Promise<ByteStream> {
  const raw = {
    port: 44321,
    read: async () => null,
    write: async (_data: Uint8Array) => undefined,
    close: () => undefined,
    closeWrite: async () => undefined,
    ...overrides,
  };
  vi.stubGlobal(
    'tailcatDial',
    vi.fn(async () => raw),
  );
  return dialTailcat(secret);
}
