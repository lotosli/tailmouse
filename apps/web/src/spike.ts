import {
  TailcatTransportError,
  dialTailcat,
  loadTailcat,
  type ByteStream,
} from './transport/tailcat/adapter.ts';

const HELLO = new TextEncoder().encode('TMOUSE-M0-HELLO');
const DEFAULT_ECHO_TIMEOUT_MS = 10_000;

export type SpikeStage = 'loading' | 'connecting' | 'establishing' | 'complete';

export class EchoError extends Error {
  constructor(message = 'The encrypted echo exchange failed.') {
    super(message);
    this.name = 'EchoError';
  }
}

export async function runSpike(
  address: string,
  signal: AbortSignal,
  onStage: (stage: SpikeStage) => void,
): Promise<string> {
  onStage('loading');
  await loadTailcat({ signal });
  onStage('connecting');
  const stream = await dialTailcat(address, { signal });
  let echoed = '';
  let operationFailure: unknown;
  try {
    onStage('establishing');
    echoed = await exchangeHello(stream, signal);
  } catch (error) {
    operationFailure = error;
  }
  let closeFailure: unknown;
  try {
    await stream.close();
  } catch (error) {
    closeFailure = error;
  }
  if (operationFailure !== undefined) {
    throw operationFailure;
  }
  if (closeFailure !== undefined) {
    throw closeFailure;
  }
  onStage('complete');
  return echoed;
}

export async function exchangeHello(
  stream: ByteStream,
  signal: AbortSignal,
  timeoutMs = DEFAULT_ECHO_TIMEOUT_MS,
): Promise<string> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new EchoError('The encrypted echo exchange timed out.');
  }
  return withBound(timeoutMs, signal, async () => {
    await stream.write(HELLO.slice());
    const received = new Uint8Array(HELLO.byteLength);
    let offset = 0;
    while (offset < received.byteLength) {
      const chunk = await stream.read();
      if (
        chunk === null ||
        chunk.byteLength === 0 ||
        chunk.byteLength > received.byteLength - offset
      ) {
        throw new EchoError();
      }
      received.set(chunk, offset);
      offset += chunk.byteLength;
    }
    if (!received.every((value, index) => value === HELLO[index])) {
      throw new EchoError();
    }
    return new TextDecoder().decode(received);
  });
}

function withBound<T>(
  timeoutMs: number,
  signal: AbortSignal,
  operation: () => Promise<T>,
): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(new TailcatTransportError('CANCELED'));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      callback();
    };
    const onAbort = (): void => {
      finish(() => reject(new TailcatTransportError('CANCELED')));
    };
    const timer = setTimeout(() => {
      finish(() =>
        reject(new EchoError('The encrypted echo exchange timed out.')),
      );
    }, timeoutMs);
    signal.addEventListener('abort', onAbort, { once: true });
    operation().then(
      (value) => finish(() => resolve(value)),
      () => finish(() => reject(new EchoError())),
    );
  });
}
