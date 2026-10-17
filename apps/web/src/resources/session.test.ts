import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ResourceSession,
  parseReceipt,
  type UploadReceipt,
} from './session.ts';
import { ResourceTransport } from '../transport/tailcat/resource.ts';
import type { ByteStream } from '../transport/tailcat/adapter.ts';
import type { Recovery } from './invitation.ts';

vi.mock('../transport/tailcat/resource.ts', { spy: true });

class HostStream implements ByteStream {
  data: Uint8Array[] = [];
  writes: Uint8Array[] = [];
  waiting: ((data: Uint8Array | null) => void) | undefined;
  closed = false;
  onWrite: ((data: Uint8Array) => void) | undefined;
  push(value: unknown) {
    const data = new TextEncoder().encode(JSON.stringify(value));
    const frame = new Uint8Array(data.length + 5);
    new DataView(frame.buffer).setUint32(0, data.length + 1);
    frame[4] = 1;
    frame.set(data, 5);
    if (this.waiting) {
      const receive = this.waiting;
      this.waiting = undefined;
      receive(frame);
    } else this.data.push(frame);
  }
  async read(): Promise<Uint8Array | null> {
    if (this.data.length) return this.data.shift()!;
    if (this.closed) return null;
    return new Promise((r) => {
      this.waiting = r;
    });
  }
  async write(data: Uint8Array) {
    this.writes.push(data);
    this.onWrite?.(data);
  }
  async close() {
    this.closed = true;
    this.waiting?.(null);
    this.waiting = undefined;
  }
}
const receipt: UploadReceipt = {
  type: 'upload.completed',
  upload: 'b'.repeat(32),
  name: 'saved-2.txt',
  path: 'uploads/saved-2.txt',
  size: 5,
  sha256: 'c'.repeat(64),
};
const sessions: ResourceSession[] = [];
const streams: HostStream[] = [];
let dialed: HostStream[];
function host() {
  const stream = new HostStream();
  streams.push(stream);
  return stream;
}
function makeSession() {
  const values = new Map<string, string>();
  const storage = {
    getItem: (k: string) => values.get(k) ?? null,
    setItem: (k: string, v: string) => {
      values.set(k, v);
    },
    removeItem: (k: string) => {
      values.delete(k);
    },
  } as Storage;
  const recovery: Recovery = {
    invitation: {
      v: 1,
      frontend_major: 1,
      session: 'a'.repeat(32),
      token: 'A'.repeat(43),
      address: 'synthetic-address',
    },
    key: '',
    member: '',
    grant: '',
    expires: 0,
  };
  const session = new ResourceSession(recovery, storage);
  sessions.push(session);
  return { session, storage, recovery };
}
const welcome = () => ({
  type: 'welcome',
  version: 2,
  member: 'd'.repeat(32),
  grant: 'A'.repeat(43),
  expires: Date.now() + 60000,
  manifest: {
    title: 'Synthetic workspace',
    resources: [{ id: 'receive', state: 'READY' }],
    contentOrigin: '',
    transport: 'test',
  },
});
beforeEach(() => {
  dialed = [];
  vi.spyOn(ResourceTransport.prototype, 'start').mockImplementation(
    async (_address, _key, loaded) => {
      loaded?.();
      return 'synthetic-key';
    },
  );
  vi.spyOn(ResourceTransport.prototype, 'dial').mockImplementation(async () => {
    const next = dialed.shift();
    if (!next) throw new Error('No synthetic stream');
    return next;
  });
  vi.spyOn(ResourceTransport.prototype, 'call').mockImplementation(
    async (op) => (op === 'hash.finish' ? receipt.sha256 : 1),
  );
  vi.spyOn(ResourceTransport.prototype, 'close').mockImplementation(
    () => undefined,
  );
  // No Worker is created in the session unit suite; transport has its own tests.
  vi.stubGlobal(
    'Worker',
    class {
      onmessage = null;
      onerror = null;
      terminate() {}
    },
  );
});
afterEach(async () => {
  for (const session of sessions.splice(0)) session.close();
  for (const stream of streams.splice(0)) await stream.close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('resource session guidance follows host authority', () => {
  it('shows loading, connection and approval in order, then stores only a validated grant', async () => {
    const stream = host();
    stream.push({ type: 'waiting' });
    dialed.push(stream);
    const { session, storage, recovery } = makeSession();
    const views: string[] = [];
    const unsubscribe = session.subscribe((view) => views.push(view.message));
    const connecting = session.connect();
    await vi.waitFor(() => expect(session.view.status).toBe('waiting'));
    stream.push(welcome());
    await connecting;
    expect(views).toContain('Loading the secure connection runtime…');
    expect(views).toContain('Connecting to the host…');
    expect(session.view.status).toBe('active');
    expect(recovery.member).toBe('d'.repeat(32));
    expect(storage.getItem('tailmouse.resource.v1')).toContain('synthetic-key');
    stream.push({
      type: 'state',
      controller: true,
      expiring: true,
      resources: [{ id: 'receive', state: 'READY' }],
    });
    await vi.waitFor(() => expect(session.view.expiring).toBe(true));
    stream.push({ type: 'ping', seq: 1 });
    await vi.waitFor(() =>
      expect(
        stream.writes.some((b) => new TextDecoder().decode(b).includes('pong')),
      ).toBe(true),
    );
    await session.leave();
    unsubscribe();
    expect(session.view.message).toContain('host’s session continues');
    expect(storage.getItem('tailmouse.resource.v1')).toBeNull();
    expect(recovery.invitation.token).toBe('');
  });
  it.each([
    ['SESSION_BUSY', 'disconnected', 'visitor slots'],
    ['EXPIRED', 'closed', 'new session'],
    ['UNAUTHORIZED', 'closed', 'new link'],
    ['BAD_FRAME', 'closed', 'matching build'],
  ])(
    'turns %s into an actionable state without retrying indefinitely',
    async (code, status, message) => {
      const stream = host();
      stream.push({ type: 'error', code });
      dialed.push(stream);
      const { session } = makeSession();
      await session.connect();
      expect(session.view.status).toBe(status);
      expect(session.view.message).toContain(message);
    },
  );
  it('ends the retry window and allows an explicit retry after a network failure', async () => {
    vi.useFakeTimers();
    const { session } = makeSession();
    const connecting = session.connect();
    await vi.advanceTimersByTimeAsync(61_000);
    await connecting;
    expect(session.view.status).toBe('disconnected');
    expect(session.view.message).toContain('60 seconds');
    const stream = host();
    stream.push(welcome());
    dialed.push(stream);
    await session.connect();
    expect(session.view.status).toBe('active');
  });
  it('fails closed on an incompatible manifest and never exposes its arbitrary text', async () => {
    const stream = host();
    stream.push({ ...welcome(), member: 'bad', secret: 'private-project' });
    dialed.push(stream);
    const { session } = makeSession();
    await session.connect();
    expect(session.view.status).toBe('closed');
    expect(session.view.message).not.toContain('private-project');
  });
  it('requires a host receipt after transfer and verification, preserving the actual saved name', async () => {
    const control = host();
    control.push(welcome());
    const upload = host();
    upload.onWrite = (bytes) => {
      if (bytes[4] === 2) {
        upload.push({ type: 'upload.progress', received: 5 });
        return;
      }
      if (bytes[4] !== 1) return;
      const message = JSON.parse(
        new TextDecoder().decode(bytes.subarray(5)),
      ) as { type: string };
      if (message.type === 'upload.begin')
        upload.push({ type: 'upload.ready', upload: receipt.upload });
      if (message.type === 'upload.finish') upload.push(receipt);
    };
    dialed.push(control, upload);
    const { session } = makeSession();
    await session.connect();
    const progress: string[] = [];
    expect(
      await session.upload(
        new File(['hello'], 'original.txt'),
        new AbortController().signal,
        (state) => progress.push(state),
      ),
    ).toEqual(receipt);
    expect(progress).toEqual([
      'uploading',
      'uploading',
      'verifying',
      'completed',
    ]);
    expect(upload.closed).toBe(true);
  });
  it('cancels a pending upload without reporting a completed file', async () => {
    const control = host();
    control.push(welcome());
    const upload = host();
    dialed.push(control, upload);
    const { session } = makeSession();
    await session.connect();
    const abort = new AbortController();
    abort.abort();
    const progress = vi.fn();
    await expect(
      session.upload(new File(['hello'], 'test.txt'), abort.signal, progress),
    ).rejects.toThrow('canceled');
    expect(progress).not.toHaveBeenCalled();
    expect(upload.closed).toBe(true);
  });
});
describe('confirmed upload receipt', () => {
  it('accepts the actual host result', () =>
    expect(parseReceipt({ ...receipt })).toEqual(receipt));
  it.each([
    { name: '../x' },
    { name: 'x\n' },
    { path: '/etc/file' },
    { path: 'uploads/../file' },
    { path: 'uploads\\file' },
    { path: 'x\u007f' },
    { sha256: 'bad' },
    { size: -1 },
    { size: 1.1 },
    { upload: 'bad' },
    { type: 'upload.progress' },
  ])('rejects unsafe or incomplete receipt fields', (change) => {
    expect(() => parseReceipt({ ...receipt, ...change })).toThrow(
      'Invalid upload receipt',
    );
  });
});
