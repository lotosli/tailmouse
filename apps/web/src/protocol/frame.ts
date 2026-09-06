import type { ByteStream } from '../transport/tailcat/adapter.ts';
import { BUILD } from '../build.ts';
import {
  decodeTermReset,
  decodeProcessControl,
  decodeProcessState,
  decodeOutputDropped,
} from './terminal.ts';
import {
  decodeGameInit,
  decodeGameInput,
  decodeGameSnapshot,
  decodeGameEvent,
  decodeGameResult,
} from './game.ts';

export const MAX_FRAME_LENGTH = 1_048_576;
export const MAX_TERMINAL_PAYLOAD = 32_766;
const MAX_BUFFER_BYTES = MAX_FRAME_LENGTH + 4;

export const Message = {
  CLIENT_HELLO: 0x01,
  SERVER_WELCOME: 0x02,
  ERROR: 0x03,
  PING: 0x04,
  PONG: 0x05,
  CLOSE: 0x06,
  AUTH_CHALLENGE: 0x07,
  AUTH_PROOF: 0x08,
  TERM_RESET: 0x10,
  TERM_OUTPUT: 0x11,
  TERM_INPUT: 0x12,
  TERM_RESIZE: 0x13,
  PROCESS_CONTROL: 0x14,
  PROCESS_STATE: 0x15,
  OUTPUT_DROPPED: 0x16,
  GAME_INIT: 0x20,
  GAME_INPUT: 0x21,
  GAME_SNAPSHOT: 0x22,
  GAME_EVENT: 0x23,
  GAME_RESULT: 0x24,
} as const;

export type MessageType = (typeof Message)[keyof typeof Message];
export type Peer = 'host' | 'browser';
export type ProtocolState =
  | 'await-client-hello'
  | 'await-server-welcome'
  | 'await-auth-proof'
  | 'active-escape'
  | 'active-leash'
  | 'closing';
import {
  ProtocolError,
  errorMessages,
  strictObject,
  exactKeys,
  integerBetween,
  boundedText,
  validHostname,
  dataView,
  isRecord,
  type ProtocolErrorCode,
} from './values.ts';
export { ProtocolError, type ProtocolErrorCode } from './values.ts';

export interface Frame {
  readonly type: MessageType;
  readonly payload: Uint8Array;
  readonly selectedProtocol?: number;
}

interface MessageRule {
  readonly name: keyof typeof Message;
  readonly minimum: number;
  readonly maximum: number;
  readonly exact?: number;
}

const rules = new Map<MessageType, MessageRule>([
  [Message.CLIENT_HELLO, rule('CLIENT_HELLO', 2, 4096)],
  [Message.SERVER_WELCOME, rule('SERVER_WELCOME', 2, 4096)],
  [Message.ERROR, rule('ERROR', 2, 1024)],
  [Message.PING, rule('PING', 16, 16, 16)],
  [Message.PONG, rule('PONG', 16, 16, 16)],
  [Message.CLOSE, rule('CLOSE', 2, 512)],
  [Message.AUTH_CHALLENGE, rule('AUTH_CHALLENGE', 2, 512)],
  [Message.AUTH_PROOF, rule('AUTH_PROOF', 2, 512)],
  [Message.TERM_RESET, rule('TERM_RESET', 2, 1024)],
  [Message.TERM_OUTPUT, rule('TERM_OUTPUT', 1, MAX_TERMINAL_PAYLOAD)],
  [Message.TERM_INPUT, rule('TERM_INPUT', 1, MAX_TERMINAL_PAYLOAD)],
  [Message.TERM_RESIZE, rule('TERM_RESIZE', 4, 4, 4)],
  [Message.PROCESS_CONTROL, rule('PROCESS_CONTROL', 2, 512)],
  [Message.PROCESS_STATE, rule('PROCESS_STATE', 2, 1024)],
  [Message.OUTPUT_DROPPED, rule('OUTPUT_DROPPED', 2, 512)],
  [Message.GAME_INIT, rule('GAME_INIT', 2, 16_384)],
  [Message.GAME_INPUT, rule('GAME_INPUT', 24, 24, 24)],
  [Message.GAME_SNAPSHOT, rule('GAME_SNAPSHOT', 44, 44, 44)],
  [Message.GAME_EVENT, rule('GAME_EVENT', 2, 1024)],
  [Message.GAME_RESULT, rule('GAME_RESULT', 2, 2048)],
]);

function rule(
  name: keyof typeof Message,
  minimum: number,
  maximum: number,
  exact?: number,
): MessageRule {
  return exact === undefined
    ? { name, minimum, maximum }
    : { name, minimum, maximum, exact };
}

export function messageName(type: MessageType): keyof typeof Message {
  const found = rules.get(type);
  if (!found) throw new ProtocolError('BAD_FRAME');
  return found.name;
}

// Local decoder provenance; peer ERROR payloads cannot construct this marker.
// Handshake callers retain BAD_FRAME. Established sessions may offer retry.
export class TruncatedFrameError extends ProtocolError {
  constructor() {
    super('BAD_FRAME');
  }
}

export class FrameDecoder {
  readonly #stream: ByteStream;
  #buffer = new Uint8Array();
  #reading = false;

  constructor(stream: ByteStream) {
    this.#stream = stream;
  }

  finish(): void {
    const invalid = this.#reading || this.#buffer.byteLength !== 0;
    this.#eraseBuffer();
    if (invalid) throw new ProtocolError('BAD_FRAME');
  }

  discard(): void {
    this.#eraseBuffer();
  }

  async read(
    receiver: Peer,
    state: ProtocolState,
    signal: AbortSignal,
  ): Promise<Frame | null> {
    if (this.#reading) throw new ProtocolError('BAD_FRAME');
    this.#reading = true;
    try {
      const lengthBytes = await this.#readExactly(4, signal, true);
      if (lengthBytes === null) return null;
      const declaredLength = new DataView(
        lengthBytes.buffer,
        lengthBytes.byteOffset,
        lengthBytes.byteLength,
      ).getUint32(0);
      if (declaredLength < 2) throw new ProtocolError('BAD_FRAME');
      if (declaredLength > MAX_FRAME_LENGTH) {
        throw new ProtocolError('FRAME_TOO_LARGE');
      }

      const metadata = await this.#readExactly(2, signal, false);
      if (metadata === null) throw new ProtocolError('BAD_FRAME');
      if (metadata[1] !== 0) throw new ProtocolError('BAD_FRAME');
      const type = metadata[0] as MessageType;
      const messageRule = rules.get(type);
      if (!messageRule) throw new ProtocolError('BAD_FRAME');
      validateRoute(type, opposite(receiver), state);

      const payloadLength = declaredLength - 2;
      validateLength(messageRule, payloadLength);
      const payload = await this.#readExactly(payloadLength, signal, false);
      if (payload === null) throw new ProtocolError('BAD_FRAME');
      try {
        const selectedProtocol = validatePayload(
          type,
          payload,
          opposite(receiver),
        );
        return selectedProtocol === undefined
          ? { type, payload }
          : { type, payload, selectedProtocol };
      } catch (error) {
        payload.fill(0);
        throw error;
      }
    } catch (error) {
      this.#eraseBuffer();
      throw asProtocolError(error, signal);
    } finally {
      this.#reading = false;
    }
  }

  async #readExactly(
    count: number,
    signal: AbortSignal,
    allowCleanEnd: boolean,
  ): Promise<Uint8Array | null> {
    while (this.#buffer.byteLength < count) {
      const chunk = await readChunk(this.#stream, signal);
      if (chunk === null) {
        if (allowCleanEnd && this.#buffer.byteLength === 0) return null;
        throw new TruncatedFrameError();
      }
      if (chunk.byteLength === 0) throw new ProtocolError('BAD_FRAME');
      if (this.#buffer.byteLength + chunk.byteLength > MAX_BUFFER_BYTES) {
        chunk.fill(0);
        throw new ProtocolError('FRAME_TOO_LARGE');
      }
      const combined = new Uint8Array(
        this.#buffer.byteLength + chunk.byteLength,
      );
      combined.set(this.#buffer);
      combined.set(chunk, this.#buffer.byteLength);
      this.#buffer.fill(0);
      chunk.fill(0);
      this.#buffer = combined;
    }
    const result = this.#buffer.slice(0, count);
    const remaining = this.#buffer.slice(count);
    this.#buffer.fill(0);
    this.#buffer = remaining;
    return result;
  }

  #eraseBuffer(): void {
    this.#buffer.fill(0);
    this.#buffer = new Uint8Array();
  }
}

export function encodeFrame(
  sender: Peer,
  state: ProtocolState,
  frame: Frame,
): Uint8Array {
  const messageRule = rules.get(frame.type);
  if (!messageRule) throw new ProtocolError('BAD_FRAME');
  validateRoute(frame.type, sender, state);
  validateLength(messageRule, frame.payload.byteLength);
  validatePayload(frame.type, frame.payload, sender);

  const encoded = new Uint8Array(6 + frame.payload.byteLength);
  const view = new DataView(encoded.buffer);
  view.setUint32(0, frame.payload.byteLength + 2);
  encoded[4] = frame.type;
  encoded[5] = 0;
  encoded.set(frame.payload, 6);
  return encoded;
}

export async function writeFrame(
  stream: ByteStream,
  sender: Peer,
  state: ProtocolState,
  frame: Frame,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) throw new ProtocolError('CANCELED');
  const encoded = encodeFrame(sender, state, frame);
  const closeOnAbort = (): void => {
    void stream.close().catch(() => {});
  };
  signal.addEventListener('abort', closeOnAbort, { once: true });
  try {
    await stream.write(encoded);
    if (signal.aborted) throw new ProtocolError('CANCELED');
  } catch (error) {
    throw asProtocolError(error, signal);
  } finally {
    signal.removeEventListener('abort', closeOnAbort);
    encoded.fill(0);
  }
}

async function readChunk(
  stream: ByteStream,
  signal: AbortSignal,
): Promise<Uint8Array | null> {
  if (signal.aborted) throw new ProtocolError('CANCELED');
  const closeOnAbort = (): void => {
    void stream.close().catch(() => {});
  };
  signal.addEventListener('abort', closeOnAbort, { once: true });
  try {
    const chunk = await stream.read();
    if (signal.aborted) throw new ProtocolError('CANCELED');
    return chunk;
  } catch (error) {
    throw asProtocolError(error, signal);
  } finally {
    signal.removeEventListener('abort', closeOnAbort);
  }
}

function asProtocolError(error: unknown, signal: AbortSignal): ProtocolError {
  if (signal.aborted) return new ProtocolError('CANCELED');
  return error instanceof ProtocolError ? error : new ProtocolError('INTERNAL');
}

function opposite(peer: Peer): Peer {
  return peer === 'host' ? 'browser' : 'host';
}

function validateLength(messageRule: MessageRule, length: number): void {
  if (messageRule.exact !== undefined && length !== messageRule.exact) {
    throw new ProtocolError('BAD_FRAME');
  }
  if (length > messageRule.maximum) {
    throw new ProtocolError('FRAME_TOO_LARGE');
  }
  if (length < messageRule.minimum) {
    throw new ProtocolError('BAD_FRAME');
  }
}

function validateRoute(
  type: MessageType,
  sender: Peer,
  state: ProtocolState,
): void {
  if (
    (state === 'await-client-hello' &&
      sender === 'browser' &&
      type === Message.CLIENT_HELLO) ||
    (state === 'await-server-welcome' &&
      sender === 'host' &&
      (type === Message.SERVER_WELCOME ||
        type === Message.ERROR ||
        type === Message.AUTH_CHALLENGE)) ||
    (state === 'await-auth-proof' &&
      ((sender === 'browser' && type === Message.AUTH_PROOF) ||
        (sender === 'host' && type === Message.ERROR))) ||
    (state === 'closing' &&
      (type === Message.CLOSE || type === Message.ERROR)) ||
    (state === 'active-escape' &&
      (isCommon(type) || isEscapeForSender(type, sender))) ||
    (state === 'active-leash' &&
      (isCommon(type) || isTerminalForSender(type, sender)))
  ) {
    return;
  }
  if (
    state === 'await-auth-proof' &&
    sender === 'browser' &&
    (isTerminal(type) || isEscape(type))
  ) {
    throw new ProtocolError('AUTH_REQUIRED');
  }
  if (
    (state === 'active-escape' && isTerminal(type)) ||
    (state === 'active-leash' && isEscape(type))
  ) {
    throw new ProtocolError('MODE_MISMATCH');
  }
  throw new ProtocolError('BAD_FRAME');
}

function isCommon(type: MessageType): boolean {
  const common: readonly MessageType[] = [
    Message.ERROR,
    Message.PING,
    Message.PONG,
    Message.CLOSE,
  ];
  return common.includes(type);
}

function isTerminal(type: MessageType): boolean {
  return type >= Message.TERM_RESET && type <= Message.OUTPUT_DROPPED;
}

function isEscape(type: MessageType): boolean {
  return type >= Message.GAME_INIT && type <= Message.GAME_RESULT;
}

function isTerminalForSender(type: MessageType, sender: Peer): boolean {
  const fromHost: readonly MessageType[] = [
    Message.TERM_RESET,
    Message.TERM_OUTPUT,
    Message.PROCESS_STATE,
    Message.OUTPUT_DROPPED,
  ];
  const fromBrowser: readonly MessageType[] = [
    Message.TERM_INPUT,
    Message.TERM_RESIZE,
    Message.PROCESS_CONTROL,
  ];
  if (fromHost.includes(type)) {
    return sender === 'host';
  }
  if (fromBrowser.includes(type)) {
    return sender === 'browser';
  }
  return false;
}

function isEscapeForSender(type: MessageType, sender: Peer): boolean {
  const fromHost: readonly MessageType[] = [
    Message.GAME_INIT,
    Message.GAME_SNAPSHOT,
    Message.GAME_RESULT,
  ];
  if (fromHost.includes(type)) {
    return sender === 'host';
  }
  if (type === Message.GAME_INPUT) return sender === 'browser';
  return type === Message.GAME_EVENT;
}

function validatePayload(
  type: MessageType,
  payload: Uint8Array,
  sender: Peer,
): number | undefined {
  if (type === Message.CLIENT_HELLO) return validateClientHello(payload);
  if (type === Message.SERVER_WELCOME) return validateServerWelcome(payload);
  if (type === Message.ERROR) {
    validateError(payload);
    return undefined;
  }
  if (type === Message.AUTH_CHALLENGE) {
    decodeAuthenticationPayload(payload, 'challenge');
    return undefined;
  }
  if (type === Message.AUTH_PROOF) {
    decodeAuthenticationPayload(payload, 'proof');
    return undefined;
  }
  if (type === Message.CLOSE) {
    validateClose(payload);
    return undefined;
  }
  if (type === Message.TERM_RESET) {
    decodeTermReset(payload);
  } else if (type === Message.PROCESS_CONTROL) {
    decodeProcessControl(payload);
  } else if (type === Message.PROCESS_STATE) {
    decodeProcessState(payload);
  } else if (type === Message.OUTPUT_DROPPED) {
    decodeOutputDropped(payload);
  } else if (type === Message.TERM_RESIZE) {
    const view = dataView(payload);
    const columns = view.getUint16(0);
    const rows = view.getUint16(2);
    if (columns < 20 || columns > 500 || rows < 5 || rows > 200) {
      throw new ProtocolError('BAD_FRAME');
    }
  } else if (type === Message.GAME_INPUT) {
    decodeGameInput(payload);
  } else if (type === Message.GAME_SNAPSHOT) {
    decodeGameSnapshot(payload);
  } else if (type === Message.GAME_INIT) {
    decodeGameInit(payload);
  } else if (type === Message.GAME_EVENT) {
    decodeGameEvent(payload, sender);
  } else if (type === Message.GAME_RESULT) {
    decodeGameResult(payload);
  }
  return undefined;
}

function validateClientHello(payload: Uint8Array): number {
  const value = strictObject(payload);
  const allowedKeys =
    value.terminal === undefined
      ? ['client', 'mode', 'protocol_max', 'protocol_min', 'session_id']
      : [
          'client',
          'mode',
          'protocol_max',
          'protocol_min',
          'session_id',
          'terminal',
        ];
  if (
    !exactKeys(value, allowedKeys) ||
    !integerBetween(value.protocol_min, 1, 65_535) ||
    !integerBetween(value.protocol_max, 1, 65_535) ||
    value.protocol_min > value.protocol_max ||
    (value.mode !== 'escape' && value.mode !== 'leash') ||
    typeof value.session_id !== 'string' ||
    !/^[0-9a-f]{32}$/u.test(value.session_id) ||
    !isRecord(value.client) ||
    !exactKeys(value.client, ['name', 'platform', 'user_agent', 'version']) ||
    !boundedText(value.client.name, 1, 64) ||
    !boundedText(value.client.version, 1, 32) ||
    !boundedText(value.client.platform, 1, 32) ||
    !boundedText(value.client.user_agent, 0, 512)
  ) {
    throw new ProtocolError('BAD_FRAME');
  }
  if (
    value.terminal !== undefined &&
    (!isRecord(value.terminal) ||
      !exactKeys(value.terminal, ['cols', 'rows']) ||
      !integerBetween(value.terminal.cols, 20, 500) ||
      !integerBetween(value.terminal.rows, 5, 200))
  ) {
    throw new ProtocolError('BAD_FRAME');
  }
  const expectedProtocol = value.mode === 'escape' ? 1 : 2;
  if (
    value.protocol_min !== expectedProtocol ||
    value.protocol_max !== expectedProtocol
  ) {
    throw new ProtocolError('PROTOCOL_MISMATCH');
  }
  return expectedProtocol;
}

function validateServerWelcome(payload: Uint8Array): number {
  const value = strictObject(payload);
  const commonKeys = [
    'capabilities',
    'expires_at',
    'mode',
    'protocol',
    'relay',
    'session_state',
  ];
  if (
    (value.mode !== 'escape' && value.mode !== 'leash') ||
    value.session_state !== 'active' ||
    !integerBetween(value.expires_at, 0, Number.MAX_SAFE_INTEGER) ||
    !isRecord(value.relay) ||
    !exactKeys(value.relay, ['browser_path', 'host', 'mode']) ||
    !['official', 'custom-host', 'custom-map'].includes(
      String(value.relay.mode),
    ) ||
    value.relay.browser_path !== 'derp' ||
    typeof value.relay.host !== 'string' ||
    !validHostname(value.relay.host) ||
    !Array.isArray(value.capabilities) ||
    !validCapabilities(value.mode, value.capabilities)
  ) {
    throw new ProtocolError('BAD_FRAME');
  }
  if (
    value.mode === 'escape'
      ? !exactKeys(value, commonKeys) || value.protocol !== 1
      : !exactKeys(value, ['access_mode', ...commonKeys]) ||
        value.protocol !== 2 ||
        (value.access_mode !== 'code' && value.access_mode !== 'link')
  ) {
    throw new ProtocolError('BAD_FRAME');
  }
  return value.protocol as 1 | 2;
}

function validCapabilities(
  mode: 'escape' | 'leash',
  value: unknown[],
): boolean {
  const allowed =
    mode === 'escape'
      ? ['dash', 'game_input', 'game_view']
      : [
          'interrupt',
          'resize',
          'restart',
          'terminal_input',
          'terminal_output',
          'terminate',
        ];
  return (
    value.length > 0 &&
    value.every(
      (capability, index) =>
        typeof capability === 'string' &&
        allowed.includes(capability) &&
        (index === 0 || String(value[index - 1]) < capability),
    )
  );
}

export interface Welcome {
  readonly mode: 'escape' | 'leash';
  readonly expiresAt: number;
  readonly relay: {
    readonly mode: 'official' | 'custom-host' | 'custom-map';
    readonly host: string;
    readonly browserPath: 'derp';
  };
  readonly capabilities: readonly string[];
  readonly accessMode?: 'code' | 'link';
}

export function decodeWelcome(
  frame: Frame,
  expectedMode: 'escape' | 'leash',
): Welcome {
  if (
    frame.type !== Message.SERVER_WELCOME ||
    frame.payload.byteLength > 4096
  ) {
    throw new ProtocolError('BAD_FRAME');
  }
  validateServerWelcome(frame.payload);
  const value = strictObject(frame.payload);
  if (value.mode !== expectedMode) throw new ProtocolError('MODE_MISMATCH');
  const relay = value.relay as Record<string, unknown>;
  const welcome: Welcome = {
    mode: expectedMode,
    expiresAt: value.expires_at as number,
    relay: Object.freeze({
      mode: relay.mode as Welcome['relay']['mode'],
      host: relay.host as string,
      browserPath: 'derp' as const,
    }),
    capabilities: Object.freeze([...(value.capabilities as string[])]),
    ...(expectedMode === 'leash'
      ? { accessMode: value.access_mode as 'code' | 'link' }
      : {}),
  };
  return Object.freeze(welcome);
}

export function helloFrame(
  sessionID: Uint8Array,
  mode: 'escape' | 'leash',
): Frame {
  if (sessionID.byteLength !== 16 || sessionID.every((value) => value === 0)) {
    throw new ProtocolError('BAD_MOUSE_CARD');
  }
  const payload = new TextEncoder().encode(
    JSON.stringify({
      protocol_min: mode === 'escape' ? 1 : 2,
      protocol_max: mode === 'escape' ? 1 : 2,
      session_id: Array.from(sessionID, (value) =>
        value.toString(16).padStart(2, '0'),
      ).join(''),
      mode,
      client: {
        name: 'tailmouse-web',
        version: BUILD.version,
        platform: 'web',
        user_agent: '',
      },
    }),
  );
  return { type: Message.CLIENT_HELLO, payload };
}

type AuthenticationField = 'challenge' | 'proof';

function decodeAuthenticationPayload(
  payload: Uint8Array,
  field: AuthenticationField,
): Uint8Array {
  const value = strictObject(payload);
  if (
    !exactKeys(value, [field, 'scheme']) ||
    value.scheme !== 'hmac-sha256-v1' ||
    typeof value[field] !== 'string' ||
    !/^[A-Za-z0-9_-]{43}$/u.test(value[field])
  ) {
    throw new ProtocolError('BAD_FRAME');
  }
  let decoded: Uint8Array;
  try {
    const base64 = value[field].replaceAll('-', '+').replaceAll('_', '/');
    const binary = atob(base64.padEnd(44, '='));
    decoded = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    throw new ProtocolError('BAD_FRAME');
  }
  const canonical = btoa(String.fromCharCode(...decoded))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
  if (decoded.byteLength !== 32 || canonical !== value[field]) {
    decoded.fill(0);
    throw new ProtocolError('BAD_FRAME');
  }
  return decoded;
}

function authenticationFrame(
  type: typeof Message.AUTH_CHALLENGE | typeof Message.AUTH_PROOF,
  field: AuthenticationField,
  value: Uint8Array,
): Frame {
  if (value.byteLength !== 32) throw new ProtocolError('BAD_FRAME');
  const encoded = btoa(String.fromCharCode(...value))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
  const payload = new TextEncoder().encode(
    JSON.stringify({ scheme: 'hmac-sha256-v1', [field]: encoded }),
  );
  const decoded = decodeAuthenticationPayload(payload, field);
  decoded.fill(0);
  return { type, payload };
}

export function authChallengeFrame(challenge: Uint8Array): Frame {
  return authenticationFrame(Message.AUTH_CHALLENGE, 'challenge', challenge);
}

export function decodeAuthChallenge(frame: Frame): Uint8Array {
  if (frame.type !== Message.AUTH_CHALLENGE || frame.payload.byteLength > 512) {
    throw new ProtocolError('BAD_FRAME');
  }
  return decodeAuthenticationPayload(frame.payload, 'challenge');
}

export function authProofFrame(proof: Uint8Array): Frame {
  return authenticationFrame(Message.AUTH_PROOF, 'proof', proof);
}

export function decodeAuthProof(frame: Frame): Uint8Array {
  if (frame.type !== Message.AUTH_PROOF || frame.payload.byteLength > 512) {
    throw new ProtocolError('BAD_FRAME');
  }
  return decodeAuthenticationPayload(frame.payload, 'proof');
}

function wireErrorCode(
  value: unknown,
): value is Exclude<ProtocolErrorCode, 'CANCELED'> {
  return (
    typeof value === 'string' &&
    value !== 'CANCELED' &&
    Object.hasOwn(errorMessages, value)
  );
}

function validateError(payload: Uint8Array): Record<string, unknown> {
  const value = strictObject(payload);
  if (
    !wireErrorCode(value.code) ||
    !boundedText(value.message, 1, 256) ||
    typeof value.retryable !== 'boolean'
  ) {
    throw new ProtocolError('BAD_FRAME');
  }
  if (
    value.code === 'AUTH_THROTTLED'
      ? !exactKeys(value, ['code', 'message', 'retry_after_ms', 'retryable']) ||
        !integerBetween(value.retry_after_ms, 1, 30_000)
      : !exactKeys(value, ['code', 'message', 'retryable'])
  ) {
    throw new ProtocolError('BAD_FRAME');
  }
  return value;
}

// Never expose a peer's message or retry suggestion to the UI. Both come from
// the local stable vocabulary, even if a valid peer sends credential-like text.
export function decodeError(frame: Frame): ProtocolError {
  if (frame.type !== Message.ERROR || frame.payload.byteLength > 1024) {
    throw new ProtocolError('BAD_FRAME');
  }
  const value = validateError(frame.payload);
  return new ProtocolError(
    value.code as ProtocolErrorCode,
    value.code === 'AUTH_THROTTLED'
      ? (value.retry_after_ms as number)
      : undefined,
  );
}

export function errorFrame(
  code: Exclude<ProtocolErrorCode, 'CANCELED'>,
  retryAfterMS?: number,
): Frame {
  if (!wireErrorCode(code)) throw new ProtocolError('BAD_FRAME');
  if (
    (code === 'AUTH_THROTTLED' && !integerBetween(retryAfterMS, 1, 30_000)) ||
    (code !== 'AUTH_THROTTLED' && retryAfterMS !== undefined)
  ) {
    throw new ProtocolError('BAD_FRAME');
  }
  const error = new ProtocolError(code, retryAfterMS);
  return {
    type: Message.ERROR,
    payload: new TextEncoder().encode(
      JSON.stringify({
        code,
        message: error.message,
        retryable: error.retryable,
        ...(code === 'AUTH_THROTTLED' ? { retry_after_ms: retryAfterMS } : {}),
      }),
    ),
  };
}

const closeReasons = [
  'normal',
  'mode_complete',
  'local_revoke',
  'expired',
  'protocol_error',
  'transport_error',
] as const;
export type CloseReason = (typeof closeReasons)[number];

function validateClose(payload: Uint8Array): Record<string, unknown> {
  const value = strictObject(payload);
  if (
    !exactKeys(value, ['message', 'reason']) ||
    !closeReasons.includes(value.reason as CloseReason) ||
    !boundedText(value.message, 1, 256)
  ) {
    throw new ProtocolError('BAD_FRAME');
  }
  return value;
}

export function closeFrame(reason: CloseReason): Frame {
  const payload = new TextEncoder().encode(
    JSON.stringify({ reason, message: 'Session closed.' }),
  );
  validateClose(payload);
  return { type: Message.CLOSE, payload };
}

export function decodeClose(frame: Frame): CloseReason {
  if (frame.type !== Message.CLOSE || frame.payload.byteLength > 512) {
    throw new ProtocolError('BAD_FRAME');
  }
  return validateClose(frame.payload).reason as CloseReason;
}
