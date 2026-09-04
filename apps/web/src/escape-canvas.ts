import type { GameInit, GamePoint, GameSnapshot } from './protocol/game.ts';
import type { EscapePredictionFrame } from './escape-prediction.ts';

export interface EscapeScentSample {
  readonly at: number;
  readonly point: GamePoint;
}

// Display-owned history: these are positions the user actually saw, not new
// authoritative samples or interpolated paths through unobserved cells.
export function updateEscapeScent(
  history: EscapeScentSample[],
  mouse: GamePoint,
  now: number,
  rtt: number,
  jitter: number,
  active: boolean,
): GamePoint[] {
  if (!active) {
    history.length = 0;
    return [];
  }
  const latest = history.at(-1);
  if (
    latest !== undefined &&
    (now < latest.at ||
      now - latest.at > 100 ||
      Math.hypot(mouse.x - latest.point.x, mouse.y - latest.point.y) > 1)
  ) {
    history.length = 0;
  }
  const retained = history.at(-1);
  if (retained === undefined || now - retained.at >= 1000 / 30) {
    history.push({ at: now, point: { ...mouse } });
    if (history.length > 16) history.shift();
  }
  const window = 2 * Math.max(40, Math.min(250, rtt));
  const variation = Math.max(0, Math.min(25, jitter / 2));
  const selected: GamePoint[] = [];
  let previous = now;
  for (let index = history.length - 1; index >= 0; index--) {
    const sample = history[index]!;
    if (sample.at < now - window) break;
    const gap = 50 + (selected.length % 2 === 0 ? variation : -variation);
    if (sample.at <= now && previous - sample.at >= gap) {
      selected.push({ ...sample.point });
      previous = sample.at;
    }
  }
  return selected;
}

// All coordinates are logical cells. The view supplies the pixel transform.
export function drawEscape(
  context: CanvasRenderingContext2D,
  init: GameInit,
  state: GameSnapshot,
  mouse: GamePoint = state.mouse,
  dust?: EscapePredictionFrame['dust'],
  scent: readonly GamePoint[] = [],
): void {
  context.fillStyle = '#142019';
  context.fillRect(0, 0, 48, 18);
  for (let y = 0; y < 18; y++) {
    for (let x = 0; x < 48; x++) {
      if (init.map.rows[y]![x] !== '#') continue;
      context.fillStyle = '#48604a';
      context.fillRect(x, y, 1, 1);
      context.fillStyle = '#263c2c';
      context.fillRect(x + 0.08, y + 0.12, 0.84, 0.8);
    }
  }
  const circle = (point: GamePoint, radius: number, color: string): void => {
    context.fillStyle = color;
    context.beginPath();
    context.arc(point.x, point.y, radius, 0, Math.PI * 2);
    context.fill();
  };
  context.strokeStyle = state.exitOpen ? '#d8ff62' : '#bf7871';
  context.lineWidth = 0.12;
  context.beginPath();
  context.arc(init.exit.x, init.exit.y, 0.43, 0, Math.PI * 2);
  context.stroke();
  if (!state.exitOpen) {
    context.beginPath();
    context.moveTo(init.exit.x - 0.3, init.exit.y + 0.3);
    context.lineTo(init.exit.x + 0.3, init.exit.y - 0.3);
    context.stroke();
  }
  for (const [index, cheese] of init.cheeses.entries()) {
    if (state.collectedMask & (1 << index)) continue;
    context.fillStyle = '#ffe181';
    context.beginPath();
    context.moveTo(cheese.x - 0.4, cheese.y + 0.35);
    context.lineTo(cheese.x - 0.3, cheese.y - 0.4);
    context.lineTo(cheese.x + 0.45, cheese.y + 0.35);
    context.closePath();
    context.fill();
    circle({ x: cheese.x - 0.15, y: cheese.y + 0.03 }, 0.08, '#bc8934');
  }
  for (const point of scent) circle(point, 0.1, '#a4c878');
  if (dust !== undefined) {
    context.save();
    context.globalAlpha = 1 - dust.progress;
    for (let index = 0; index < 6; index++) {
      const angle = (index * Math.PI) / 3;
      const radius = 0.5 + dust.progress * 0.6;
      circle(
        {
          x: dust.point.x + Math.cos(angle) * radius,
          y: dust.point.y + Math.sin(angle) * radius,
        },
        0.13 + dust.progress * 0.05,
        '#e9d4a7',
      );
    }
    context.restore();
  }
  circle({ x: mouse.x - 0.25, y: mouse.y - 0.3 }, 0.21, '#f2bbcb');
  circle({ x: mouse.x + 0.25, y: mouse.y - 0.3 }, 0.21, '#f2bbcb');
  circle(mouse, 0.36, '#e7eaf1');
  circle({ x: mouse.x, y: mouse.y + 0.12 }, 0.08, '#142019');
  context.fillStyle = '#ffab70';
  context.beginPath();
  context.moveTo(state.cat.x - 0.36, state.cat.y);
  context.lineTo(state.cat.x - 0.4, state.cat.y - 0.6);
  context.lineTo(state.cat.x, state.cat.y - 0.25);
  context.lineTo(state.cat.x + 0.4, state.cat.y - 0.6);
  context.lineTo(state.cat.x + 0.36, state.cat.y);
  context.fill();
  circle(state.cat, 0.42, '#ffab70');
  circle({ x: state.cat.x - 0.16, y: state.cat.y + 0.04 }, 0.065, '#142019');
  circle({ x: state.cat.x + 0.16, y: state.cat.y + 0.04 }, 0.065, '#142019');
}
