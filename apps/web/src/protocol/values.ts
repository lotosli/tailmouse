export type ProtocolErrorCode =
  | 'BAD_FRAME'
  | 'FRAME_TOO_LARGE'
  | 'MODE_MISMATCH'
  | 'PROTOCOL_MISMATCH'
  | 'BAD_MOUSE_CARD'
  | 'EXPIRED'
  | 'SESSION_BUSY'
  | 'UNAUTHORIZED_CAPABILITY'
  | 'PROCESS_NOT_RUNNING'
  | 'RESTART_DISABLED'
  | 'TERMINATE_DISABLED'
  | 'READONLY'
  | 'BACKPRESSURE'
  | 'CANCELED'
  | 'INTERNAL';

export const errorMessages: Record<ProtocolErrorCode, string> = {
  BAD_FRAME: 'TMOUSE/1 frame is invalid.',
  FRAME_TOO_LARGE: 'TMOUSE/1 frame exceeds its limit.',
  MODE_MISMATCH: 'TMOUSE/1 message does not match the session mode.',
  PROTOCOL_MISMATCH: 'TMOUSE/1 protocol versions do not overlap.',
  CANCELED: 'TMOUSE/1 operation was canceled.',
  INTERNAL: 'TMOUSE/1 stream operation failed.',
  BAD_MOUSE_CARD: 'Invitation is invalid or unsupported.',
  EXPIRED: 'Session has expired.',
  SESSION_BUSY: 'Another browser is controlling this session.',
  UNAUTHORIZED_CAPABILITY: 'This session does not grant that action.',
  PROCESS_NOT_RUNNING: 'No process is available for that action.',
  RESTART_DISABLED: 'Restart is disabled for this session.',
  TERMINATE_DISABLED: 'Terminate is disabled for this session.',
  READONLY: 'Browser control is disabled for this session.',
  BACKPRESSURE: 'Input is paused until bounded capacity is available.',
};

export class ProtocolError extends Error {
  readonly code: ProtocolErrorCode;
  readonly retryable: boolean;

  constructor(code: ProtocolErrorCode) {
    super(errorMessages[code]);
    this.name = 'ProtocolError';
    this.code = code;
    this.retryable = [
      'SESSION_BUSY',
      'PROCESS_NOT_RUNNING',
      'BACKPRESSURE',
    ].includes(code);
  }
}

export function strictObject(payload: Uint8Array): Record<string, unknown> {
  if (payload[0] === 0xef && payload[1] === 0xbb && payload[2] === 0xbf) {
    throw new ProtocolError('BAD_FRAME');
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(payload);
  } catch {
    throw new ProtocolError('BAD_FRAME');
  }
  assertNoDuplicateJSONNames(text);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ProtocolError('BAD_FRAME');
  }
  if (!isRecord(value)) throw new ProtocolError('BAD_FRAME');
  return value;
}

function assertNoDuplicateJSONNames(text: string): void {
  let offset = 0;
  const skipWhitespace = (): void => {
    while (/\s/u.test(text[offset] ?? '')) offset += 1;
  };
  const readString = (): string => {
    const start = offset;
    offset += 1;
    while (offset < text.length) {
      const character = text[offset];
      if (character === '"') {
        offset += 1;
        try {
          return JSON.parse(text.slice(start, offset)) as string;
        } catch {
          throw new ProtocolError('BAD_FRAME');
        }
      }
      if (character === '\\') {
        offset += text[offset + 1] === 'u' ? 6 : 2;
      } else {
        offset += 1;
      }
    }
    throw new ProtocolError('BAD_FRAME');
  };
  const readValue = (depth: number): void => {
    if (depth > 32) throw new ProtocolError('BAD_FRAME');
    skipWhitespace();
    const character = text[offset];
    if (character === '{') {
      offset += 1;
      skipWhitespace();
      const names = new Set<string>();
      if (text[offset] === '}') {
        offset += 1;
        return;
      }
      while (offset < text.length) {
        if (text[offset] !== '"') throw new ProtocolError('BAD_FRAME');
        const name = readString();
        if (names.has(name)) throw new ProtocolError('BAD_FRAME');
        names.add(name);
        skipWhitespace();
        if (text[offset] !== ':') throw new ProtocolError('BAD_FRAME');
        offset += 1;
        readValue(depth + 1);
        skipWhitespace();
        if (text[offset] === '}') {
          offset += 1;
          return;
        }
        if (text[offset] !== ',') throw new ProtocolError('BAD_FRAME');
        offset += 1;
        skipWhitespace();
      }
      throw new ProtocolError('BAD_FRAME');
    }
    if (character === '[') {
      offset += 1;
      skipWhitespace();
      if (text[offset] === ']') {
        offset += 1;
        return;
      }
      while (offset < text.length) {
        readValue(depth + 1);
        skipWhitespace();
        if (text[offset] === ']') {
          offset += 1;
          return;
        }
        if (text[offset] !== ',') throw new ProtocolError('BAD_FRAME');
        offset += 1;
      }
      throw new ProtocolError('BAD_FRAME');
    }
    if (character === '"') {
      readString();
      return;
    }
    const primitive = text
      .slice(offset)
      .match(
        /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/u,
      )?.[0];
    if (!primitive) throw new ProtocolError('BAD_FRAME');
    offset += primitive.length;
  };

  readValue(1);
  skipWhitespace();
  if (offset !== text.length) throw new ProtocolError('BAD_FRAME');
}

export function exactKeys(
  value: Record<string, unknown>,
  expected: string[],
): boolean {
  const actual = Object.keys(value).sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

export function integerBetween(
  value: unknown,
  minimum: number,
  maximum: number,
): value is number {
  return (
    Number.isSafeInteger(value) &&
    Number(value) >= minimum &&
    Number(value) <= maximum
  );
}

export function boundedText(
  value: unknown,
  minimum: number,
  maximum: number,
): value is string {
  if (typeof value !== 'string') return false;
  const bytes = new TextEncoder().encode(value).byteLength;
  return bytes >= minimum && bytes <= maximum;
}

export function validHostname(host: string): boolean {
  return (
    host.length > 0 &&
    host.length <= 253 &&
    !host.endsWith('.') &&
    host
      .split('.')
      .every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label))
  );
}

export function dataView(value: Uint8Array): DataView {
  return new DataView(value.buffer, value.byteOffset, value.byteLength);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
