// Hermetic byte streams used by the transfer protocol tests.
import type { ByteStream } from '../transport/tailcat/adapter.ts';
export function streamPair(): [ByteStream, ByteStream] {
  const queue: Uint8Array[][] = [[], []];
  const wait: (((value: Uint8Array | null) => void) | undefined)[] = [];
  let closed = false;
  const endpoint = (index: number): ByteStream => ({
    async read() {
      const value = queue[index]!.shift();
      if (value !== undefined) return value;
      if (closed) return null;
      return new Promise((resolve) => {
        wait[index] = resolve;
      });
    },
    async write(data) {
      if (closed) throw new Error('Stream closed.');
      const peer = 1 - index;
      const next = wait[peer];
      if (next !== undefined) {
        wait[peer] = undefined;
        next(new Uint8Array(data));
      } else queue[peer]!.push(new Uint8Array(data));
    },
    async close() {
      closed = true;
      for (let i = 0; i < 2; i++) {
        wait[i]?.(null);
        wait[i] = undefined;
      }
    },
  });
  return [endpoint(0), endpoint(1)];
}
