import {
  exactKeys,
  boundedText,
  integerBetween,
  ProtocolError,
  strictObject,
} from './values.ts';

export interface TermReset {
  readonly generation: number;
  readonly cols: number;
  readonly rows: number;
}
export type ProcessAction = 'interrupt' | 'restart' | 'terminate';
export interface ProcessControl {
  readonly action: ProcessAction;
  readonly generation: number;
}
export interface ProcessState {
  readonly generation: number;
  readonly state:
    | 'waiting'
    | 'starting'
    | 'running'
    | 'interrupting'
    | 'terminating'
    | 'exited'
    | 'restarting'
    | 'failed'
    | 'closing';
  readonly pid: number | null;
  readonly started_at: number | null;
  readonly exit_code: number | null;
  readonly signal: string | null;
  readonly title?: string;
}
export interface OutputDropped {
  readonly generation: number;
  readonly dropped_bytes: number;
}

function terminalObject(
  payload: Uint8Array,
  limit: number,
  keys: string[],
): Record<string, unknown> {
  if (payload.byteLength < 2 || payload.byteLength > limit)
    throw new ProtocolError('BAD_FRAME');
  const value = strictObject(payload);
  if (
    !exactKeys(value, keys) ||
    !integerBetween(value.generation, 1, 0xffff_ffff)
  )
    throw new ProtocolError('BAD_FRAME');
  return value;
}

export function decodeTermReset(payload: Uint8Array): TermReset {
  const value = terminalObject(payload, 1024, ['cols', 'generation', 'rows']);
  if (
    !integerBetween(value.cols, 20, 500) ||
    !integerBetween(value.rows, 5, 200)
  )
    throw new ProtocolError('BAD_FRAME');
  return Object.freeze(value) as unknown as TermReset;
}

export function decodeProcessControl(payload: Uint8Array): ProcessControl {
  const value = terminalObject(payload, 512, ['action', 'generation']);
  if (!['interrupt', 'restart', 'terminate'].includes(value.action as string))
    throw new ProtocolError('BAD_FRAME');
  return Object.freeze(value) as unknown as ProcessControl;
}

export function decodeProcessState(payload: Uint8Array): ProcessState {
  if (payload.byteLength < 2 || payload.byteLength > 1024)
    throw new ProtocolError('BAD_FRAME');
  const value = strictObject(payload);
  const keys = [
    'exit_code',
    'generation',
    'pid',
    'signal',
    'started_at',
    'state',
  ];
  if (Object.hasOwn(value, 'title')) keys.push('title');
  if (
    !exactKeys(value, keys) ||
    !integerBetween(value.generation, 1, 0xffff_ffff)
  )
    throw new ProtocolError('BAD_FRAME');
  if (Object.hasOwn(value, 'title')) {
    if (typeof value.title === 'string')
      value.title = value.title.toWellFormed();
    if (!boundedText(value.title, 1, 256)) throw new ProtocolError('BAD_FRAME');
    for (const character of value.title) {
      const code = character.charCodeAt(0);
      if (code < 32 || (code >= 127 && code <= 159))
        throw new ProtocolError('BAD_FRAME');
    }
  }
  if (
    ![
      'waiting',
      'starting',
      'running',
      'interrupting',
      'terminating',
      'exited',
      'restarting',
      'failed',
      'closing',
    ].includes(value.state as string) ||
    (value.pid !== null &&
      !integerBetween(value.pid, 1, Number.MAX_SAFE_INTEGER)) ||
    (value.started_at !== null &&
      !integerBetween(value.started_at, 0, Number.MAX_SAFE_INTEGER)) ||
    (value.exit_code !== null &&
      !integerBetween(value.exit_code, 0, 0xffff_ffff)) ||
    (value.signal !== null &&
      (typeof value.signal !== 'string' ||
        !/^[A-Z0-9_]{1,32}$/u.test(value.signal)))
  )
    throw new ProtocolError('BAD_FRAME');
  return Object.freeze(value) as unknown as ProcessState;
}

export function decodeOutputDropped(payload: Uint8Array): OutputDropped {
  const value = terminalObject(payload, 512, ['dropped_bytes', 'generation']);
  if (!integerBetween(value.dropped_bytes, 0, Number.MAX_SAFE_INTEGER))
    throw new ProtocolError('BAD_FRAME');
  return Object.freeze(value) as unknown as OutputDropped;
}

export function encodeProcessControl(value: ProcessControl): Uint8Array {
  const payload = new TextEncoder().encode(JSON.stringify(value));
  decodeProcessControl(payload);
  return payload;
}
