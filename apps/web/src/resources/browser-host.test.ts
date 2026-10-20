import { createHash, type Hash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { BrowserHost } from './browser-host.ts';
import { ResourceWire } from './wire.ts';
import { parseResourceInvitation } from './invitation.ts';
import {
  downloadFile,
  exchangeText,
  listFiles,
  validFilePath,
  validText,
  parseFileList,
  chooseDownload,
  MEMORY_DOWNLOAD_LIMIT,
} from './transfers.ts';
import type { ResourceSession } from './session.ts';
import type { ByteStream } from '../transport/tailcat/adapter.ts';
import { streamPair } from './transfer-fixture.ts';

const hosts: BrowserHost[] = [];
afterEach(() => {
  for (const host of hosts) host.close();
  hosts.length = 0;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
class Transport {
  acceptor: ((value: { stream: ByteStream; peer: string }) => void) | undefined;
  rejected: ((error: Error) => void) | undefined;
  queue: { stream: ByteStream; peer: string }[] = [];
  hashes = new Map<number, Hash>();
  next = 0;
  streams: ByteStream[] = [];
  closed = false;
  listen = vi.fn(async () => 'synthetic-address');
  async accept(): Promise<{ stream: ByteStream; peer: string }> {
    const next = this.queue.shift();
    if (next !== undefined) return next;
    return new Promise((resolve, reject) => {
      this.acceptor = resolve;
      this.rejected = reject;
    });
  }
  connect(peer = 'nodekey:' + 'a'.repeat(64)): ResourceWire {
    const [client, server] = streamPair();
    this.streams.push(client, server);
    const value = { stream: server, peer };
    if (this.acceptor !== undefined) {
      const resolve = this.acceptor;
      this.acceptor = undefined;
      resolve(value);
    } else this.queue.push(value);
    return new ResourceWire(client);
  }
  async call(op: string, id: number, value: unknown): Promise<unknown> {
    if (op === 'hash.start') {
      this.hashes.set(++this.next, createHash('sha256'));
      return this.next;
    }
    const hash = this.hashes.get(id);
    if (hash === undefined) throw new Error('Hash closed.');
    if (op === 'hash.update') {
      hash.update(value as Uint8Array);
      return null;
    }
    this.hashes.delete(id);
    return op === 'hash.finish' ? hash.digest('hex') : null;
  }
  close(): void {
    this.closed = true;
    this.rejected?.(new Error('Closed.'));
    for (const stream of this.streams) void stream.close();
  }
}
async function fixture(
  files: File[] = [new File(['hello file'], 'result.txt')],
  text = 'hello text',
) {
  const transport = new Transport();
  const host = new BrowserHost(files, text, vi.fn(), transport);
  hosts.push(host);
  await host.start('https://relay-map.example.invalid/map');
  const url = new URL(host.invitation('http://localhost'));
  const invitation = parseResourceInvitation(url.hash, url.hostname, true);
  const hello = { type: 'hello', version: 2, session: invitation.session };
  const control = transport.connect();
  await control.stream.write(new TextEncoder().encode('TMOUSE/2\n'));
  await control.json({ ...hello, channel: 'control', token: invitation.token });
  const welcome = await control.object();
  async function open(
    channel: Parameters<ResourceSession['open']>[0],
    resource: Parameters<ResourceSession['open']>[1],
    peer?: string,
  ) {
    const wire = transport.connect(peer);
    await wire.stream.write(new TextEncoder().encode('TMOUSE/2\n'));
    await wire.json({
      ...hello,
      channel,
      resource,
      member: welcome.member,
      grant: welcome.grant,
    });
    return wire;
  }
  const access: Pick<ResourceSession, 'open' | 'release' | 'hash'> = {
    open,
    release: (wire) => wire.close(),
    hash: (op, id, bytes) =>
      transport.call('hash.' + op, id ?? 0, bytes ?? null),
  };
  return { host, transport, hello, invitation, control, welcome, access, open };
}

it('moves selected browser files and text through authenticated framed streams', async () => {
  const { host, access, transport } = await fixture();
  const list = await listFiles(access);
  expect(list.entries.map((file) => file.name)).toEqual(['result.txt']);
  const chunks: Uint8Array[] = [];
  const close = vi.fn(async () => undefined);
  const abort = vi.fn(async () => undefined);
  await downloadFile(
    access,
    list.entries[0]!,
    {
      write: async (bytes) => {
        chunks.push(new Uint8Array(bytes));
      },
      close,
      abort,
    },
    new AbortController().signal,
    vi.fn(),
  );
  expect(new TextDecoder().decode(chunks[0])).toBe('hello file');
  expect(close).toHaveBeenCalledOnce();
  expect(abort).not.toHaveBeenCalled();
  expect(transport.hashes.size).toBe(0);
  expect(await exchangeText(access)).toBe('hello text');
  expect(await exchangeText(access, 'reply')).toBe('reply');
  expect(host.view.text).toBe('reply');
  host.setText('host reply');
  expect(await exchangeText(access)).toBe('host reply');
  host.close();
  expect(host.view.status).toBe('closed');
  expect(host.view.text).toBe('');
  expect(transport.closed).toBe(true);
  expect(() => host.invitation('https://example.invalid')).toThrow();
  expect(() => host.setText('later')).toThrow();
});
it('pages selections, supports empty files, and enforces download attempts', async () => {
  const files = Array.from(
    { length: 41 },
    (_, i) => new File([], `file-${i}.txt`),
  );
  const { access } = await fixture(files);
  const first = await listFiles(access);
  expect(first.entries).toHaveLength(40);
  expect(first.more).toBe(true);
  const next = await listFiles(access, '', first.next);
  expect(next.entries).toHaveLength(1);
  expect(next.more).toBe(false);
  const file = first.entries[0]!;
  for (let i = 0; i < 100; i++)
    await downloadFile(
      access,
      file,
      { write: vi.fn(), close: vi.fn(), abort: vi.fn() },
      new AbortController().signal,
      vi.fn(),
    );
  await expect(
    downloadFile(
      access,
      file,
      { write: vi.fn(), close: vi.fn(), abort: vi.fn() },
      new AbortController().signal,
      vi.fn(),
    ),
  ).rejects.toThrow('TRANSFER LIMIT');
});
it('rejects transferable grants, excess visitors, unknown resources and invalid requests', async () => {
  const { transport, hello, invitation, open, control, welcome } =
    await fixture();
  const other = await open('download', 'files', 'nodekey:' + 'b'.repeat(64));
  await expect(other.object()).rejects.toThrow('UNAUTHORIZED');
  const fresh = transport.connect();
  await fresh.stream.write(new TextEncoder().encode('TMOUSE/2\n'));
  await fresh.json({ ...hello, channel: 'control', token: invitation.token });
  await expect(fresh.object()).rejects.toThrow('SESSION BUSY');
  const forbidden = await open('upload', 'receive');
  await expect(forbidden.object()).rejects.toThrow('UNAUTHORIZED');
  for (const message of [
    { type: 'files.list', path: '../', offset: 0 },
    { type: 'files.list', path: '', offset: -1 },
    { type: 'download.begin', path: 'missing' },
    { type: 'unknown' },
  ]) {
    const wire = await open('download', 'files');
    await wire.json(message);
    await expect(wire.object()).rejects.toThrow('FILE UNAVAILABLE');
  }
  const invalid = await open('text', 'text');
  await invalid.json({ type: 'text.set', text: '\x1b' });
  await expect(invalid.object()).rejects.toThrow('BAD FRAME');
  await control.json({ type: 'leave' });
  await vi.waitFor(() => expect(transport.streams.length).toBeGreaterThan(0));
  const expired = transport.connect();
  await expired.stream.write(new TextEncoder().encode('TMOUSE/2\n'));
  await expired.json({
    ...hello,
    channel: 'text',
    resource: 'text',
    member: welcome.member,
    grant: welcome.grant,
  });
  await expect(expired.object()).rejects.toThrow('UNAUTHORIZED');
});
it('keeps a same-peer grant through reconnect and implements heartbeat and expiry', async () => {
  vi.useFakeTimers();
  const { host, transport, hello, welcome, control, access } = await fixture();
  await vi.advanceTimersByTimeAsync(5000);
  const ping = await control.object();
  expect(ping.type).toBe('ping');
  expect((await control.object()).type).toBe('state');
  await control.json({ type: 'pong', seq: ping.seq });
  const replacement = transport.connect();
  await replacement.stream.write(new TextEncoder().encode('TMOUSE/2\n'));
  await replacement.json({
    ...hello,
    channel: 'control',
    member: welcome.member,
    grant: welcome.grant,
  });
  expect((await replacement.object()).type).toBe('welcome');
  expect(await exchangeText(access)).toBe('hello text');
  await vi.advanceTimersByTimeAsync(16000);
  await expect(exchangeText(access)).rejects.toThrow('UNAUTHORIZED');
  await vi.advanceTimersByTimeAsync(3_600_000);
  expect(host.view.status).toBe('closed');
});
it('rejects unsafe selections and fails visibly when a listener cannot start', async () => {
  for (const files of [
    [new File([], '.hidden')],
    [new File([], 'a'), new File([], 'a')],
    Array.from({ length: 101 }, () => new File([], 'file')),
    [{ name: 'big', size: 256 * 1024 * 1024 + 1 } as File],
  ]) {
    const transport = new Transport();
    expect(() => new BrowserHost(files, '', vi.fn(), transport)).toThrow();
    expect(transport.closed).toBe(true);
  }
  const transport = new Transport();
  transport.listen.mockRejectedValueOnce(new Error('failure'));
  const host = new BrowserHost([], '', vi.fn(), transport);
  hosts.push(host);
  await expect(host.start()).rejects.toThrow();
  expect(host.view.status).toBe('closed');
  expect(() => new BrowserHost([], '\x00', vi.fn(), new Transport())).toThrow();
});
it('validates listings and text at the protocol boundary', () => {
  for (const path of [
    '../secret',
    '/absolute',
    '.hidden',
    'a\\b',
    'a:b',
    'a//b',
    'a/./b',
    'x\n',
    'x'.repeat(181),
  ])
    expect(validFilePath(path)).toBe(false);
  expect(validFilePath('', true)).toBe(true);
  expect(validText('safe\ntext')).toBe(true);
  expect(validText('x'.repeat(16385))).toBe(false);
  expect(validText('\x00')).toBe(false);
  for (const value of [
    {},
    { type: 'files.list', path: '', next: 0, more: false, entries: [null] },
    {
      type: 'files.list',
      path: '',
      next: 0,
      more: false,
      entries: [{ name: 'a', path: '../a', dir: false, size: 1 }],
    },
  ])
    expect(() => parseFileList(value)).toThrow();
});
it('does not commit a canceled or corrupt download', async () => {
  const { access } = await fixture();
  const list = await listFiles(access);
  const abort = vi.fn(async () => undefined);
  const close = vi.fn(async () => undefined);
  const sink = { write: vi.fn(async () => undefined), close, abort };
  const controller = new AbortController();
  controller.abort();
  await expect(
    downloadFile(access, list.entries[0]!, sink, controller.signal, vi.fn()),
  ).rejects.toThrow();
  expect(abort).toHaveBeenCalledOnce();
  expect(close).not.toHaveBeenCalled();
  await expect(
    downloadFile(
      access,
      { ...list.entries[0]!, size: 999 },
      sink,
      new AbortController().signal,
      vi.fn(),
    ),
  ).rejects.toThrow('changed');
  expect(close).not.toHaveBeenCalled();
  await expect(exchangeText(access, '\x1b')).rejects.toThrow();
});
it('uses a streaming save picker and bounds the Blob fallback', async () => {
  const sink = { write: vi.fn(), close: vi.fn(), abort: vi.fn() };
  vi.stubGlobal(
    'showSaveFilePicker',
    vi.fn(async () => ({ createWritable: async () => sink })),
  );
  const file = { name: 'a.txt', path: 'a.txt', dir: false, size: 1 };
  expect(await chooseDownload(file)).toBe(sink);
  vi.stubGlobal('showSaveFilePicker', undefined);
  await expect(
    chooseDownload({ ...file, size: MEMORY_DOWNLOAD_LIMIT + 1 }),
  ).rejects.toThrow('64 MiB');
  const click = vi.fn();
  vi.stubGlobal('document', { createElement: () => ({ click }) });
  const create = vi
    .spyOn(URL, 'createObjectURL')
    .mockReturnValue('blob:synthetic');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
  vi.useFakeTimers();
  const fallback = await chooseDownload(file);
  await fallback.write(new Uint8Array([1]));
  await fallback.close();
  expect(click).toHaveBeenCalledOnce();
  expect(create).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(60_000);
  const tooMuch = await chooseDownload(file);
  await expect(tooMuch.write(new Uint8Array([1, 2]))).rejects.toThrow();
  await tooMuch.abort();
});
