import type { MouseCard } from './invitation.ts';
import { EscapeClient } from './escape.ts';
import { LeashClient } from './leash.ts';
import { Latency, type LatencySnapshot } from './latency.ts';
import {
  closeFrame,
  decodeClose,
  decodeError,
  decodeWelcome,
  errorFrame,
  FrameDecoder,
  helloFrame,
  Message,
  ProtocolError,
  TruncatedFrameError,
  writeFrame,
  type CloseReason,
  type Frame,
  type ProtocolState,
  type Welcome,
} from './protocol/frame.ts';
import {
  dialTailcat,
  loadTailcat,
  type ByteStream,
} from './transport/tailcat/adapter.ts';

export type SessionStage = 'loading' | 'connecting' | 'establishing';

interface Counters {
  bytesTx: number;
  bytesRx: number;
  framesTx: number;
  framesRx: number;
}
export interface ConnectionMetrics
  extends LatencySnapshot, Readonly<Counters> {}
type SessionErrorCode =
  'HANDSHAKE_TIMEOUT' | 'CLOSE_TIMEOUT' | 'DISCONNECTED' | 'CANCELED';
const messages: Record<SessionErrorCode, string> = {
  HANDSHAKE_TIMEOUT: 'The session handshake timed out.',
  CLOSE_TIMEOUT: 'The session could not close cleanly.',
  DISCONNECTED: 'The encrypted session disconnected. Retry to reconnect.',
  CANCELED: 'The session was canceled.',
};

export class SessionError extends Error {
  readonly code: SessionErrorCode;
  readonly retryable: boolean;

  constructor(code: SessionErrorCode) {
    super(messages[code]);
    this.name = 'SessionError';
    this.code = code;
    this.retryable = code === 'DISCONNECTED' || code === 'HANDSHAKE_TIMEOUT';
  }
}

function streamFailure(error: unknown): unknown {
  return error instanceof ProtocolError && error.code === 'INTERNAL'
    ? new SessionError('DISCONNECTED')
    : error;
}

export async function connectSession(
  card: MouseCard,
  signal: AbortSignal,
  onStage: (stage: SessionStage, progress?: number) => void,
): Promise<BrowserSession> {
  if (signal.aborted) throw new SessionError('CANCELED');
  if (card.expiresAt !== 0 && card.expiresAt * 1000 <= Date.now()) {
    throw new ProtocolError('EXPIRED');
  }
  onStage('loading', 0);
  await loadTailcat({
    signal,
    onProgress: (percent) => onStage('loading', percent),
  });
  onStage('connecting');
  const stream = await dialTailcat(card.address, { signal });
  onStage('establishing');
  return negotiateSession(stream, card, signal);
}

export async function negotiateSession(
  stream: ByteStream,
  card: MouseCard,
  signal: AbortSignal,
): Promise<BrowserSession> {
  const counters: Counters = {
    bytesTx: 0,
    bytesRx: 0,
    framesTx: 0,
    framesRx: 0,
  };
  const raw = stream;
  let closing: Promise<void> | undefined;
  stream = {
    read: async () => {
      const chunk = await raw.read();
      counters.bytesRx += chunk?.byteLength ?? 0;
      return chunk;
    },
    write: async (bytes) => {
      await raw.write(bytes);
      counters.bytesTx += bytes.byteLength;
      counters.framesTx++;
    },
    // An aborted reader and final teardown may both request closure. They join
    // the same operation, including its original failure.
    close: (options) => (closing ??= raw.close(options)),
  };
  const controller = new AbortController();
  const bound = AbortSignal.any([signal, controller.signal]);
  const timer = setTimeout(() => controller.abort(), 10_000);
  const decoder = new FrameDecoder(stream);
  let graceful = false;
  try {
    const hello = helloFrame(card.sessionID, card.mode);
    try {
      await writeFrame(
        stream,
        'browser',
        'await-client-hello',
        hello,
        bound,
      ).catch((error: unknown) => {
        throw streamFailure(error);
      });
    } finally {
      hello.payload.fill(0);
    }
    const frame = await decoder
      .read('browser', 'await-server-welcome', bound)
      .catch((error: unknown) => {
        throw streamFailure(error);
      });
    if (frame === null) throw new SessionError('DISCONNECTED');
    counters.framesRx++;
    let welcome: Welcome;
    try {
      if (frame.type === Message.ERROR) {
        graceful = true;
        throw decodeError(frame);
      }
      welcome = decodeWelcome(frame, card.mode);
    } finally {
      frame.payload.fill(0);
    }
    return new BrowserSession(stream, decoder, welcome, signal, counters);
  } catch (error) {
    decoder.discard();
    await stream
      .close({ graceful: graceful && !bound.aborted })
      .catch(() => {});
    if (signal.aborted) throw new SessionError('CANCELED');
    if (controller.signal.aborted) throw new SessionError('HANDSHAKE_TIMEOUT');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

// One reader and a bounded, serialized writer own each established connection.
// A retry creates a new session; no queued input survives a disconnect.
export class BrowserSession {
  readonly welcome: Welcome;
  readonly game: EscapeClient | undefined;
  readonly terminal: LeashClient | undefined;
  readonly done: Promise<CloseReason>;
  readonly #stream: ByteStream;
  readonly #decoder: FrameDecoder;
  readonly #controller = new AbortController();
  readonly #signal: AbortSignal;
  readonly #state: ProtocolState;
  #closing = false;
  #closed = false;
  #closeTimer: ReturnType<typeof setTimeout> | undefined;
  #writeTail: Promise<void> = Promise.resolve();
  #pendingWrites = 0;
  #writeFailure: unknown;
  readonly #counters: Counters;
  readonly #latency = new Latency();
  readonly #pingTimer: ReturnType<typeof setInterval>;
  #pingInProgress = false;
  readonly #abortTerminal = () => this.terminal?.dispose();

  constructor(
    stream: ByteStream,
    decoder: FrameDecoder,
    welcome: Welcome,
    signal: AbortSignal,
    counters: Counters,
  ) {
    this.#stream = stream;
    this.#decoder = decoder;
    this.#counters = counters;
    this.welcome = welcome;
    this.#signal = AbortSignal.any([signal, this.#controller.signal]);
    this.#state = welcome.mode === 'escape' ? 'active-escape' : 'active-leash';
    if (welcome.mode === 'escape') {
      this.game = new EscapeClient(
        welcome,
        (frame) => this.#send(frame),
        (error) => {
          this.#writeFailure ??= error;
          this.#controller.abort();
        },
      );
    } else {
      this.terminal = new LeashClient(
        welcome,
        (frame) => this.#send(frame),
        (error) => {
          this.#writeFailure ??= error;
          this.#controller.abort();
        },
      );
    }
    this.#signal.addEventListener('abort', this.#abortTerminal, { once: true });
    this.#pingTimer = setInterval(() => {
      if (this.#closed || this.#closing || this.#pingInProgress) return;
      this.#pingInProgress = true;
      void this.#send(this.#latency.ping(performance.now()))
        .catch(() => this.#controller.abort())
        .finally(() => {
          this.#pingInProgress = false;
        });
    }, 1000);
    this.done = this.#run();
  }

  inspectMetrics(): ConnectionMetrics {
    return Object.freeze({ ...this.#counters, ...this.#latency.inspect() });
  }

  close(): Promise<CloseReason> {
    if (!this.#closing && !this.#closed) {
      this.#closing = true;
      this.game?.dispose();
      this.terminal?.dispose();
      clearInterval(this.#pingTimer);
      this.#closeTimer = setTimeout(() => this.#controller.abort(), 2000);
      void this.#send(closeFrame('normal')).catch(() =>
        this.#controller.abort(),
      );
    }
    return this.done;
  }

  async #send(frame: Frame): Promise<void> {
    if (this.#closed || this.#signal.aborted)
      throw new SessionError('CANCELED');
    if (this.#pendingWrites >= 8) throw new ProtocolError('BACKPRESSURE');
    this.#pendingWrites++;
    const previous = this.#writeTail;
    const next = (async () => {
      await previous;
      if (
        this.#closing &&
        frame.type !== Message.CLOSE &&
        frame.type !== Message.ERROR
      )
        return;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2000);
      try {
        await writeFrame(
          this.#stream,
          'browser',
          this.#state,
          frame,
          AbortSignal.any([this.#signal, controller.signal]),
        ).catch((error: unknown) => {
          if (controller.signal.aborted && !this.#signal.aborted) {
            throw new SessionError('DISCONNECTED');
          }
          throw streamFailure(error);
        });
      } finally {
        clearTimeout(timer);
      }
    })();
    this.#writeTail = next.catch((error: unknown) => {
      this.#writeFailure ??= error;
      this.#controller.abort();
    });
    try {
      await next;
    } finally {
      this.#pendingWrites--;
      frame.payload.fill(0);
    }
  }

  async #run(): Promise<CloseReason> {
    let result: CloseReason = 'transport_error';
    let failure: unknown;
    let graceful = false;
    try {
      for (;;) {
        const frame = await this.#decoder
          .read('browser', this.#state, this.#signal)
          .catch((error: unknown) => {
            if (error instanceof TruncatedFrameError && !this.#closing) {
              throw new SessionError('DISCONNECTED');
            }
            throw streamFailure(error);
          });
        if (frame === null) throw new SessionError('DISCONNECTED');
        this.#counters.framesRx++;
        try {
          if (frame.type === Message.CLOSE) {
            result = decodeClose(frame);
            if (!this.#closing) {
              this.#closing = true;
              this.game?.dispose();
              this.terminal?.dispose();
              clearInterval(this.#pingTimer);
              await this.#send(closeFrame(result));
            }
            this.#decoder.finish();
            graceful = true;
            break;
          }
          if (frame.type === Message.ERROR) {
            const error = decodeError(frame);
            if (!this.#closing && this.terminal?.reject(error)) continue;
            graceful = true;
            throw error;
          }
          // Local CLOSE stops our sender. The peer may still finish an already
          // accepted write before its CLOSE; validate it but apply no effects.
          if (this.#closing) continue;
          if (frame.type === Message.PING) {
            await this.#send({
              type: Message.PONG,
              payload: frame.payload.slice(),
            });
            this.terminal?.pongSent();
          } else if (frame.type === Message.PONG) {
            this.#latency.pong(frame.payload, performance.now());
          } else if (
            !this.game?.receive(frame) &&
            !(await this.terminal?.receive(frame))
          ) {
            throw new ProtocolError('BAD_FRAME');
          }
        } finally {
          frame.payload.fill(0);
        }
      }
    } catch (error) {
      failure =
        this.#writeFailure ??
        (this.#signal.aborted
          ? new SessionError(this.#closing ? 'CLOSE_TIMEOUT' : 'CANCELED')
          : error);
      // A peer ERROR already selected graceful closure above; never echo it.
      if (
        !graceful &&
        !this.#closing &&
        !this.#signal.aborted &&
        failure instanceof ProtocolError &&
        failure.code === 'FRAME_TOO_LARGE'
      ) {
        this.#closing = true;
        this.game?.dispose();
        this.terminal?.dispose();
        this.#decoder.discard();
        clearInterval(this.#pingTimer);
        this.#closeTimer = setTimeout(() => this.#controller.abort(), 2000);
        try {
          await this.#writeTail;
          await this.#send(errorFrame('FRAME_TOO_LARGE'));
          graceful = true;
        } catch {
          // The original protocol failure remains authoritative. No retry
          // or queued application data may follow a failed notification.
          this.#controller.abort();
        }
      }
    } finally {
      this.#closed = true;
      this.game?.dispose();
      this.terminal?.dispose();
      this.#signal.removeEventListener('abort', this.#abortTerminal);
      clearInterval(this.#pingTimer);
      clearTimeout(this.#closeTimer);
      await this.#writeTail;
      this.#decoder.discard();
      try {
        await this.#stream.close({
          graceful: graceful && !this.#signal.aborted,
        });
      } catch (error) {
        failure ??= error;
      }
      this.#controller.abort();
    }
    if (failure !== undefined) throw failure;
    return result;
  }
}
