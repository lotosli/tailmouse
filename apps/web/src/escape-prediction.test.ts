import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { EscapePrediction } from './escape-prediction.ts';
import {
  decodeGameInit,
  type GameInit,
  type GameSnapshot,
} from './protocol/game.ts';

const corpus = JSON.parse(
  readFileSync(
    new URL('../../../protocol/fixtures/v1/frames.json', import.meta.url),
    'utf8',
  ),
) as {
  cases: Array<{ id: string; wire: { hex: string } }>;
};
const initial = decodeGameInit(
  Uint8Array.from(
    Buffer.from(
      corpus.cases.find((entry) => entry.id === 'game-init-canonical')!.wire
        .hex,
      'hex',
    ),
  ).slice(6),
);
const snapshot = (patch: Partial<GameSnapshot> = {}): GameSnapshot =>
  Object.freeze({
    sequence: 1,
    acceptedInputSequence: 0,
    elapsedMS: 1000n,
    remainingMS: 44000,
    mouse: initial.mouse,
    cat: initial.cat,
    dashCooldownMS: 0,
    collectedMask: 0,
    phase: 1,
    exitOpen: false,
    ...patch,
  });
function start(init: GameInit = initial) {
  const predictor = new EscapePrediction(init);
  predictor.receive(snapshot(), 0);
  return predictor;
}

describe('bounded visual mouse prediction', () => {
  it('moves on the next render without a write or round trip and preserves analog magnitude', () => {
    const predictor = start();
    predictor.move({ x: 0.5, y: 0 }, 0);
    expect(predictor.render(1000 / 60).mouse.x).toBeCloseTo(
      initial.mouse.x + 0.05,
    );
    predictor.move({ x: 0, y: 0 }, 50);
    expect(predictor.render(100).mouse.x).toBeCloseTo(initial.mouse.x + 0.15);
    expect(predictor.render(90).mouse.x).toBeCloseTo(initial.mouse.x + 0.15);
    expect(predictor.render(100).mouse.y).toBe(initial.mouse.y);
  });

  it.each([
    [0, 100],
    [0.249999, 100],
    [0.25, 200],
    [0.5, 200],
    [1, 200],
  ])(
    'reconciles a %s-cell error within %i ms with exact threshold ownership',
    (error, duration) => {
      const predictor = start();
      const target = { x: initial.mouse.x + error, y: initial.mouse.y };
      predictor.receive(snapshot({ sequence: 2, mouse: target }), 10);
      expect(predictor.render(10)).toEqual({
        mouse: initial.mouse,
        dust: undefined,
      });
      expect(predictor.render(10 + duration / 2).mouse.x).toBeCloseTo(
        initial.mouse.x + error / 2,
      );
      expect(predictor.render(10 + duration).mouse).toEqual(target);
      expect(predictor.render(10 + duration + 1).mouse).toEqual(target);
    },
  );

  it('does not postpone an in-progress correction when 10 Hz snapshots keep arriving', () => {
    const predictor = start();
    const target = { x: initial.mouse.x + 0.8, y: initial.mouse.y };
    predictor.receive(snapshot({ sequence: 2, mouse: target }), 0);
    predictor.receive(snapshot({ sequence: 3, mouse: target }), 100);
    expect(predictor.render(100).mouse.x).toBeCloseTo(initial.mouse.x + 0.4);
    expect(predictor.render(200).mouse).toEqual(target);
  });

  it('continues current-intent movement while blending the host correction', () => {
    const predictor = start();
    predictor.move({ x: 1, y: 0 }, 0);
    predictor.render(50);
    const target = { x: initial.mouse.x + 0.1, y: initial.mouse.y };
    predictor.receive(snapshot({ sequence: 2, mouse: target }), 50);
    expect(predictor.render(100).mouse.x).toBeCloseTo(initial.mouse.x + 0.5);
    expect(predictor.render(150).mouse.x).toBeCloseTo(initial.mouse.x + 0.7);
  });

  it('snaps errors above one cell immediately and keeps only one bounded dust effect', () => {
    const predictor = start();
    const target = { x: initial.mouse.x + 1.000001, y: initial.mouse.y };
    predictor.receive(snapshot({ sequence: 2, mouse: target }), 10);
    expect(predictor.render(10)).toEqual({
      mouse: target,
      dust: { point: target, progress: 0 },
    });
    expect(predictor.render(135).dust?.progress).toBe(0.5);
    expect(predictor.render(260).dust).toBeUndefined();
    predictor.receive(snapshot({ sequence: 3 }), 270);
    expect(predictor.render(270).dust?.point).toEqual(initial.mouse);
    // Identical and older snapshots cannot move the mouse or restart dust.
    predictor.receive(snapshot({ sequence: 3, mouse: target }), 280);
    predictor.receive(snapshot({ sequence: 1, mouse: target }), 290);
    expect(predictor.render(520)).toEqual({
      mouse: initial.mouse,
      dust: undefined,
    });
  });

  it('starts from the first host position without correction or dust, including reconnects', () => {
    const predictor = new EscapePrediction(initial);
    const target = { x: 20.5, y: 10.5 };
    predictor.move({ x: 1, y: 0 }, 0);
    expect(predictor.render(50).mouse).toEqual(initial.mouse);
    predictor.receive(snapshot({ mouse: target }), 50);
    expect(predictor.render(50)).toEqual({ mouse: target, dust: undefined });
  });

  it('does not move during countdown or pause and never manufactures a game result', () => {
    const predictor = new EscapePrediction(initial);
    predictor.receive(snapshot({ phase: 0 }), 0);
    predictor.move({ x: 1, y: 0 }, 0);
    expect(predictor.render(100).mouse).toEqual(initial.mouse);
    const authoritative = snapshot({
      sequence: 2,
      phase: 2,
      collectedMask: 3,
      exitOpen: true,
    });
    const before = JSON.stringify(authoritative, (_, value: unknown) =>
      typeof value === 'bigint' ? String(value) : value,
    );
    predictor.receive(authoritative, 100);
    expect(predictor.render(200).mouse).toEqual(initial.mouse);
    expect(Object.keys(predictor.render(200))).toEqual(['mouse', 'dust']);
    expect(
      JSON.stringify(authoritative, (_, value: unknown) =>
        typeof value === 'bigint' ? String(value) : value,
      ),
    ).toBe(before);
    predictor.receive(snapshot({ sequence: 3 }), 200);
    expect(predictor.render(250).mouse.x).toBeCloseTo(initial.mouse.x + 0.3);
  });

  it('discards suspended time and stops speculation at the fresh-snapshot horizon', () => {
    const predictor = start();
    predictor.move({ x: 1, y: 0 }, 0);
    predictor.render(50);
    expect(predictor.render(5000).mouse.x).toBeCloseTo(initial.mouse.x + 0.3);
    expect(predictor.render(5010).mouse.x).toBeCloseTo(initial.mouse.x + 0.3);
    predictor.receive(
      snapshot({ sequence: 2, mouse: { x: 5.5, y: 3.5 } }),
      5010,
    );
    for (let now = 5060; now <= 5460; now += 100) predictor.render(now);
    expect(predictor.render(5530).mouse.x).toBeCloseTo(8.5);
    expect(predictor.render(5600).mouse.x).toBeCloseTo(8.5);
  });

  it('uses only host-accepted dash timing and accounts for a partial dash frame', () => {
    const predictor = start();
    predictor.receive(snapshot({ sequence: 2, dashCooldownMS: 5000 }), 0);
    predictor.move({ x: 1, y: 0 }, 0);
    for (const time of [100, 200, 300, 400]) predictor.render(time);
    expect(predictor.render(400).mouse.x).toBeCloseTo(
      initial.mouse.x + 6 * (0.35 * 2.2 + 0.05),
    );
  });

  it.each([
    [
      { x: 1.1, y: 2.5 },
      { x: -1, y: 0 },
      { x: 1.000001, y: 2.5 },
    ],
    [
      { x: 46.9, y: 2.5 },
      { x: 1, y: 0 },
      { x: 46.999999, y: 2.5 },
    ],
    [
      { x: 2.5, y: 1.1 },
      { x: 0, y: -1 },
      { x: 2.5, y: 1.000001 },
    ],
    [
      { x: 2.5, y: 16.9 },
      { x: 0, y: 1 },
      { x: 2.5, y: 16.999999 },
    ],
  ])(
    'clips each outer wall without tunneling',
    (mouse, direction, expected) => {
      const predictor = new EscapePrediction(initial);
      predictor.receive(snapshot({ mouse, dashCooldownMS: 5000 }), 0);
      predictor.move(direction, 0);
      expect(predictor.render(100).mouse).toEqual(expected);
    },
  );

  it('slides along internal walls and clips correction paths at wall corners', () => {
    const rows = initial.map.rows.map((row, index) =>
      index > 0 && index < 17 ? `${row.slice(0, 5)}#${row.slice(6)}` : row,
    );
    const predictor = new EscapePrediction({
      ...initial,
      map: { ...initial.map, rows },
    });
    predictor.receive(snapshot({ mouse: { x: 4.9, y: 3.5 } }), 0);
    predictor.move({ x: Math.SQRT1_2, y: Math.SQRT1_2 }, 0);
    const moved = predictor.render(100).mouse;
    expect(moved.x).toBe(4.999999);
    expect(moved.y).toBeCloseTo(3.5 + 0.6 * Math.SQRT1_2);
    // A diagonal correction cannot put the visual mouse inside the corner.
    const cornerRows = initial.map.rows.map((row, index) =>
      index === 4 ? `${row.slice(0, 4)}#${row.slice(5)}` : row,
    );
    const corner = new EscapePrediction({
      ...initial,
      map: { ...initial.map, rows: cornerRows },
    });
    corner.receive(snapshot({ mouse: { x: 3.9, y: 4.1 } }), 0);
    corner.receive(snapshot({ sequence: 2, mouse: { x: 4.1, y: 3.9 } }), 0);
    const visual = corner.render(100).mouse;
    expect(cornerRows[Math.floor(visual.y)]![Math.floor(visual.x)]).toBe('.');
  });

  it.each([NaN, Infinity, -1])(
    'fails fast on invalid local clock %s',
    (now) => {
      const predictor = start();
      expect(() => predictor.render(now)).toThrow('Invalid prediction clock');
      expect(predictor.render(0).mouse).toEqual(initial.mouse);
    },
  );
});
