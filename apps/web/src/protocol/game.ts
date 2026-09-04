import {
  ProtocolError,
  strictObject,
  exactKeys,
  integerBetween,
  isRecord,
  validHostname,
  dataView,
} from './values.ts';

export interface GamePoint {
  readonly x: number;
  readonly y: number;
}
export interface GameConstants {
  readonly mouse_speed: number;
  readonly cat_base_speed: number;
  readonly cat_max_speed: number;
  readonly dash_multiplier: number;
  readonly dash_duration_ms: number;
  readonly dash_cooldown_ms: number;
}
export interface GameInit {
  readonly seed: string;
  readonly map: {
    readonly name: string;
    readonly width: number;
    readonly height: number;
    readonly rows: readonly string[];
  };
  readonly mouse: GamePoint;
  readonly cat: GamePoint;
  readonly cheeses: readonly [GamePoint, GamePoint];
  readonly exit: GamePoint;
  readonly round_duration_ms: number;
  readonly countdown_ms: number;
  readonly constants: GameConstants;
  readonly presentation: {
    readonly control: 'touch' | 'tilt';
    readonly phone_render: boolean;
    readonly show_net: boolean;
  };
}

const constants: GameConstants = Object.freeze({
  mouse_speed: 6,
  cat_base_speed: 5.3,
  cat_max_speed: 6.2,
  dash_multiplier: 2.2,
  dash_duration_ms: 350,
  dash_cooldown_ms: 5000,
});

export function decodeGameInit(payload: Uint8Array): GameInit {
  const value = gameObject(payload, 16_384);
  if (
    !exactKeys(value, [
      'cat',
      'cheeses',
      'constants',
      'countdown_ms',
      'exit',
      'map',
      'mouse',
      'presentation',
      'round_duration_ms',
      'seed',
    ]) ||
    typeof value.seed !== 'string' ||
    value.seed.length > 20 ||
    !/^(?:0|-[1-9]\d*|[1-9]\d*)$/u.test(value.seed) ||
    BigInt(value.seed) < -(1n << 63n) ||
    BigInt(value.seed) > (1n << 63n) - 1n ||
    !integerBetween(value.round_duration_ms, 30_000, 45_000) ||
    !isRecord(value.presentation) ||
    !exactKeys(value.presentation, ['control', 'phone_render', 'show_net']) ||
    !['touch', 'tilt'].includes(value.presentation.control as string) ||
    typeof value.presentation.phone_render !== 'boolean' ||
    typeof value.presentation.show_net !== 'boolean' ||
    value.countdown_ms !== 3000 ||
    !isRecord(value.map) ||
    !exactKeys(value.map, ['height', 'name', 'rows', 'width']) ||
    typeof value.map.name !== 'string' ||
    !['courtyard', 'pantry', 'corridors', 'switchbacks', 'crossroads'].includes(
      value.map.name,
    ) ||
    value.map.width !== 48 ||
    value.map.height !== 18 ||
    !Array.isArray(value.map.rows) ||
    value.map.rows.length !== 18 ||
    !value.map.rows.every(
      (row: unknown) => typeof row === 'string' && /^[#.]{48}$/u.test(row),
    ) ||
    !Array.isArray(value.cheeses) ||
    value.cheeses.length !== 2 ||
    !isRecord(value.constants) ||
    !exactKeys(value.constants, [
      'cat_base_speed',
      'cat_max_speed',
      'dash_cooldown_ms',
      'dash_duration_ms',
      'dash_multiplier',
      'mouse_speed',
    ])
  ) {
    throw new ProtocolError('BAD_FRAME');
  }
  for (const key of Object.keys(constants) as Array<keyof GameConstants>) {
    if (value.constants[key] !== constants[key])
      throw new ProtocolError('BAD_FRAME');
  }
  const rows = value.map.rows as string[];
  if (
    rows.some((row, y) =>
      y === 0 || y === 17
        ? row !== '#'.repeat(48)
        : row[0] !== '#' || row[47] !== '#',
    )
  ) {
    throw new ProtocolError('BAD_FRAME');
  }
  const mouse = gamePoint(value.mouse),
    cat = gamePoint(value.cat),
    exit = gamePoint(value.exit);
  const cheeses: readonly [GamePoint, GamePoint] = Object.freeze([
    gamePoint(value.cheeses[0]),
    gamePoint(value.cheeses[1]),
  ]);
  const occupied = new Set<number>();
  for (const point of [mouse, cat, ...cheeses, exit]) {
    const x = Math.floor(point.x),
      y = Math.floor(point.y),
      cell = y * 48 + x;
    if (rows[y]![x] !== '.' || occupied.has(cell))
      throw new ProtocolError('BAD_FRAME');
    occupied.add(cell);
  }
  return Object.freeze({
    seed: value.seed,
    map: Object.freeze({
      name: value.map.name,
      width: 48,
      height: 18,
      rows: Object.freeze([...rows]),
    }),
    mouse,
    cat,
    cheeses,
    exit,
    round_duration_ms: value.round_duration_ms,
    countdown_ms: 3000,
    constants,
    presentation: Object.freeze({
      control: value.presentation.control as 'touch' | 'tilt',
      phone_render: value.presentation.phone_render,
      show_net: value.presentation.show_net,
    }),
  });
}

export function encodeGameInit(value: GameInit): Uint8Array {
  return jsonBytes(decodeGameInit(jsonBytes(value)));
}

function gamePoint(value: unknown): GamePoint {
  if (
    !isRecord(value) ||
    !exactKeys(value, ['x', 'y']) ||
    !coordinate(value.x, 48) ||
    !coordinate(value.y, 18)
  ) {
    throw new ProtocolError('BAD_FRAME');
  }
  return Object.freeze({ x: value.x, y: value.y });
}

function coordinate(value: unknown, maximum: number): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0 &&
    value < maximum
  );
}

export interface GameInput {
  readonly sequence: number;
  readonly clientTimeMS: bigint;
  readonly velocityX: number;
  readonly velocityY: number;
  readonly dash: boolean;
}

export function decodeGameInput(payload: Uint8Array): GameInput {
  if (payload.byteLength !== 24) throw new ProtocolError('BAD_FRAME');
  const view = dataView(payload),
    x = view.getFloat32(12),
    y = view.getFloat32(16);
  if (
    view.getUint32(0) === 0 ||
    !unit(x) ||
    !unit(y) ||
    x * x + y * y > 1.000001 ||
    (payload[20]! & 0xfe) !== 0 ||
    payload[21] !== 0 ||
    payload[22] !== 0 ||
    payload[23] !== 0
  ) {
    throw new ProtocolError('BAD_FRAME');
  }
  return Object.freeze({
    sequence: view.getUint32(0),
    clientTimeMS: view.getBigUint64(4),
    velocityX: x,
    velocityY: y,
    dash: (payload[20]! & 1) !== 0,
  });
}

export function encodeGameInput(value: GameInput): Uint8Array {
  if (
    !integerBetween(value.sequence, 1, 0xffffffff) ||
    !u64(value.clientTimeMS) ||
    !unit(value.velocityX) ||
    !unit(value.velocityY) ||
    typeof value.dash !== 'boolean'
  ) {
    throw new ProtocolError('BAD_FRAME');
  }
  const payload = new Uint8Array(24),
    view = dataView(payload);
  view.setUint32(0, value.sequence);
  view.setBigUint64(4, value.clientTimeMS);
  view.setFloat32(12, value.velocityX);
  view.setFloat32(16, value.velocityY);
  payload[20] = value.dash ? 1 : 0;
  decodeGameInput(payload);
  return payload;
}

function unit(value: number): boolean {
  return Number.isFinite(value) && value >= -1 && value <= 1;
}
function u64(value: bigint): boolean {
  return typeof value === 'bigint' && value >= 0n && value <= (1n << 64n) - 1n;
}

export interface GameSnapshot {
  readonly sequence: number;
  readonly acceptedInputSequence: number;
  readonly elapsedMS: bigint;
  readonly mouse: GamePoint;
  readonly cat: GamePoint;
  readonly remainingMS: number;
  readonly dashCooldownMS: number;
  readonly collectedMask: number;
  readonly phase: number;
  readonly exitOpen: boolean;
}

export function decodeGameSnapshot(payload: Uint8Array): GameSnapshot {
  if (payload.byteLength !== 44) throw new ProtocolError('BAD_FRAME');
  const view = dataView(payload);
  const mouse = gamePoint({ x: view.getFloat32(16), y: view.getFloat32(20) });
  const cat = gamePoint({ x: view.getFloat32(24), y: view.getFloat32(28) });
  if (
    view.getUint32(0) === 0 ||
    view.getUint32(32) > 45_000 ||
    view.getUint32(36) > 5000 ||
    payload[40]! > 3 ||
    payload[41]! > 2 ||
    (payload[42]! & 0xfe) !== 0 ||
    payload[43] !== 0 ||
    (payload[40] === 3) !== ((payload[42]! & 1) === 1)
  )
    throw new ProtocolError('BAD_FRAME');
  return Object.freeze({
    sequence: view.getUint32(0),
    acceptedInputSequence: view.getUint32(4),
    elapsedMS: view.getBigUint64(8),
    mouse,
    cat,
    remainingMS: view.getUint32(32),
    dashCooldownMS: view.getUint32(36),
    collectedMask: payload[40]!,
    phase: payload[41]!,
    exitOpen: (payload[42]! & 1) !== 0,
  });
}

export function encodeGameSnapshot(value: GameSnapshot): Uint8Array {
  if (
    !integerBetween(value.sequence, 1, 0xffffffff) ||
    !integerBetween(value.acceptedInputSequence, 0, 0xffffffff) ||
    !u64(value.elapsedMS) ||
    !integerBetween(value.remainingMS, 0, 45_000) ||
    !integerBetween(value.dashCooldownMS, 0, 5000) ||
    !integerBetween(value.collectedMask, 0, 3) ||
    !integerBetween(value.phase, 0, 2) ||
    typeof value.exitOpen !== 'boolean'
  ) {
    throw new ProtocolError('BAD_FRAME');
  }
  gamePoint(value.mouse);
  gamePoint(value.cat);
  const payload = new Uint8Array(44),
    view = dataView(payload);
  view.setUint32(0, value.sequence);
  view.setUint32(4, value.acceptedInputSequence);
  view.setBigUint64(8, value.elapsedMS);
  [value.mouse.x, value.mouse.y, value.cat.x, value.cat.y].forEach((n, i) =>
    view.setFloat32(16 + i * 4, n),
  );
  view.setUint32(32, value.remainingMS);
  view.setUint32(36, value.dashCooldownMS);
  payload[40] = value.collectedMask;
  payload[41] = value.phase;
  payload[42] = value.exitOpen ? 1 : 0;
  decodeGameSnapshot(payload);
  return payload;
}

export interface GameEvent {
  readonly sequence: number;
  readonly event: string;
  readonly value: number | null;
}

export function decodeGameEvent(
  payload: Uint8Array,
  sender: 'host' | 'browser',
): GameEvent {
  const value = gameObject(payload, 1024);
  if (
    !exactKeys(value, ['event', 'sequence', 'value']) ||
    !integerBetween(value.sequence, 1, 0xffffffff) ||
    typeof value.event !== 'string'
  ) {
    throw new ProtocolError('BAD_FRAME');
  }
  let valid = false;
  if (sender === 'browser')
    valid = value.event === 'exit_requested' && value.value === null;
  else if (sender === 'host') {
    switch (value.event) {
      case 'countdown':
        valid = integerBetween(value.value, 0, 3);
        break;
      case 'cheese_collected':
        valid = integerBetween(value.value, 0, 1);
        break;
      case 'dash_rejected':
        valid = integerBetween(value.value, 0, 5000);
        break;
      case 'exit_opened':
      case 'connection_paused':
      case 'connection_resumed':
        valid = value.value === null;
        break;
    }
  }
  if (!valid) throw new ProtocolError('BAD_FRAME');
  return Object.freeze({
    sequence: value.sequence,
    event: value.event,
    value: value.value as number | null,
  });
}

export function encodeGameEvent(
  value: GameEvent,
  sender: 'host' | 'browser',
): Uint8Array {
  return jsonBytes(decodeGameEvent(jsonBytes(value), sender));
}

export interface GameResult {
  readonly outcome: string;
  readonly elapsed_ms: number;
  readonly relay: string;
  readonly rtt_p50_ms: number;
  readonly rtt_p95_ms: number;
  readonly jitter_ms: number | null;
  readonly message: string;
}

export function decodeGameResult(payload: Uint8Array): GameResult {
  const value = gameObject(payload, 2048);
  if (
    !exactKeys(value, [
      'elapsed_ms',
      'jitter_ms',
      'message',
      'outcome',
      'relay',
      'rtt_p50_ms',
      'rtt_p95_ms',
    ]) ||
    typeof value.outcome !== 'string' ||
    !integerBetween(value.elapsed_ms, 0, Number.MAX_SAFE_INTEGER) ||
    !integerBetween(value.rtt_p50_ms, 0, Number.MAX_SAFE_INTEGER) ||
    !integerBetween(
      value.rtt_p95_ms,
      value.rtt_p50_ms,
      Number.MAX_SAFE_INTEGER,
    ) ||
    (value.jitter_ms !== null &&
      !integerBetween(value.jitter_ms, 0, Number.MAX_SAFE_INTEGER)) ||
    typeof value.relay !== 'string' ||
    !validHostname(value.relay) ||
    value.message === '' ||
    value.message !== gameResultMessage(value.outcome, value.rtt_p50_ms)
  ) {
    throw new ProtocolError('BAD_FRAME');
  }
  return Object.freeze({
    outcome: value.outcome,
    elapsed_ms: value.elapsed_ms,
    relay: value.relay,
    rtt_p50_ms: value.rtt_p50_ms,
    rtt_p95_ms: value.rtt_p95_ms,
    jitter_ms: value.jitter_ms,
    message: gameResultMessage(value.outcome, value.rtt_p50_ms),
  });
}

export function gameResultMessage(outcome: string, p50: number): string {
  switch (outcome) {
    case 'escaped':
      return `The cat was always ${p50}ms too late.`;
    case 'caught':
    case 'timeout':
      return 'The connection was too good.';
    case 'connection_lost':
      return 'Connection lost.';
    default:
      return '';
  }
}

export function encodeGameResult(value: GameResult): Uint8Array {
  return jsonBytes(decodeGameResult(jsonBytes(value)));
}

function gameObject(
  payload: Uint8Array,
  limit: number,
): Record<string, unknown> {
  if (payload.byteLength > limit) throw new ProtocolError('FRAME_TOO_LARGE');
  if (payload.byteLength < 2) throw new ProtocolError('BAD_FRAME');
  return strictObject(payload);
}

function jsonBytes(value: unknown): Uint8Array {
  try {
    return new TextEncoder().encode(JSON.stringify(value));
  } catch {
    throw new ProtocolError('BAD_FRAME');
  }
}
