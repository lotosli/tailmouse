import { describe, expect, it } from 'vitest';
import { Latency } from './latency.ts';

describe('Application latency', () => {
  it('uses exactly the latest sixty samples and local monotonic elapsed time', () => {
    const latency = new Latency();
    expect(latency.inspect()).toEqual({
      samples: 0,
      rttMs: 0,
      jitterMs: 0,
      p50Ms: 0,
      p95Ms: 0,
    });
    for (let index = 1; index <= 100; index++) {
      const ping = latency.ping(index * 1000);
      const wire = new DataView(ping.payload.buffer);
      expect(wire.getBigUint64(0)).toBe(BigInt(index));
      expect(wire.getBigUint64(8)).toBe(BigInt(index) * 1_000_000_000n);
      expect(latency.pong(ping.payload, index * 1000 + index)).toBe(true);
      expect(latency.pong(ping.payload, index * 1000 + 999)).toBe(false);
    }
    const got = latency.inspect();
    expect(got).toMatchObject({ samples: 100, p50Ms: 70, p95Ms: 97 });
    expect(got.rttMs).toBeCloseTo(96);
    expect(got.jitterMs).toBeCloseTo(1);
  });

  it('ignores stale, unsolicited, altered, backwards-time and out-of-order pongs', () => {
    const latency = new Latency();
    const stale = latency.ping(0);
    for (let i = 0; i < 60; i++) latency.ping(0);
    expect(latency.pong(stale.payload, 1)).toBe(false);
    expect(latency.pong(new Uint8Array(), 1)).toBe(false);
    expect(latency.pong(new Uint8Array(16), 1)).toBe(false);
    const older = latency.ping(10);
    const newest = latency.ping(10);
    const changed = newest.payload.slice();
    changed[15] = changed[15]! ^ 1;
    expect(latency.pong(changed, 11)).toBe(false);
    expect(latency.pong(newest.payload, 9)).toBe(false);
    expect(latency.pong(newest.payload, NaN)).toBe(false);
    expect(latency.pong(newest.payload, 20)).toBe(true);
    expect(latency.pong(older.payload, 30)).toBe(false);
  });

  it('computes the specified RTT and absolute-difference jitter EWMAs', () => {
    const latency = new Latency();
    for (const delay of [100, 200, 50]) {
      const ping = latency.ping(1000);
      latency.pong(ping.payload, 1000 + delay);
    }
    expect(latency.inspect()).toEqual({
      samples: 3,
      rttMs: 106,
      jitterMs: 46,
      p50Ms: 100,
      p95Ms: 200,
    });
  });
});
