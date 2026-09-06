import type { MouseCard } from './invitation.ts';
import { EscapeClient } from './escape.ts';
import { LeashClient } from './leash.ts';
import { Latency, type LatencySnapshot } from './latency.ts';
import {
  authProofFrame,
  closeFrame,
  decodeAuthChallenge,
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

export type SessionStage =
  'loading' | 'connecting' | 'establishing' | 'authenticating' | 'admitting';

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

const ACCESS_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const ACCESS_KEY_PREFIX = new TextEncoder().encode('tailmouse-access-key-v1\0');
const ACCESS_PROOF_PREFIX = new TextEncoder().encode(
  'tailmouse-access-proof-v1\0',
);

export function canonicalAccessCode(input: string): string {
  let canonical = '';
  for (let index = 0; index < input.length; index++) {
    const character = input.charCodeAt(index);
    if (character === 0x20 || character === 0x2d) continue;
    const symbol = String.fromCharCode(
      character >= 0x61 && character <= 0x7a ? character - 0x20 : character,
    );
    if (canonical.length === 16 || !ACCESS_ALPHABET.includes(symbol)) {
      throw new ProtocolError('AUTH_FAILED');
    }
    canonical += symbol;
  }
  if (canonical.length !== 16) throw new ProtocolError('AUTH_FAILED');
  return canonical;
}

export async function createAccessProof(
  input: string,
  sessionID: Uint8Array,
  challenge: Uint8Array,
): Promise<Uint8Array> {
  if (sessionID.byteLength !== 16 || challenge.byteLength !== 32) {
    throw new ProtocolError('BAD_FRAME');
  }
  const canonical = canonicalAccessCode(input);
  const keyMaterial = new Uint8Array(ACCESS_KEY_PREFIX.byteLength + 16);
  keyMaterial.set(ACCESS_KEY_PREFIX);
  for (let index = 0; index < canonical.length; index++) {
    keyMaterial[ACCESS_KEY_PREFIX.byteLength + index] =
      canonical.charCodeAt(index);
  }
  let keyBytes: Uint8Array<ArrayBuffer>;
  try {
    keyBytes = new Uint8Array(
      await globalThis.crypto.subtle.digest('SHA-256', keyMaterial),
    );
  } finally {
    keyMaterial.fill(0);
  }
  try {
    const key = await globalThis.crypto.subtle.importKey(
      'raw',
      keyBytes,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const message = new Uint8Array(
      ACCESS_PROOF_PREFIX.byteLength +
        sessionID.byteLength +
        challenge.byteLength,
    );
    message.set(ACCESS_PROOF_PREFIX);
    message.set(sessionID, ACCESS_PROOF_PREFIX.byteLength);
    message.set(
      challenge,
      ACCESS_PROOF_PREFIX.byteLength + sessionID.byteLength,
    );
    try {
      return new Uint8Array(
        await globalThis.crypto.subtle.sign('HMAC', key, message),
      );
    } finally {
      message.fill(0);
    }
  } finally {
    keyBytes.fill(0);
  }
}

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
  accessCode?: string,
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
  return negotiateSession(stream, card, signal, accessCode, onStage);
}

export async function negotiateSession(
  stream: ByteStream,
  card: MouseCard,
  signal: AbortSignal,
  accessCode?: string,
  onStage: (stage: SessionStage) => void = () => {},
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
  let authenticated = false;
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
    let frame = await decoder
      .read('browser', 'await-server-welcome', bound)
      .catch((error: unknown) => {
        throw streamFailure(error);
      });
    if (frame === null) throw new SessionError('DISCONNECTED');
    counters.framesRx++;
    if (frame.type === Message.AUTH_CHALLENGE) {
      onStage('authenticating');
      let challenge: Uint8Array | undefined;
      try {
        challenge = decodeAuthChallenge(frame);
      } finally {
        frame.payload.fill(0);
      }
      try {
        if (card.mode !== 'leash') throw new ProtocolError('BAD_FRAME');
        if (accessCode === undefined || accessCode.length === 0) {
          throw new ProtocolError('AUTH_REQUIRED');
        }
        const proof = await createAccessProof(
          accessCode,
          card.sessionID,
          challenge,
        );
        try {
          const proofFrame = authProofFrame(proof);
          try {
            await writeFrame(
              stream,
              'browser',
              'await-auth-proof',
              proofFrame,
              bound,
            ).catch((error: unknown) => {
              throw streamFailure(error);
            });
          } finally {
            proofFrame.payload.fill(0);
          }
          authenticated = true;
        } finally {
          proof.fill(0);
        }
      } finally {
        challenge.fill(0);
      }
      onStage('admitting');
      frame = await decoder
        .read('browser', 'await-server-welcome', bound)
        .catch((error: unknown) => {
          throw streamFailure(error);
        });
      if (frame === null) throw new SessionError('DISCONNECTED');
      counters.framesRx++;
    } else {
      onStage('admitting');
    }
    let welcome: Welcome;
    try {
      if (frame.type === Message.ERROR) {
        graceful = true;
        throw decodeError(frame);
      }
      welcome = decodeWelcome(frame, card.mode);
      if (
        card.mode === 'leash' &&
        welcome.accessMode !== (authenticated ? 'code' : 'link')
      ) {
        throw new ProtocolError('BAD_FRAME');
      }
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
