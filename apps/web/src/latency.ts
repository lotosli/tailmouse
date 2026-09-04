import { Message, type Frame } from './protocol/frame.ts';

export interface LatencySnapshot {
  readonly samples: number;
  readonly rttMs: number;
  readonly jitterMs: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
}

export class Latency {
  #sequence = 0n;
  #accepted = 0n;
  #pending = new Map<bigint, { stamp: bigint; sent: number }>();
  #window: number[] = [];
  #samples = 0;
  #rtt = 0;
  #jitter = 0;
  #previous = 0;

  ping(now: number): Frame {
    this.#sequence = BigInt.asUintN(64, this.#sequence + 1n);
    if (this.#sequence === 0n) {
      this.#sequence = 1n;
      this.#accepted = 0n;
      this.#pending.clear();
    }
    const stamp = BigInt(Math.max(0, Math.round(now * 1_000_000)));
    if (this.#pending.size === 60)
      this.#pending.delete(this.#pending.keys().next().value!);
    this.#pending.set(this.#sequence, { stamp, sent: now });
    const payload = new Uint8Array(16);
    const view = new DataView(payload.buffer);
    view.setBigUint64(0, this.#sequence);
    view.setBigUint64(8, stamp);
    return { type: Message.PING, payload };
  }

  pong(payload: Uint8Array, now: number): boolean {
    if (payload.length !== 16 || !Number.isFinite(now)) return false;
    const view = new DataView(
      payload.buffer,
      payload.byteOffset,
      payload.byteLength,
    );
    const sequence = view.getBigUint64(0);
    const pending = this.#pending.get(sequence);
    if (
      pending === undefined ||
      sequence <= this.#accepted ||
      pending.stamp !== view.getBigUint64(8) ||
      now < pending.sent
    )
      return false;
    this.#pending.delete(sequence);
    this.#accepted = sequence;
    const sample = now - pending.sent;
    if (this.#samples === 0) this.#rtt = sample;
    else {
      this.#rtt += 0.2 * (sample - this.#rtt);
      this.#jitter += 0.2 * (Math.abs(sample - this.#previous) - this.#jitter);
    }
    this.#previous = sample;
    this.#window[this.#samples % 60] = sample;
    this.#samples++;
    return true;
  }

  inspect(): LatencySnapshot {
    const sorted = this.#window.toSorted((a, b) => a - b);
    return Object.freeze({
      samples: this.#samples,
      rttMs: this.#rtt,
      jitterMs: this.#jitter,
      p50Ms: sorted[Math.ceil(sorted.length * 0.5) - 1] ?? 0,
      p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1] ?? 0,
    });
  }
}
