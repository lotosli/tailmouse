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
    const response = { ok: true } as Response;
    const fetchMock = vi.fn(async () => response);
    vi.stubGlobal('fetch', fetchMock);
    const instantiate = vi.fn(async () => ({
      instance: {} as WebAssembly.Instance,
    }));
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
    expect(instantiate).toHaveBeenCalledWith(response, {});
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
      vi.fn(async () => ({ ok: true })),
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

describe('dialTailcat', () => {
  it('uses port 44321 and exposes an owned bounded byte stream', async () => {
    const source = new Uint8Array([1, 2, 3]);
    const read = vi
      .fn<() => Promise<unknown>>()
      .mockResolvedValueOnce(source)
      .mockResolvedValueOnce(null);
    const write = vi.fn(async (_data: Uint8Array) => undefined);
    const close = vi.fn();
    const raw = { port: 44321, read, write, close };
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
    vi.fn(async () => ({ ok: true })),
  );
  vi.stubGlobal('WebAssembly', {
    instantiateStreaming: vi.fn(async () => ({
      instance: {} as WebAssembly.Instance,
    })),
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
    close(): unknown;
  }> = {},
): Promise<ByteStream> {
  const raw = {
    port: 44321,
    read: async () => null,
    write: async (_data: Uint8Array) => undefined,
    close: () => undefined,
    ...overrides,
  };
  vi.stubGlobal(
    'tailcatDial',
    vi.fn(async () => raw),
  );
  return dialTailcat(secret);
}
