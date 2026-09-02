const VIRTUAL_PORT = 44321;
const MAX_CHUNK_BYTES = 1 << 20;
const DEFAULT_LOAD_TIMEOUT_MS = 30_000;
const DEFAULT_DIAL_TIMEOUT_MS = 60_000;

export type TransportErrorCode =
  | 'ASSET_URL_INVALID'
  | 'RUNTIME_SCRIPT_FAILED'
  | 'RUNTIME_MISSING'
  | 'WASM_FETCH_FAILED'
  | 'WASM_COMPILE_FAILED'
  | 'BRIDGE_NOT_READY'
  | 'LOAD_TIMEOUT'
  | 'DIAL_FAILED'
  | 'DIAL_TIMEOUT'
  | 'CONNECTION_INCOMPATIBLE'
  | 'READ_FAILED'
  | 'READ_IN_PROGRESS'
  | 'WRITE_FAILED'
  | 'WRITE_IN_PROGRESS'
  | 'CHUNK_TOO_LARGE'
  | 'STREAM_CLOSED'
  | 'CLOSE_FAILED'
  | 'CANCELED';

const safeMessages: Record<TransportErrorCode, string> = {
  ASSET_URL_INVALID: 'Tailcat asset URL is not local.',
  RUNTIME_SCRIPT_FAILED: 'Tailcat runtime script failed to load.',
  RUNTIME_MISSING: 'Tailcat runtime is incompatible.',
  WASM_FETCH_FAILED: 'Tailcat WebAssembly failed to download.',
  WASM_COMPILE_FAILED: 'Tailcat WebAssembly failed to initialize.',
  BRIDGE_NOT_READY: 'Tailcat browser bridge did not become ready.',
  LOAD_TIMEOUT: 'Tailcat browser runtime timed out.',
  DIAL_FAILED: 'Tailcat connection failed.',
  DIAL_TIMEOUT: 'Tailcat connection timed out.',
  CONNECTION_INCOMPATIBLE: 'Tailcat connection object is incompatible.',
  READ_FAILED: 'Tailcat stream read failed.',
  READ_IN_PROGRESS: 'A Tailcat stream read is already in progress.',
  WRITE_FAILED: 'Tailcat stream write failed.',
  WRITE_IN_PROGRESS: 'A Tailcat stream write is already in progress.',
  CHUNK_TOO_LARGE: 'Tailcat stream chunk exceeds the limit.',
  STREAM_CLOSED: 'Tailcat stream is closed.',
  CLOSE_FAILED: 'Tailcat stream close failed.',
  CANCELED: 'Tailcat operation was canceled.',
};

export class TailcatTransportError extends Error {
  readonly code: TransportErrorCode;

  constructor(code: TransportErrorCode) {
    super(safeMessages[code]);
    this.name = 'TailcatTransportError';
    this.code = code;
  }
}

export interface ByteStream {
  read(): Promise<Uint8Array | null>;
  write(data: Uint8Array): Promise<void>;
  close(): Promise<void>;
}

export interface LoadOptions {
  runtimeScriptURL?: string;
  wasmURL?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface DialOptions {
  runtimeScriptURL?: string;
  wasmURL?: string;
  timeoutMs?: number;
  loadTimeoutMs?: number;
  signal?: AbortSignal;
}

interface RawConnection {
  port: number;
  read(): Promise<unknown>;
  write(data: Uint8Array): Promise<unknown>;
  close(): unknown;
}

interface GoRuntime {
  importObject: WebAssembly.Imports;
  run(instance: WebAssembly.Instance): Promise<void> | void;
}

type RuntimeGlobal = typeof globalThis & {
  Go?: new () => GoRuntime;
  onTailcatReady?: () => void;
  tailcatDial?: (options: {
    addr: string;
    port: number;
    verbose: boolean;
  }) => Promise<unknown>;
};

const runtimeGlobal = globalThis as RuntimeGlobal;
let runtimePromise: Promise<void> | undefined;

export async function loadTailcat(options: LoadOptions = {}): Promise<void> {
  if (typeof runtimeGlobal.tailcatDial === 'function') {
    return;
  }
  if (runtimePromise === undefined) {
    const pending = bounded(
      options.timeoutMs ?? DEFAULT_LOAD_TIMEOUT_MS,
      options.signal,
      'LOAD_TIMEOUT',
      (signal) => loadRuntime(options, signal),
    ).catch((error: unknown) => {
      if (runtimePromise === pending) {
        runtimePromise = undefined;
      }
      throw asTransportError(error, 'BRIDGE_NOT_READY');
    });
    runtimePromise = pending;
  }
  await runtimePromise;
  if (typeof runtimeGlobal.tailcatDial !== 'function') {
    runtimePromise = undefined;
    throw new TailcatTransportError('BRIDGE_NOT_READY');
  }
}

export async function dialTailcat(
  address: string,
  options: DialOptions = {},
): Promise<ByteStream> {
  const loadOptions: LoadOptions = {};
  if (options.runtimeScriptURL !== undefined) {
    loadOptions.runtimeScriptURL = options.runtimeScriptURL;
  }
  if (options.wasmURL !== undefined) {
    loadOptions.wasmURL = options.wasmURL;
  }
  if (options.loadTimeoutMs !== undefined) {
    loadOptions.timeoutMs = options.loadTimeoutMs;
  }
  if (options.signal !== undefined) {
    loadOptions.signal = options.signal;
  }
  await loadTailcat(loadOptions);
  const dial = runtimeGlobal.tailcatDial;
  if (typeof dial !== 'function') {
    throw new TailcatTransportError('BRIDGE_NOT_READY');
  }
  let value: unknown;
  try {
    value = await bounded(
      options.timeoutMs ?? DEFAULT_DIAL_TIMEOUT_MS,
      options.signal,
      'DIAL_TIMEOUT',
      async (signal) => {
        const connection = await dial({
          addr: address,
          port: VIRTUAL_PORT,
          verbose: false,
        });
        if (signal.aborted) {
          closeMalformed(connection);
          throw new TailcatTransportError('CANCELED');
        }
        return connection;
      },
    );
  } catch (error) {
    if (error instanceof TailcatTransportError) {
      throw error;
    }
    throw new TailcatTransportError('DIAL_FAILED');
  }
  return adaptConnection(value);
}

async function loadRuntime(
  options: LoadOptions,
  signal: AbortSignal,
): Promise<void> {
  const runtimeScriptURL = localAssetURL(
    options.runtimeScriptURL ?? './tailcat/wasm_exec.js',
  );
  const wasmURL = localAssetURL(
    options.wasmURL ?? './tailcat/tailcat-web.wasm',
  );
  if (typeof runtimeGlobal.Go !== 'function') {
    await loadRuntimeScript(runtimeScriptURL, signal);
  }
  const Go = runtimeGlobal.Go;
  if (typeof Go !== 'function') {
    throw new TailcatTransportError('RUNTIME_MISSING');
  }
  const runtime = new Go();
  let response: Response;
  try {
    response = await fetch(wasmURL, {
      cache: 'force-cache',
      credentials: 'same-origin',
      referrerPolicy: 'no-referrer',
      signal,
    });
  } catch {
    throw new TailcatTransportError('WASM_FETCH_FAILED');
  }
  if (!response.ok) {
    throw new TailcatTransportError('WASM_FETCH_FAILED');
  }

  let instance: WebAssembly.Instance;
  try {
    ({ instance } = await WebAssembly.instantiateStreaming(
      response,
      runtime.importObject,
    ));
  } catch {
    throw new TailcatTransportError('WASM_COMPILE_FAILED');
  }

  await runUntilReady(runtime, instance, signal);
}

function localAssetURL(value: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value, location.href);
  } catch {
    throw new TailcatTransportError('ASSET_URL_INVALID');
  }
  if (
    parsed.origin !== location.origin ||
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.hash !== ''
  ) {
    throw new TailcatTransportError('ASSET_URL_INVALID');
  }
  return parsed;
}

function loadRuntimeScript(url: URL, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (typeof document === 'undefined') {
      reject(new TailcatTransportError('RUNTIME_SCRIPT_FAILED'));
      return;
    }
    const script = document.createElement('script');
    script.async = true;
    script.src = url.href;
    const cleanup = (): void => {
      script.onload = null;
      script.onerror = null;
      signal.removeEventListener('abort', onAbort);
    };
    const onAbort = (): void => {
      cleanup();
      script.remove();
      reject(new TailcatTransportError('CANCELED'));
    };
    script.onload = () => {
      cleanup();
      resolve();
    };
    script.onerror = () => {
      cleanup();
      script.remove();
      reject(new TailcatTransportError('RUNTIME_SCRIPT_FAILED'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    document.head.append(script);
  });
}

function runUntilReady(
  runtime: GoRuntime,
  instance: WebAssembly.Instance,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const previous = runtimeGlobal.onTailcatReady;
    const cleanup = (): void => {
      signal.removeEventListener('abort', onAbort);
      if (runtimeGlobal.onTailcatReady === onReady) {
        if (previous === undefined) {
          delete runtimeGlobal.onTailcatReady;
        } else {
          runtimeGlobal.onTailcatReady = previous;
        }
      }
    };
    const onReady = (): void => {
      cleanup();
      resolve();
    };
    const onAbort = (): void => {
      cleanup();
      reject(new TailcatTransportError('CANCELED'));
    };
    runtimeGlobal.onTailcatReady = onReady;
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      void Promise.resolve(runtime.run(instance)).catch(() => {
        cleanup();
        reject(new TailcatTransportError('BRIDGE_NOT_READY'));
      });
    } catch {
      cleanup();
      reject(new TailcatTransportError('BRIDGE_NOT_READY'));
    }
  });
}

function adaptConnection(value: unknown): ByteStream {
  if (!isRawConnection(value)) {
    closeMalformed(value);
    throw new TailcatTransportError('CONNECTION_INCOMPATIBLE');
  }
  let connection: RawConnection | undefined = value;
  let reading = false;
  let writing = false;
  return {
    async read(): Promise<Uint8Array | null> {
      if (connection === undefined) {
        throw new TailcatTransportError('STREAM_CLOSED');
      }
      if (reading) {
        throw new TailcatTransportError('READ_IN_PROGRESS');
      }
      reading = true;
      try {
        const chunk = await connection.read();
        if (chunk === null) {
          return null;
        }
        if (!(chunk instanceof Uint8Array)) {
          throw new TailcatTransportError('READ_FAILED');
        }
        if (chunk.byteLength > MAX_CHUNK_BYTES) {
          throw new TailcatTransportError('CHUNK_TOO_LARGE');
        }
        return chunk.slice();
      } catch (error) {
        throw asTransportError(error, 'READ_FAILED');
      } finally {
        reading = false;
      }
    },
    async write(data: Uint8Array): Promise<void> {
      if (connection === undefined) {
        throw new TailcatTransportError('STREAM_CLOSED');
      }
      if (!(data instanceof Uint8Array)) {
        throw new TailcatTransportError('WRITE_FAILED');
      }
      if (data.byteLength > MAX_CHUNK_BYTES) {
        throw new TailcatTransportError('CHUNK_TOO_LARGE');
      }
      if (writing) {
        throw new TailcatTransportError('WRITE_IN_PROGRESS');
      }
      writing = true;
      try {
        await connection.write(data.slice());
      } catch {
        throw new TailcatTransportError('WRITE_FAILED');
      } finally {
        writing = false;
      }
    },
    async close(): Promise<void> {
      if (connection === undefined) {
        return;
      }
      const current = connection;
      connection = undefined;
      try {
        await Promise.resolve(current.close());
      } catch {
        throw new TailcatTransportError('CLOSE_FAILED');
      }
    },
  };
}

function isRawConnection(value: unknown): value is RawConnection {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Partial<RawConnection>;
  return (
    candidate.port === VIRTUAL_PORT &&
    typeof candidate.read === 'function' &&
    typeof candidate.write === 'function' &&
    typeof candidate.close === 'function'
  );
}

function closeMalformed(value: unknown): void {
  if (typeof value !== 'object' || value === null) {
    return;
  }
  const close = (value as { close?: unknown }).close;
  if (typeof close !== 'function') {
    return;
  }
  try {
    void Promise.resolve(close.call(value)).catch(() => {});
  } catch {
    // The incompatible object is already rejected; its error is secret-prone.
  }
}

function asTransportError(
  error: unknown,
  fallback: TransportErrorCode,
): TailcatTransportError {
  return error instanceof TailcatTransportError
    ? error
    : new TailcatTransportError(fallback);
}

function bounded<T>(
  timeoutMs: number,
  parentSignal: AbortSignal | undefined,
  timeoutCode: TransportErrorCode,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return Promise.reject(new TailcatTransportError(timeoutCode));
  }
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      parentSignal?.removeEventListener('abort', onAbort);
      callback();
    };
    const onAbort = (): void => {
      controller.abort();
      finish(() => reject(new TailcatTransportError('CANCELED')));
    };
    const timer = setTimeout(() => {
      controller.abort();
      finish(() => reject(new TailcatTransportError(timeoutCode)));
    }, timeoutMs);
    if (parentSignal?.aborted === true) {
      onAbort();
      return;
    }
    parentSignal?.addEventListener('abort', onAbort, { once: true });
    operation(controller.signal).then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}
