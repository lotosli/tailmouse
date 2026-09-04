import type { GamePoint } from './protocol/game.ts';

export function joystickVector(
  x: number,
  y: number,
  radius: number,
): GamePoint {
  if (![x, y, radius].every(Number.isFinite) || radius <= 0)
    return { x: 0, y: 0 };
  const magnitude = Math.hypot(x, y) / radius;
  if (magnitude <= 0.08) return { x: 0, y: 0 };
  const divisor = radius * Math.max(1, magnitude);
  return { x: x / divisor, y: y / divisor };
}

export interface InputView {
  readonly mode: 'touch' | 'tilt';
  readonly tilt:
    'off' | 'permission' | 'calibrating' | 'active' | 'unavailable' | 'denied';
  readonly direction: GamePoint;
  readonly pointer: { readonly x: number; readonly y: number } | undefined;
}

const keys: Record<string, GamePoint> = {
  ArrowUp: { x: 0, y: -1 },
  w: { x: 0, y: -1 },
  ArrowDown: { x: 0, y: 1 },
  s: { x: 0, y: 1 },
  ArrowLeft: { x: -1, y: 0 },
  a: { x: -1, y: 0 },
  ArrowRight: { x: 1, y: 0 },
  d: { x: 1, y: 0 },
};

// One mounted control surface owns all listeners and permission/calibration work.
export class EscapeInput {
  readonly #area: HTMLElement;
  readonly #move: (x: number, y: number) => void;
  #view: InputView = {
    mode: 'touch',
    tilt: 'off',
    direction: { x: 0, y: 0 },
    pointer: undefined,
  };
  #pointer: number | undefined;
  #center = { x: 0, y: 0 };
  #held = new Set<string>();
  #epoch = 0;
  #disposed = false;
  #calibration: ReturnType<typeof setTimeout> | undefined;
  #lastSensor = 0;
  #sensorTimer: ReturnType<typeof setInterval> | undefined;
  #count = 0;
  #sum = { x: 0, y: 0 };
  #baseline = { x: 0, y: 0 };
  #filtered = { x: 0, y: 0 };

  constructor(area: HTMLElement, move: (x: number, y: number) => void) {
    this.#area = area;
    this.#move = move;
    area.addEventListener('pointerdown', this.#down);
    area.addEventListener('pointermove', this.#drag);
    area.addEventListener('pointerup', this.#up);
    area.addEventListener('pointercancel', this.#up);
    area.addEventListener('lostpointercapture', this.#up);
    area.addEventListener('keydown', this.#keyDown);
    area.addEventListener('keyup', this.#keyUp);
    area.addEventListener('blur', this.#reset);
    window.addEventListener('blur', this.#background);
    document.addEventListener('visibilitychange', this.#visibility);
  }

  inspect(): InputView {
    return this.#view;
  }

  touch(): void {
    this.#epoch++;
    clearTimeout(this.#calibration);
    clearInterval(this.#sensorTimer);
    window.removeEventListener('deviceorientation', this.#orientation);
    this.#view = { ...this.#view, mode: 'touch', tilt: 'off' };
    this.#reset();
  }

  // The permission call runs synchronously in the click handler before awaiting.
  async enableTilt(): Promise<void> {
    if (this.#disposed) return;
    this.touch();
    const epoch = this.#epoch;
    const sensor = window.DeviceOrientationEvent as
      | (typeof DeviceOrientationEvent & {
          requestPermission?: () => Promise<string>;
        })
      | undefined;
    if (sensor === undefined) {
      this.#fallback('unavailable');
      return;
    }
    this.#view = { ...this.#view, tilt: 'permission' };
    if (sensor.requestPermission !== undefined) {
      let permission: string;
      try {
        permission = await sensor.requestPermission();
      } catch {
        permission = 'denied';
      }
      if (this.#disposed || epoch !== this.#epoch) return;
      if (permission !== 'granted') {
        this.#fallback('denied');
        return;
      }
    }
    this.#count = 0;
    this.#sum = { x: 0, y: 0 };
    this.#filtered = { x: 0, y: 0 };
    this.#view = { ...this.#view, mode: 'tilt', tilt: 'calibrating' };
    window.addEventListener('deviceorientation', this.#orientation);
    this.#calibration = setTimeout(() => {
      if (this.#count === 0 || performance.now() - this.#lastSensor > 500) {
        this.#fallback('unavailable');
        return;
      }
      this.#baseline = {
        x: this.#sum.x / this.#count,
        y: this.#sum.y / this.#count,
      };
      this.#view = { ...this.#view, tilt: 'active' };
      this.#sensorTimer = setInterval(() => {
        if (performance.now() - this.#lastSensor > 500)
          this.#fallback('unavailable');
      }, 250);
    }, 1000);
  }

  dispose(): void {
    this.#disposed = true;
    this.touch();
    this.#area.removeEventListener('pointerdown', this.#down);
    this.#area.removeEventListener('pointermove', this.#drag);
    this.#area.removeEventListener('pointerup', this.#up);
    this.#area.removeEventListener('pointercancel', this.#up);
    this.#area.removeEventListener('lostpointercapture', this.#up);
    this.#area.removeEventListener('keydown', this.#keyDown);
    this.#area.removeEventListener('keyup', this.#keyUp);
    this.#area.removeEventListener('blur', this.#reset);
    window.removeEventListener('blur', this.#background);
    document.removeEventListener('visibilitychange', this.#visibility);
  }

  #set = (direction: GamePoint): void => {
    this.#view = { ...this.#view, direction };
    this.#move(direction.x, direction.y);
  };
  #reset = (): void => {
    const pointer = this.#pointer;
    this.#pointer = undefined;
    this.#held.clear();
    this.#view = { ...this.#view, pointer: undefined };
    this.#set({ x: 0, y: 0 });
    if (pointer !== undefined && this.#area.hasPointerCapture(pointer))
      this.#area.releasePointerCapture(pointer);
  };
  #background = (): void => {
    this.touch();
  };
  #visibility = (): void => {
    if (document.hidden) this.touch();
  };
  #fallback(status: 'denied' | 'unavailable'): void {
    this.touch();
    this.#view = { ...this.#view, tilt: status };
  }
  #down = (event: PointerEvent): void => {
    if (
      this.#view.mode !== 'touch' ||
      this.#pointer !== undefined ||
      event.button !== 0
    )
      return;
    event.preventDefault();
    this.#area.focus({ preventScroll: true });
    this.#reset();
    this.#pointer = event.pointerId;
    this.#center = { x: event.clientX, y: event.clientY };
    const bounds = this.#area.getBoundingClientRect();
    this.#view = {
      ...this.#view,
      pointer: {
        x: event.clientX - bounds.left,
        y: event.clientY - bounds.top,
      },
    };
    this.#area.setPointerCapture(event.pointerId);
  };
  #drag = (event: PointerEvent): void => {
    if (event.pointerId !== this.#pointer) return;
    this.#set(
      joystickVector(
        event.clientX - this.#center.x,
        event.clientY - this.#center.y,
        Math.min(window.innerWidth, window.innerHeight) * 0.18,
      ),
    );
  };
  #up = (event: PointerEvent): void => {
    if (event.pointerId === this.#pointer) this.#reset();
  };
  #keyDown = (event: KeyboardEvent): void => {
    const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
    if (
      !Object.hasOwn(keys, key) ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey
    )
      return;
    event.preventDefault();
    if (this.#view.mode !== 'touch') this.touch();
    if (this.#pointer !== undefined) this.#reset();
    this.#held.add(key);
    this.#keyboard();
  };
  #keyUp = (event: KeyboardEvent): void => {
    const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
    if (!this.#held.delete(key)) return;
    event.preventDefault();
    this.#keyboard();
  };
  #keyboard(): void {
    let x = 0,
      y = 0;
    for (const key of this.#held) {
      x += keys[key]!.x;
      y += keys[key]!.y;
    }
    const scale = Math.max(1, Math.hypot(x, y));
    this.#set({ x: x / scale, y: y / scale });
  }
  #orientation = (event: DeviceOrientationEvent): void => {
    if (
      event.gamma === null ||
      event.beta === null ||
      !Number.isFinite(event.gamma) ||
      !Number.isFinite(event.beta) ||
      Math.abs(event.gamma) > 90 ||
      Math.abs(event.beta) > 180
    )
      return;
    this.#lastSensor = performance.now();
    if (this.#view.tilt === 'calibrating') {
      this.#count++;
      this.#sum.x += event.gamma;
      this.#sum.y += event.beta;
      return;
    }
    this.#filtered = {
      x: this.#filtered.x * 0.8 + (event.gamma - this.#baseline.x) * 0.2,
      y: this.#filtered.y * 0.8 + (event.beta - this.#baseline.y) * 0.2,
    };
    const angle = ((screen.orientation?.angle ?? 0) * Math.PI) / 180;
    this.#set(
      joystickVector(
        this.#filtered.x * Math.cos(angle) + this.#filtered.y * Math.sin(angle),
        this.#filtered.y * Math.cos(angle) - this.#filtered.x * Math.sin(angle),
        30,
      ),
    );
  };
}
