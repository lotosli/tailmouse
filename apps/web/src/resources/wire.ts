import type { ByteStream } from '../transport/tailcat/adapter.ts';
import { strictObject } from '../protocol/values.ts';
export const CHUNK = 32768;
export interface ResourceFrame {
  kind: 1 | 2 | 3;
  data: Uint8Array;
}
export class ResourceWire {
  readonly stream: ByteStream;
  #buffer = new Uint8Array(0);
  #offset = 0;
  #writing = false;
  constructor(stream: ByteStream) {
    this.stream = stream;
  }
  async #exact(length: number): Promise<Uint8Array> {
    const result = new Uint8Array(length);
    let offset = 0;
    while (offset < length) {
      if (this.#offset === this.#buffer.length) {
        const next = await this.stream.read();
        if (next === null || next.length === 0 || next.length > 65540)
          throw new Error('Connection lost.');
        this.#buffer = new Uint8Array(next);
        this.#offset = 0;
      }
      const n = Math.min(length - offset, this.#buffer.length - this.#offset);
      result.set(this.#buffer.subarray(this.#offset, this.#offset + n), offset);
      this.#offset += n;
      offset += n;
    }
    return result;
  }
  async acceptPreface(): Promise<void> {
    const data = await this.#exact(9);
    if (new TextDecoder().decode(data) !== 'TMOUSE/2\n')
      throw new ResourceProtocolError('Invalid resource preface.');
  }
  async read(): Promise<ResourceFrame> {
    const header = await this.#exact(5);
    const length = new DataView(header.buffer).getUint32(0);
    const kind = header[4];
    if (
      length < 1 ||
      length > 65536 ||
      (kind !== 1 && kind !== 2 && kind !== 3) ||
      (kind === 2 && length > CHUNK + 1) ||
      (kind === 3 && length !== 1)
    )
      throw new ResourceProtocolError('Invalid resource frame.');
    return { kind, data: await this.#exact(length - 1) };
  }
  async object(): Promise<Record<string, unknown>> {
    const frame = await this.read();
    if (frame.kind !== 1)
      throw new ResourceProtocolError('Unexpected resource data.');
    let value: Record<string, unknown>;
    try {
      value = strictObject(frame.data);
    } catch {
      throw new ResourceProtocolError('Invalid resource message.');
    }
    if (value.type === 'error')
      throw new ResourceError(
        typeof value.code === 'string' ? value.code : 'BAD_FRAME',
      );
    return value;
  }
  async write(
    kind: 1 | 2 | 3,
    data: Uint8Array = new Uint8Array(0),
  ): Promise<void> {
    if (
      this.#writing ||
      data.length + 1 > 65536 ||
      (kind === 2 && data.length > CHUNK) ||
      (kind === 3 && data.length !== 0)
    )
      throw new Error('Resource backpressure.');
    this.#writing = true;
    try {
      const frame = new Uint8Array(data.length + 5);
      new DataView(frame.buffer).setUint32(0, data.length + 1);
      frame[4] = kind;
      frame.set(data, 5);
      await this.stream.write(frame);
    } finally {
      this.#writing = false;
    }
  }
  json(value: unknown): Promise<void> {
    return this.write(1, new TextEncoder().encode(JSON.stringify(value)));
  }
  close(): Promise<void> {
    return this.stream.close();
  }
}
const safeCodes = new Set([
  'UNAUTHORIZED',
  'SESSION_BUSY',
  'EXPIRED',
  'READONLY',
  'BAD_FRAME',
  'WEB_POLICY',
  'WEB_TLS',
  'WEB_UNAVAILABLE',
  'WEB_SOCKET_FAILED',
  'WEB_UNSUPPORTED_SECURITY_POLICY',
  'WEB_UNSUPPORTED_ENCODING',
  'FILE_UNAVAILABLE',
  'TRANSFER_LIMIT',
  'UPLOAD_CLOSED',
  'UPLOAD_NAME_INVALID',
  'UPLOAD_LIMIT',
  'UPLOAD_HASH_MISMATCH',
  'UPLOAD_STORAGE',
]);
export class ResourceError extends Error {
  readonly code: string;
  constructor(code: string) {
    const safe = safeCodes.has(code) ? code : 'RESOURCE_FAILED';
    super(safe.replaceAll('_', ' '));
    this.code = safe;
  }
}

export class ResourceProtocolError extends Error {}
