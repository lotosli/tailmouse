import type { GameInit, GamePoint, GameSnapshot } from './protocol/game.ts';

export interface EscapePredictionFrame {
  readonly mouse: GamePoint;
  readonly dust:
    { readonly point: GamePoint; readonly progress: number } | undefined;
}

// Visual mouse displacement only. There is no input replay, outcome state,
// network timing estimate or timer; the client supplies its monotonic clock.
export class EscapePrediction {
  readonly #init: GameInit;
  #snapshot: GameSnapshot | undefined;
  #position: GamePoint;
  #direction: GamePoint = { x: 0, y: 0 };
  #offset: GamePoint = { x: 0, y: 0 };
  #at = 0;
  #receivedAt = 0;
  #correctionMS = 100;
  #dashUntil = 0;
  #dust: { point: GamePoint; at: number } | undefined;

  constructor(init: GameInit) {
    this.#init = init;
    this.#position = init.mouse;
  }

  move(direction: GamePoint, now: number): void {
    this.#advance(now);
    this.#direction = direction;
  }

  receive(snapshot: GameSnapshot, now: number): void {
    if (snapshot.sequence <= (this.#snapshot?.sequence ?? 0)) return;
    const correctionUntil = this.#receivedAt + this.#correctionMS;
    const correcting = this.#offset.x !== 0 || this.#offset.y !== 0;
    const previous = this.render(now).mouse;
    const first = this.#snapshot === undefined;
    this.#snapshot = snapshot;
    this.#receivedAt = this.#at;
    this.#position = snapshot.mouse;
    const error = Math.hypot(
      previous.x - snapshot.mouse.x,
      previous.y - snapshot.mouse.y,
    );
    this.#correctionMS = error < 0.25 ? 100 : 200;
    if (correcting && correctionUntil > this.#at) {
      this.#correctionMS = Math.min(
        this.#correctionMS,
        correctionUntil - this.#at,
      );
    }
    if (first || error > 1) {
      this.#offset = { x: 0, y: 0 };
      if (!first) this.#dust = { point: snapshot.mouse, at: this.#at };
    } else {
      this.#offset = {
        x: previous.x - snapshot.mouse.x,
        y: previous.y - snapshot.mouse.y,
      };
    }
    // Cooldown includes the accepted dash's duration. It never grants another
    // dash or changes the authoritative cooldown shown by the UI.
    this.#dashUntil =
      this.#at +
      Math.max(
        0,
        snapshot.dashCooldownMS -
          (this.#init.constants.dash_cooldown_ms -
            this.#init.constants.dash_duration_ms),
      );
  }

  render(now: number): EscapePredictionFrame {
    this.#advance(now);
    const weight = Math.max(
      0,
      1 - (this.#at - this.#receivedAt) / this.#correctionMS,
    );
    const mouse = movePoint(this.#init.map.rows, this.#position, {
      x: this.#offset.x * weight,
      y: this.#offset.y * weight,
    });
    const dust = this.#dust;
    if (dust !== undefined && this.#at - dust.at >= 250) this.#dust = undefined;
    return Object.freeze({
      mouse: Object.freeze(mouse),
      dust:
        this.#dust === undefined
          ? undefined
          : Object.freeze({
              point: this.#dust.point,
              progress: (this.#at - this.#dust.at) / 250,
            }),
    });
  }

  #advance(now: number): void {
    if (!Number.isFinite(now) || now < 0)
      throw new RangeError('Invalid prediction clock');
    // Animation callbacks and input use the same time origin. A callback's
    // timestamp can precede a just-dispatched event; never rewind movement.
    now = Math.max(now, this.#at);
    const from = this.#at;
    this.#at = now;
    if (now - from > 100 || this.#snapshot?.phase !== 1) return;
    const until = Math.min(now, this.#receivedAt + 500);
    if (until <= from) return;
    const dashing = Math.max(0, Math.min(until, this.#dashUntil) - from);
    const distance =
      (this.#init.constants.mouse_speed *
        (until - from + dashing * (this.#init.constants.dash_multiplier - 1))) /
      1000;
    this.#position = movePoint(this.#init.map.rows, this.#position, {
      x: this.#direction.x * distance,
      y: this.#direction.y * distance,
    });
  }
}

// Sweep X then Y, matching host wall sliding without copying its game engine.
// The epsilon is visual only; authoritative float32 positions arrive in SNAP.
function movePoint(
  rows: readonly string[],
  point: GamePoint,
  delta: GamePoint,
): GamePoint {
  const axis = (
    coordinate: number,
    fixed: number,
    amount: number,
    horizontal: boolean,
  ): number => {
    const end = coordinate + amount;
    const sign = amount < 0 ? -1 : 1;
    for (let cell = Math.floor(coordinate); cell !== Math.floor(end);) {
      cell += sign;
      if (
        (horizontal
          ? rows[Math.floor(fixed)]?.[cell]
          : rows[cell]?.[Math.floor(fixed)]) !== '.'
      ) {
        return cell + (sign < 0 ? 1 : 0) - sign * 0.000001;
      }
    }
    return end;
  };
  const x = axis(point.x, point.y, delta.x, true);
  return { x, y: axis(point.y, x, delta.y, false) };
}
