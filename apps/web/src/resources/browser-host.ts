import { ResourceTransport } from '../transport/tailcat/resource.ts';
import { ResourceWire, CHUNK } from './wire.ts';
import { validFilePath, validText, type OfferedFile } from './transfers.ts';

export interface BrowserHostView {
  status: 'starting' | 'sharing' | 'closed';
  text: string;
  bytes: number;
  visitors: number;
  message: string;
}
type HostTransport = Pick<
  ResourceTransport,
  'listen' | 'accept' | 'call' | 'close'
>;
interface Guest {
  id: string;
  grant: string;
  peer: string;
  control: ResourceWire | null;
  streams: Set<ResourceWire>;
  disconnected: number;
}
function randomHex(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
}
function secret(): string {
  return btoa(
    String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))),
  )
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '');
}

export class BrowserHost {
  readonly #transport: HostTransport;
  readonly #changed: (view: BrowserHostView) => void;
  readonly #files = new Map<string, File>();
  readonly #streams = new Set<ResourceWire>();
  readonly #guests = new Map<string, Guest>();
  readonly #session = randomHex();
  #token = secret();
  #address = '';
  #closed = false;
  #active = 0;
  #attempts = 100;
  #remaining = 1024 * 1024 * 1024;
  #expires = 0;
  #expiry: ReturnType<typeof setTimeout> | undefined;
  #view: BrowserHostView;
  constructor(
    files: readonly File[],
    text: string,
    changed: (view: BrowserHostView) => void,
    transport: HostTransport = new ResourceTransport(),
  ) {
    if (files.length > 100 || !validText(text)) {
      transport.close();
      throw new Error('Choose up to 100 files and plain text up to 16 KiB.');
    }
    let total = 0;
    for (const file of files) {
      if (
        !validFilePath(file.name) ||
        file.name.includes('/') ||
        this.#files.has(file.name) ||
        file.size > 256 * 1024 * 1024
      ) {
        transport.close();
        throw new Error(
          'Files need distinct visible names and sizes up to 256 MiB.',
        );
      }
      total += file.size;
      this.#files.set(file.name, file);
    }
    if (total > this.#remaining) {
      transport.close();
      throw new Error('Selected files exceed the 1 GiB session budget.');
    }
    this.#transport = transport;
    this.#changed = changed;
    this.#view = {
      status: 'starting',
      text,
      bytes: 0,
      visitors: 0,
      message: 'Starting an encrypted browser session…',
    };
  }
  get view(): BrowserHostView {
    return this.#view;
  }
  #update(values: Partial<BrowserHostView>): void {
    this.#view = { ...this.#view, ...values };
    this.#changed(this.#view);
  }
  async start(mapURL = 'https://tailcat.dev/derpmap.json'): Promise<void> {
    try {
      this.#address = await this.#transport.listen(mapURL);
      if (this.#closed) return;
      this.#expires = Date.now() + 3_600_000;
      this.#expiry = setTimeout(
        () => this.close('This sharing session expired.'),
        3_600_000,
      );
      this.#update({
        status: 'sharing',
        message:
          'Keep this page open while the other device connects and downloads.',
      });
      void this.#accept();
    } catch {
      this.close(
        'Could not start sharing. Check your connection and try again.',
      );
      throw new Error('Could not start browser sharing.');
    }
  }
  invitation(origin: string): string {
    if (this.#view.status !== 'sharing')
      throw new Error('Sharing is not ready.');
    const base = new URL(origin);
    if (
      base.protocol !== 'https:' &&
      !(
        base.protocol === 'http:' &&
        ['localhost', '127.0.0.1'].includes(base.hostname)
      )
    )
      throw new Error('HTTPS is required.');
    base.pathname = '/.tailmouse/workspace/';
    base.search = '';
    base.hash =
      'tm=' +
      btoa(
        JSON.stringify({
          v: 1,
          session: this.#session,
          address: this.#address,
          token: this.#token,
          frontend_major: 1,
        }),
      )
        .replaceAll('+', '-')
        .replaceAll('/', '_')
        .replace(/=+$/u, '');
    return base.href;
  }
  setText(text: string): void {
    if (this.#closed || !validText(text))
      throw new Error('Text must be plain UTF-8, at most 16 KiB.');
    this.#update({ text, message: 'Shared text updated.' });
  }
  async #accept(): Promise<void> {
    try {
      while (!this.#closed) {
        const accepted = await this.#transport.accept();
        const wire = new ResourceWire(accepted.stream);
        if (this.#closed || this.#streams.size >= 16) {
          await wire.close();
          continue;
        }
        this.#streams.add(wire);
        void this.#serve(wire, accepted.peer);
      }
    } catch {
      if (!this.#closed)
        this.close(
          'The browser connection stopped. Start a fresh sharing session.',
        );
    }
  }
  #manifest(): Record<string, unknown> {
    return {
      title: 'Browser sharing',
      contentOrigin: '',
      transport: 'Tailcat over DERP',
      resources: [
        ...(this.#files.size
          ? [
              {
                id: 'files',
                state: 'READY',
                readOnly: true,
                maxFile: 256 * 1024 * 1024,
                maxTotal: 1024 * 1024 * 1024,
                maxFiles: 100,
              },
            ]
          : []),
        { id: 'text', state: 'READY', maxFile: 16384 },
      ],
    };
  }
  async #serve(wire: ResourceWire, peer: string): Promise<void> {
    const handshake = setTimeout(() => {
      void wire.close().catch(() => undefined);
    }, 10_000);
    let guest: Guest | undefined;
    try {
      await wire.acceptPreface();
      const hello = await wire.object();
      if (
        hello.type !== 'hello' ||
        hello.version !== 2 ||
        hello.session !== this.#session ||
        Object.keys(hello).some(
          (k) =>
            ![
              'type',
              'version',
              'session',
              'channel',
              'resource',
              'token',
              'member',
              'grant',
            ].includes(k),
        )
      )
        throw new Error('UNAUTHORIZED');
      if (this.#closed || Date.now() >= this.#expires)
        throw new Error('EXPIRED');
      for (const existing of this.#guests.values())
        if (
          existing.control === null &&
          Date.now() - existing.disconnected >= 60_000
        )
          this.#remove(existing);
      if (hello.token !== undefined) {
        if (
          hello.token !== this.#token ||
          hello.channel !== 'control' ||
          hello.member !== undefined ||
          hello.grant !== undefined ||
          hello.resource !== undefined
        )
          throw new Error('UNAUTHORIZED');
        if (this.#guests.size >= 1) throw new Error('SESSION_BUSY');
        guest = {
          id: randomHex(),
          grant: secret(),
          peer,
          control: wire,
          streams: new Set(),
          disconnected: 0,
        };
        this.#guests.set(guest.id, guest);
      } else {
        guest = this.#guests.get(String(hello.member));
        if (
          guest === undefined ||
          guest.peer !== peer ||
          hello.grant !== guest.grant ||
          hello.token !== undefined
        )
          throw new Error('UNAUTHORIZED');
        if (hello.channel === 'control') {
          if (hello.resource !== undefined) throw new Error('UNAUTHORIZED');
          await guest.control?.close();
          for (const stream of guest.streams) await stream.close();
          guest.streams.clear();
          guest.control = wire;
          guest.disconnected = 0;
        } else if (guest.control === null) throw new Error('UNAUTHORIZED');
      }
      clearTimeout(handshake);
      if (hello.channel === 'control') {
        this.#update({ visitors: 1 });
        await this.#control(wire, guest);
      } else {
        guest.streams.add(wire);
        if (
          hello.channel === 'download' &&
          hello.resource === 'files' &&
          this.#files.size > 0
        )
          await this.#download(wire);
        else if (hello.channel === 'text' && hello.resource === 'text')
          await this.#text(wire);
        else throw new Error('UNAUTHORIZED');
      }
    } catch (error) {
      const code =
        error instanceof Error &&
        [
          'UNAUTHORIZED',
          'SESSION_BUSY',
          'EXPIRED',
          'FILE_UNAVAILABLE',
          'TRANSFER_LIMIT',
        ].includes(error.message)
          ? error.message
          : 'BAD_FRAME';
      await wire.json({ type: 'error', code }).catch(() => undefined);
    } finally {
      clearTimeout(handshake);
      guest?.streams.delete(wire);
      this.#streams.delete(wire);
      await wire.close().catch(() => undefined);
    }
  }
  async #control(wire: ResourceWire, guest: Guest): Promise<void> {
    await wire.json({
      type: 'welcome',
      version: 2,
      member: guest.id,
      grant: guest.grant,
      expires: this.#expires,
      generation: 1,
      manifest: this.#manifest(),
    });
    let last = Date.now();
    let sequence = 0;
    let pending = 0;
    let writing = false;
    const timer = setInterval(() => {
      if (Date.now() - last >= 15_000 || this.#closed) {
        void wire.close().catch(() => undefined);
        return;
      }
      if (writing) return;
      writing = true;
      if (pending === 0) pending = ++sequence;
      void wire
        .json({ type: 'ping', seq: pending })
        .then(() =>
          wire.json({
            type: 'state',
            controller: false,
            expiring: this.#expires - Date.now() <= 300_000,
            resources: this.#manifest().resources,
          }),
        )
        .catch(() => wire.close())
        .finally(() => {
          writing = false;
        });
    }, 5000);
    try {
      while (!this.#closed && guest.control === wire) {
        const message = await wire.object();
        if (message.type === 'pong' && message.seq === pending && pending > 0) {
          pending = 0;
          last = Date.now();
        } else if (message.type === 'leave') {
          this.#remove(guest);
          return;
        } else throw new Error('BAD_FRAME');
      }
    } finally {
      clearInterval(timer);
      if (guest.control === wire) {
        guest.control = null;
        guest.disconnected = Date.now();
        for (const stream of guest.streams)
          await stream.close().catch(() => undefined);
        guest.streams.clear();
        this.#update({ visitors: 0 });
      }
    }
  }
  #remove(guest: Guest): void {
    this.#guests.delete(guest.id);
    void guest.control?.close().catch(() => undefined);
    for (const stream of guest.streams)
      void stream.close().catch(() => undefined);
    guest.streams.clear();
    guest.control = null;
    guest.grant = '';
    this.#update({
      visitors: [...this.#guests.values()].filter(
        (item) => item.control !== null,
      ).length,
    });
  }
  async #text(wire: ResourceWire): Promise<void> {
    const message = await wire.object();
    if (message.type === 'text.set' && validText(message.text ?? ''))
      this.setText((message.text ?? '') as string);
    else if (message.type !== 'text.get' || message.text !== undefined)
      throw new Error('BAD_FRAME');
    await wire.json({ type: 'text.value', text: this.#view.text });
  }
  async #download(wire: ResourceWire): Promise<void> {
    const message = await wire.object();
    if (
      message.type === 'files.list' &&
      message.path === '' &&
      Number.isSafeInteger(message.offset ?? 0)
    ) {
      const offset = Number(message.offset ?? 0);
      if (offset < 0 || offset > 100) throw new Error('FILE_UNAVAILABLE');
      const entries: OfferedFile[] = [...this.#files]
        .slice(offset, offset + 40)
        .map(([name, file]) => ({
          name,
          path: name,
          dir: false,
          size: file.size,
        }));
      await wire.json({
        type: 'files.list',
        path: '',
        entries,
        next: offset + entries.length,
        more: offset + entries.length < this.#files.size,
      });
      return;
    }
    const file = this.#files.get(String(message.path));
    if (
      message.type !== 'download.begin' ||
      file === undefined ||
      message.offset !== undefined
    )
      throw new Error('FILE_UNAVAILABLE');
    if (this.#active >= 2 || this.#attempts <= 0 || file.size > this.#remaining)
      throw new Error('TRANSFER_LIMIT');
    this.#active++;
    this.#attempts--;
    this.#remaining -= file.size;
    let hash: number | undefined;
    try {
      await wire.json({
        type: 'download.ready',
        name: file.name,
        size: file.size,
      });
      const id = await this.#transport.call('hash.start', 0, null);
      if (typeof id !== 'number') throw new Error('BAD_FRAME');
      hash = id;
      for (let offset = 0; offset < file.size; offset += CHUNK) {
        if (this.#closed) throw new Error('EXPIRED');
        const bytes = new Uint8Array(
          await file.slice(offset, offset + CHUNK).arrayBuffer(),
        );
        if (bytes.length !== Math.min(CHUNK, file.size - offset))
          throw new Error('FILE_UNAVAILABLE');
        await this.#transport.call('hash.update', hash, bytes);
        await wire.write(2, bytes);
        this.#update({ bytes: this.#view.bytes + bytes.length });
      }
      const digest = await this.#transport.call('hash.finish', hash, null);
      hash = undefined;
      await wire.write(3);
      await wire.json({
        type: 'download.completed',
        size: file.size,
        sha256: digest,
      });
    } finally {
      this.#active--;
      if (hash !== undefined)
        await this.#transport
          .call('hash.cancel', hash, null)
          .catch(() => undefined);
    }
  }
  close(message = 'Sharing ended. Start a new session to share again.'): void {
    if (this.#closed) return;
    this.#closed = true;
    clearTimeout(this.#expiry);
    this.#transport.close();
    this.#streams.clear();
    this.#guests.clear();
    this.#files.clear();
    this.#token = '';
    this.#address = '';
    this.#update({ status: 'closed', text: '', visitors: 0, message });
  }
}
