import { describe, expect, it, vi } from 'vitest';
import {
  CHUNK,
  ResourceError,
  ResourceProtocolError,
  ResourceWire,
} from './wire.ts';

function packet(
  kind: number,
  data = new Uint8Array(0),
  length = data.length + 1,
) {
  const frame = new Uint8Array(data.length + 5);
  new DataView(frame.buffer).setUint32(0, length);
  frame[4] = kind;
  frame.set(data, 5);
  return frame;
}
function wireFrom(chunks: (Uint8Array | null)[]) {
  return new ResourceWire({
    read: async () => chunks.shift() ?? null,
    write: vi.fn(),
    close: vi.fn(),
  });
}
describe('resource framing', () => {
  it('reassembles fragmented JSON and consumes multiple frames in a single read', async () => {
    const bytes = packet(1, new TextEncoder().encode('{"type":"ready"}'));
    const second = packet(3);
    const wire = wireFrom([
      bytes.slice(0, 2),
      bytes.slice(2, 7),
      new Uint8Array([...bytes.slice(7), ...second]),
    ]);
    expect(await wire.object()).toEqual({ type: 'ready' });
    expect((await wire.read()).kind).toBe(3);
    await expect(wire.read()).rejects.toThrow('Connection lost');
  });
  it.each([
    packet(0),
    packet(1, undefined, 0),
    packet(1, undefined, 65537),
    packet(2, undefined, CHUNK + 2),
    packet(3, new Uint8Array(1)),
  ])(
    'rejects invalid frame headers before allocating payload',
    async (frame) => {
      await expect(wireFrom([frame]).read()).rejects.toBeInstanceOf(
        ResourceProtocolError,
      );
    },
  );
  it('rejects binary-as-control, malformed objects and oversized transport reads', async () => {
    await expect(wireFrom([packet(2)]).object()).rejects.toBeInstanceOf(
      ResourceProtocolError,
    );
    await expect(
      wireFrom([packet(1, new TextEncoder().encode('[]'))]).object(),
    ).rejects.toBeInstanceOf(ResourceProtocolError);
    await expect(wireFrom([new Uint8Array(65541)]).read()).rejects.toThrow(
      'Connection lost',
    );
    await expect(
      wireFrom([
        packet(
          1,
          new TextEncoder().encode('{"type":"error","code":"SESSION_BUSY"}'),
        ),
      ]).object(),
    ).rejects.toMatchObject({ code: 'SESSION_BUSY' });
    expect(new ResourceError('private-url-secret').message).toBe(
      'RESOURCE FAILED',
    );
  });
  it('bounds outbound data and prevents concurrent writes', async () => {
    let finish!: () => void;
    const bytes: Uint8Array[] = [];
    const wire = new ResourceWire({
      read: vi.fn(),
      close: vi.fn(),
      write: (data) => {
        bytes.push(data);
        return new Promise<void>((r) => {
          finish = r;
        });
      },
    });
    const sending = wire.json({ type: 'hello' });
    await expect(wire.write(2, new Uint8Array(1))).rejects.toThrow(
      'backpressure',
    );
    finish();
    await sending;
    expect(await wireFrom(bytes).object()).toEqual({ type: 'hello' });
    await expect(wire.write(2, new Uint8Array(CHUNK + 1))).rejects.toThrow();
    await expect(wire.write(1, new Uint8Array(65536))).rejects.toThrow();
    await expect(wire.write(3, new Uint8Array(1))).rejects.toThrow();
    await wire.close();
  });
});
