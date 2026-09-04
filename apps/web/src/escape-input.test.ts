import { describe, expect, it } from 'vitest';
import { joystickVector } from './escape-input.ts';

describe('joystick magnitude', () => {
  it('uses an exact dead zone, proportional magnitude and a bounded unit circle', () => {
    expect(joystickVector(8, 0, 100)).toEqual({ x: 0, y: 0 });
    expect(joystickVector(0, -50, 100)).toEqual({ x: 0, y: -0.5 });
    expect(joystickVector(60, -80, 100)).toEqual({ x: 0.6, y: -0.8 });
    expect(joystickVector(600, -800, 100)).toEqual({ x: 0.6, y: -0.8 });
    expect(joystickVector(8.01, 0, 100).x).toBeGreaterThan(0.08);
  });
  it('never emits non-finite intent for invalid screen geometry', () => {
    for (const args of [
      [NaN, 0, 100],
      [0, Infinity, 100],
      [1, 1, NaN],
      [1, 1, -1],
      [1, 1, 0],
    ]) {
      expect(joystickVector(args[0]!, args[1]!, args[2]!)).toEqual({
        x: 0,
        y: 0,
      });
    }
  });
});
