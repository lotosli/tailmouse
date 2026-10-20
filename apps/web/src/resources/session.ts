import { ResourceTransport } from '../transport/tailcat/resource.ts';
import { strictObject } from '../protocol/values.ts';
import {
  ResourceWire,
  ResourceError,
  ResourceProtocolError,
  CHUNK,
} from './wire.ts';
import { validateContentOrigin, validateTestEntry } from './deployment.ts';
import { saveRecovery, eraseRecovery, type Recovery } from './invitation.ts';
export interface SharedResource {
  id: 'cli' | 'web' | 'receive' | 'files' | 'text';
  state: string;
  readOnly?: boolean;
  initialPath?: string;
  origin?: string;
  maxFile?: number;
  maxTotal?: number;
  maxFiles?: number;
}
export interface ResourceManifest {
  testSingleOrigin?: boolean;
  contentPath?: string;
  title: string;
  resources: SharedResource[];
  contentOrigin: string;
  transport: string;
}
export type SessionStatus =
  | 'connecting'
  | 'waiting'
  | 'active'
  | 'reconnecting'
  | 'disconnected'
  | 'closed';
export interface SessionView {
  status: SessionStatus;
  message: string;
  manifest: ResourceManifest | null;
  controller: boolean;
  expiring: boolean;
  runtimeProgress?: { received: number; total: number } | undefined;
}
export interface UploadReceipt {
  type: 'upload.completed';
  upload: string;
  name: string;
  path: string;
  size: number;
  sha256: string;
}
export function parseReceipt(value: Record<string, unknown>): UploadReceipt {
  if (
    value.type !== 'upload.completed' ||
    typeof value.upload !== 'string' ||
    !/^[a-f0-9]{32}$/u.test(value.upload) ||
    typeof value.name !== 'string' ||
    value.name.length === 0 ||
    value.name.length > 256 ||
    /[/\\]/u.test(value.name) ||
    Array.from(value.name).some((c) => c.charCodeAt(0) < 32) ||
    typeof value.path !== 'string' ||
    value.path.length === 0 ||
    value.path.length > 512 ||
    Array.from(value.path).some(
      (c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127,
    ) ||
    value.path.startsWith('/') ||
    value.path.split('/').includes('..') ||
    value.path.includes('\\') ||
    typeof value.size !== 'number' ||
    !Number.isSafeInteger(value.size) ||
    value.size < 0 ||
    typeof value.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(value.sha256)
  )
    throw new Error('Invalid upload receipt.');
  return value as unknown as UploadReceipt;
}
export class ResourceSession {
  readonly recovery: Recovery;
  readonly #storage: Storage;
  #transport: ResourceTransport | undefined;
  #control: ResourceWire | undefined;
  #streams = new Set<ResourceWire>();
  #closed = false;
  #connecting = false;
  #resumePending = false;
  #sending: Promise<void> = Promise.resolve();
  #queued = 0;
  #generation = 0;
  #view: SessionView = {
    status: 'connecting',
    message: 'Connecting to the host…',
    manifest: null,
    controller: false,
    expiring: false,
  };
  #listeners = new Set<(view: SessionView) => void>();
  constructor(recovery: Recovery, storage: Storage) {
    this.recovery = recovery;
    this.#storage = storage;
  }
  get view(): SessionView {
    return this.#view;
  }
  subscribe(listener: (view: SessionView) => void): () => void {
    this.#listeners.add(listener);
    listener(this.#view);
    return () => this.#listeners.delete(listener);
  }
  #update(values: Partial<SessionView>): void {
    this.#view = { ...this.#view, ...values };
    for (const listener of this.#listeners) listener(this.#view);
  }
  async connect(): Promise<void> {
    if (this.#closed || this.#connecting) return;
    this.#connecting = true;
    const generation = ++this.#generation;
    const deadline = performance.now() + 60_000;
    let attempt = 0;
    const reconnecting = this.#view.status === 'reconnecting';
    const budget = setTimeout(() => {
      this.#transport?.close();
      this.#transport = undefined;
    }, 60_000);
    try {
      if (
        typeof location !== 'undefined' &&
        location.pathname === '/.tailmouse/workspace/'
      ) {
        try {
          await validateTestEntry();
        } catch {
          this.close(
            'Single-origin testing is not enabled by this deployment.',
          );
          return;
        }
      }
      while (!this.#closed && generation === this.#generation) {
        try {
          this.#update({
            status:
              attempt === 0 && !reconnecting ? 'connecting' : 'reconnecting',
            controller: false,
            message:
              attempt === 0 && !reconnecting
                ? 'Loading the secure connection runtime…'
                : 'Reconnecting; pending input and requests were discarded.',
          });
          if (this.#transport === undefined) {
            const transport = new ResourceTransport();
            this.#transport = transport;
            try {
              this.recovery.key = await transport.start(
                this.recovery.invitation.address,
                this.recovery.key,
                () => {
                  if (!this.#closed && generation === this.#generation)
                    this.#update({
                      message: 'Connecting to the host…',
                      runtimeProgress: undefined,
                    });
                },
                (runtimeProgress) => {
                  if (!this.#closed && generation === this.#generation)
                    this.#update({ runtimeProgress });
                },
              );
            } catch (error) {
              transport.close();
              this.#transport = undefined;
              throw error;
            }
            if (this.#closed || generation !== this.#generation) return;
            saveRecovery(this.#storage, this.recovery);
          }
          const wire = new ResourceWire(await this.#transport.dial());
          if (this.#closed || generation !== this.#generation) {
            await wire.close();
            return;
          }
          this.#control = wire;
          await wire.stream.write(new TextEncoder().encode('TMOUSE/2\n'));
          const validGrant =
            this.recovery.member !== '' &&
            this.recovery.grant !== '' &&
            this.recovery.expires > Date.now();
          await wire.json({
            type: 'hello',
            version: 2,
            session: this.recovery.invitation.session,
            channel: 'control',
            ...(validGrant
              ? { member: this.recovery.member, grant: this.recovery.grant }
              : { token: this.recovery.invitation.token }),
          });
          let welcome = await wire.object();
          if (welcome.type === 'waiting') {
            this.#update({
              status: 'waiting',
              message: 'Waiting for the host to approve this visit.',
            });
            welcome = await wire.object();
          }
          await this.#acceptWelcome(welcome);
          if (this.#closed || generation !== this.#generation) return;
          this.#update({
            status: 'active',
            message: 'Connected · encrypted Tailcat over DERP',
          });
          void this.#readControl(wire, generation);
          return;
        } catch (error) {
          if (
            error instanceof Error &&
            error.message === 'BROWSER_UNSUPPORTED'
          ) {
            this.close(
              'This browser needs WebAssembly, dedicated Workers and streaming APIs. Use a current browser.',
            );
            return;
          }
          if (this.#closed || generation !== this.#generation) return;
          if (
            error instanceof ResourceProtocolError ||
            (error instanceof ResourceError && error.code === 'BAD_FRAME')
          ) {
            this.close(
              'The host and website versions are incompatible. Ask the host for a matching build and a new link.',
            );
            return;
          }
          if (
            error instanceof ResourceError &&
            ['UNAUTHORIZED', 'EXPIRED'].includes(error.code)
          ) {
            this.close(
              error.code === 'EXPIRED'
                ? 'This session has expired. Ask the host to start a new session and send a new link.'
                : 'Access was revoked or the invitation is no longer valid. Ask the host for a new link.',
            );
            return;
          }
          await this.#control?.close().catch(() => undefined);
          this.#control = undefined;
          if (error instanceof ResourceError && error.code === 'SESSION_BUSY') {
            this.#update({
              status: 'disconnected',
              message:
                'All visitor slots are in use. Ask another visitor to leave, then reconnect.',
            });
            return;
          }
          if (performance.now() >= deadline) {
            this.#update({
              status: 'disconnected',
              message:
                'Could not connect within 60 seconds. Check your connection and ask the host to keep TailMouse running, then reconnect.',
            });
            return;
          }
          attempt++;
          await new Promise<void>((resolve) =>
            setTimeout(
              resolve,
              Math.min(
                deadline - performance.now(),
                Math.min(5000, 300 * 2 ** Math.min(attempt, 4)) *
                  (0.8 + Math.random() * 0.4),
              ),
            ),
          );
        }
      }
    } finally {
      clearTimeout(budget);
      this.#connecting = false;
      if (this.#resumePending && !this.#closed) {
        this.#resumePending = false;
        void this.connect();
      }
    }
  }
  async #acceptWelcome(value: Record<string, unknown>): Promise<void> {
    const m = value.manifest as ResourceManifest | undefined;
    if (
      value.type !== 'welcome' ||
      value.version !== 2 ||
      typeof value.member !== 'string' ||
      !/^[a-f0-9]{32}$/u.test(value.member) ||
      typeof value.grant !== 'string' ||
      !/^[A-Za-z0-9_-]{43}$/u.test(value.grant) ||
      typeof value.expires !== 'number' ||
      !Number.isSafeInteger(value.expires) ||
      m === undefined ||
      m === null ||
      typeof m.title !== 'string' ||
      !Array.isArray(m.resources) ||
      m.resources.length < 1 ||
      m.resources.length > 5 ||
      m.resources.some(
        (r) =>
          r === null ||
          typeof r !== 'object' ||
          !['cli', 'web', 'receive', 'files', 'text'].includes(r.id),
      ) ||
      new Set(m.resources.map((r) => r.id)).size !== m.resources.length
    )
      throw new ResourceProtocolError('Incompatible host manifest.');
    if (m.resources.some((r) => r.id === 'web')) {
      await validateContentOrigin(
        m.contentOrigin,
        this.recovery.invitation.session,
        m.testSingleOrigin === true,
      );
      if (
        m.testSingleOrigin === true &&
        m.contentPath !==
          `/.tailmouse/p/${this.recovery.invitation.session}/bridge.html`
      )
        throw new ResourceProtocolError('Invalid test preview namespace.');
    }
    this.recovery.member = value.member;
    this.recovery.grant = value.grant;
    this.recovery.expires = value.expires;
    saveRecovery(this.#storage, this.recovery);
    this.#update({ manifest: m });
  }
  async #readControl(wire: ResourceWire, generation: number): Promise<void> {
    let liveness: ReturnType<typeof setTimeout>;
    const refresh = (): void => {
      clearTimeout(liveness);
      liveness = setTimeout(() => {
        void wire.close();
      }, 15_000);
    };
    refresh();
    try {
      while (!this.#closed && generation === this.#generation) {
        const value = await wire.object();
        if (value.type === 'ping' && Number.isSafeInteger(value.seq)) {
          refresh();
          await this.#sendControl({ type: 'pong', seq: value.seq });
        } else if (
          value.type === 'state' &&
          typeof value.controller === 'boolean'
        ) {
          const states = value.resources;
          const manifest = this.#view.manifest;
          if (
            !Array.isArray(states) ||
            states.some((r: unknown) => typeof r !== 'object' || r === null)
          )
            throw new ResourceProtocolError('Invalid resource states.');
          this.#update({
            controller: value.controller,
            expiring: value.expiring === true,
            manifest:
              manifest === null
                ? null
                : {
                    ...manifest,
                    resources: manifest.resources.map((r) => {
                      const next = states.find(
                        (v: SharedResource) => v.id === r.id,
                      ) as SharedResource | undefined;
                      return next !== undefined &&
                        typeof next.state === 'string'
                        ? { ...r, state: next.state }
                        : r;
                    }),
                  },
          });
        } else if (value.type === 'web.state') {
          const manifest = this.#view.manifest;
          if (
            manifest !== null &&
            ['READY', 'UNAVAILABLE'].includes(String(value.state))
          )
            this.#update({
              manifest: {
                ...manifest,
                resources: manifest.resources.map((r) =>
                  r.id === 'web' ? { ...r, state: String(value.state) } : r,
                ),
              },
            });
        } else if (value.type === 'close') {
          this.close('The host ended this session.');
          return;
        } else throw new ResourceProtocolError('Unexpected control message.');
      }
    } catch (error) {
      if (
        error instanceof ResourceProtocolError ||
        error instanceof ResourceError
      ) {
        this.close('The host ended access or sent an invalid control message.');
        return;
      }
      if (!this.#closed && generation === this.#generation) {
        this.#update({ status: 'reconnecting', controller: false });
        await this.#closeStreams();
        setTimeout(() => {
          void this.connect();
        }, 0);
      }
    } finally {
      clearTimeout(liveness!);
    }
  }
  async #sendControl(message: unknown): Promise<void> {
    const wire = this.#control;
    if (wire === undefined || this.#queued >= 8)
      throw new Error('Control channel unavailable.');
    this.#queued++;
    const previous = this.#sending;
    const send = (async (): Promise<void> => {
      await previous.catch(() => undefined);
      if (this.#closed || wire !== this.#control)
        throw new Error('Control channel changed.');
      await wire.json(message);
    })();
    this.#sending = send;
    try {
      await send;
    } finally {
      this.#queued--;
    }
  }
  async reprobe(): Promise<void> {
    if (this.#view.status !== 'active' || this.#control === undefined) return;
    await this.#sendControl({ type: 'web.reprobe' });
  }
  resume(): void {
    if (this.#view.status === 'closed') return;
    this.#closed = false;
    if (this.#connecting) this.#resumePending = true;
    else void this.connect();
  }
  async leave(): Promise<void> {
    const wire = this.#control;
    try {
      if (wire !== undefined)
        await Promise.race([
          this.#sendControl({ type: 'leave' }),
          new Promise<void>((resolve) => setTimeout(resolve, 500)),
        ]);
    } finally {
      this.close(
        'You left the workspace. The host’s session continues until they end it or it expires.',
      );
    }
  }
  async open(
    channel: 'terminal' | 'http' | 'websocket' | 'upload' | 'download' | 'text',
    resource: SharedResource['id'],
  ): Promise<ResourceWire> {
    if (
      this.#closed ||
      this.#view.status !== 'active' ||
      this.#transport === undefined ||
      !this.#view.manifest?.resources.some((r) => r.id === resource)
    )
      throw new Error('Resource unavailable.');
    const generation = this.#generation;
    const transport = this.#transport;
    const stillActive = (): void => {
      if (
        this.#closed ||
        generation !== this.#generation ||
        this.#transport !== transport ||
        this.#view.status !== 'active'
      )
        throw new Error('Resource session changed.');
    };
    const wire = new ResourceWire(
      await transport.dial(
        channel === 'terminal'
          ? 1
          : channel === 'upload' || channel === 'download'
            ? 3
            : 2,
      ),
    );
    try {
      stillActive();
      this.#streams.add(wire);
      await wire.stream.write(new TextEncoder().encode('TMOUSE/2\n'));
      stillActive();
      await wire.json({
        type: 'hello',
        version: 2,
        session: this.recovery.invitation.session,
        channel,
        resource,
        member: this.recovery.member,
        grant: this.recovery.grant,
      });
      stillActive();
      return wire;
    } catch (error) {
      this.#streams.delete(wire);
      await wire.close();
      throw error;
    }
  }
  async hash(
    op: 'start' | 'update' | 'finish' | 'cancel',
    id = 0,
    data: Uint8Array | null = null,
  ): Promise<unknown> {
    if (this.#transport === undefined)
      throw new Error('Connection unavailable.');
    return this.#transport.call('hash.' + op, id, data);
  }
  async release(wire: ResourceWire): Promise<void> {
    this.#streams.delete(wire);
    await wire.close();
  }
  async upload(
    file: File,
    signal: AbortSignal,
    progress: (state: string, received: number) => void,
  ): Promise<UploadReceipt> {
    const wire = await this.open('upload', 'receive');
    const transport = this.#transport!;
    let reader: ReadableStreamBYOBReader | undefined;
    const abort = (): void => {
      void wire.close();
      void reader?.cancel().catch(() => undefined);
    };
    signal.addEventListener('abort', abort, { once: true });
    let hash: number | undefined;
    try {
      if (signal.aborted) throw new Error('Upload canceled.');
      await wire.json({
        type: 'upload.begin',
        name: file.name,
        size: file.size,
      });
      const ready = await wire.object();
      if (ready.type !== 'upload.ready' || typeof ready.upload !== 'string')
        throw new Error('Upload not accepted.');
      const id = await transport.call('hash.start', 0, null);
      if (typeof id !== 'number') throw new Error('Hasher unavailable.');
      hash = id;
      reader = file.stream().getReader({ mode: 'byob' });
      let buffer = new Uint8Array(CHUNK);
      progress('uploading', 0);
      let sent = 0;
      let acknowledged = 0;
      let wake: (() => void) | undefined;
      let acknowledgementError: unknown;
      const acknowledgments = (async (): Promise<void> => {
        while (acknowledged < file.size) {
          const ack = await wire.object();
          if (
            ack.type !== 'upload.progress' ||
            typeof ack.received !== 'number' ||
            !Number.isSafeInteger(ack.received) ||
            ack.received <= acknowledged ||
            ack.received > sent
          )
            throw new Error('Invalid upload acknowledgement.');
          acknowledged = ack.received;
          progress('uploading', acknowledged);
          wake?.();
          wake = undefined;
        }
      })().catch((error: unknown) => {
        acknowledgementError = error;
        wake?.();
        wake = undefined;
        void wire.close().catch(() => undefined);
        void reader?.cancel().catch(() => undefined);
      });
      try {
        while (sent < file.size) {
          if (signal.aborted) throw new Error('Upload canceled.');
          if (acknowledgementError !== undefined) throw acknowledgementError;
          while (sent - acknowledged >= 256 * 1024) {
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
            if (acknowledgementError !== undefined) throw acknowledgementError;
            if (signal.aborted) throw new Error('Upload canceled.');
          }
          const { value: bytes } = await reader.read(buffer);
          if (signal.aborted) throw new Error('Upload canceled.');
          if (acknowledgementError !== undefined) throw acknowledgementError;
          if (
            bytes === undefined ||
            bytes.length === 0 ||
            bytes.length > file.size - sent
          )
            throw new Error('File size changed during upload.');
          await transport.call('hash.update', hash, bytes);
          sent += bytes.length;
          await wire.write(2, bytes);
          // BYOB transfers this bounded backing store back to the reader on
          // its next read, avoiding a Blob and allocation for every frame.
          buffer = new Uint8Array(bytes.buffer);
        }
        await acknowledgments;
        if (acknowledgementError !== undefined) throw acknowledgementError;
      } catch (error) {
        await wire.close().catch(() => undefined);
        await acknowledgments;
        throw error;
      }
      progress('verifying', file.size);
      const digest = await transport.call('hash.finish', hash, null);
      hash = undefined;
      await wire.json({ type: 'upload.finish', sha256: digest });
      let receipt: UploadReceipt;
      try {
        receipt = parseReceipt(await wire.object());
      } catch (error) {
        if (signal.aborted) throw error;
        if (this.#view.status !== 'active') await this.#awaitActive(signal);
        if (this.#view.status !== 'active') throw error;
        const query = await this.open('upload', 'receive');
        try {
          await query.json({ type: 'upload.status', upload: ready.upload });
          receipt = parseReceipt(await query.object());
        } finally {
          await this.release(query).catch(() => undefined);
        }
      }
      if (
        receipt.upload !== ready.upload ||
        receipt.size !== file.size ||
        receipt.sha256 !== digest
      )
        throw new Error('Invalid committed receipt.');
      progress('completed', file.size);
      return receipt;
    } finally {
      signal.removeEventListener('abort', abort);
      if (reader !== undefined) {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
      if (hash !== undefined)
        await transport.call('hash.cancel', hash, null).catch(() => undefined);
      await this.release(wire).catch(() => undefined);
    }
  }
  async #awaitActive(signal: AbortSignal): Promise<void> {
    if (this.#view.status === 'active') return;
    await new Promise<void>((resolve, reject) => {
      let unsubscribe = (): void => undefined;
      let finished = false;
      const finish = (ok: boolean): void => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        unsubscribe();
        signal.removeEventListener('abort', aborted);
        if (ok) resolve();
        else
          reject(
            new Error(
              'Upload result is unknown. Reconnect before checking its status.',
            ),
          );
      };
      const aborted = (): void => finish(false);
      const timer = setTimeout(aborted, 60_000);
      signal.addEventListener('abort', aborted, { once: true });
      unsubscribe = this.subscribe((view) => {
        if (view.status === 'active') finish(true);
        else if (view.status === 'closed' || view.status === 'disconnected')
          finish(false);
      });
      if (finished) unsubscribe();
      if (signal.aborted) finish(false);
    });
  }
  async #closeStreams(): Promise<void> {
    const streams = [...this.#streams];
    this.#streams.clear();
    await Promise.allSettled(streams.map((s) => s.close()));
  }
  suspend(): void {
    this.#closed = true;
    this.#generation++;
    this.#transport?.close();
    this.#transport = undefined;
    this.#streams.clear();
    this.#control = undefined;
  }
  close(message = 'Session closed.'): void {
    if (this.#view.status === 'closed') return;
    this.#closed = true;
    this.#generation++;
    this.#transport?.close();
    this.#transport = undefined;
    this.#streams.clear();
    this.#control = undefined;
    eraseRecovery(this.#storage);
    this.recovery.key = '';
    this.recovery.grant = '';
    this.recovery.invitation.token = '';
    this.recovery.invitation.address = '';
    this.#update({
      status: 'closed',
      runtimeProgress: undefined,
      controller: false,
      manifest: null,
      message,
    });
  }
}
export function frameObject(data: Uint8Array): Record<string, unknown> {
  return strictObject(data);
}
