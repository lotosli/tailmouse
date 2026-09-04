import { describe, expect, it } from 'vitest';
import { updateEscapeScent, type EscapeScentSample } from './escape-canvas.ts';

describe('bounded visual scent history', () => {
  it('lengthens the same recorded path with RTT and clamps both bounds', () => {
    const history: EscapeScentSample[] = [];
    for (let now = 0; now <= 1200; now += 40) {
      updateEscapeScent(history, { x: now / 200, y: 3 }, now, 250, 0, true);
      expect(history.length).toBeLessThanOrEqual(16);
    }
    const read = (rtt: number, jitter = 0) =>
      updateEscapeScent(history, { x: 6, y: 3 }, 1200, rtt, jitter, true);
    const short = read(40);
    const long = read(250);
    expect(short).toEqual([{ x: 5.6, y: 3 }]);
    expect(long).toEqual(
      [5.6, 5.2, 4.8, 4.4, 4, 3.6].map((x) => ({ x, y: 3 })),
    );
    expect(read(0)).toEqual(short);
    expect(read(10_000)).toEqual(long);
    expect(history[0]?.at).toBe(600);
    const jittered = read(250, 50);
    expect(jittered.slice(0, 4)).toEqual(
      [5.6, 5.4, 5, 4.8].map((x) => ({ x, y: 3 })),
    );
    expect(read(250, 1000)).toEqual(jittered);
    expect(read(250, -1)).toEqual(long);
    expect(
      jittered.every((point) =>
        history.some(
          (sample) => sample.point.x === point.x && sample.point.y === point.y,
        ),
      ),
    ).toBe(true);
    Object.assign(long[0]!, { x: -100 });
    expect(read(250)[0]?.x).toBe(5.6);
  });

  it('caps sampling at 30 Hz and clears inactive, discontinuous and suspended paths', () => {
    const history: EscapeScentSample[] = [];
    for (let now = 0; now <= 100; now++) {
      updateEscapeScent(history, { x: now / 200, y: 3 }, now, 250, 0, true);
    }
    expect(history.map((sample) => sample.at)).toEqual([0, 34, 68]);
    expect(
      updateEscapeScent(history, { x: 1, y: 3 }, 200, 250, 0, true),
    ).toEqual([]);
    expect(history.map((sample) => sample.at)).toEqual([200]);
    updateEscapeScent(history, { x: 3, y: 3 }, 234, 250, 0, true);
    expect(history.map((sample) => sample.at)).toEqual([234]);
    updateEscapeScent(history, { x: 3, y: 3 }, 233, 250, 0, true);
    expect(history.map((sample) => sample.at)).toEqual([233]);
    expect(
      updateEscapeScent(history, { x: 3, y: 3 }, 250, 250, 0, false),
    ).toEqual([]);
    expect(history).toEqual([]);
    expect(
      updateEscapeScent(history, { x: 3, y: 3 }, 300, 250, 0, true),
    ).toEqual([]);
  });
});
