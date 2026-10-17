import type { ResourceSession } from './session.ts';
import { CHUNK, type ResourceWire } from './wire.ts';

// The untrusted port has precisely one fixed web resource. It never accepts
// resource IDs, control hellos, grants, terminal messages or upload receipts.
export function bindPreview(
  frame: HTMLIFrameElement,
  origin: string,
  session: ResourceSession,
  initialPath: string,
  onState: (message: string) => void,
): {
  dispose: () => void;
  navigate: (
    command: 'back' | 'forward' | 'reload' | 'path',
    path?: string,
  ) => void;
} {
  const active = new Map<MessagePort, AbortController>();
  let bridge: MessagePort | undefined;
  const listener = (event: MessageEvent<unknown>): void => {
    if (event.origin !== origin || event.source !== frame.contentWindow) return;
    const data = event.data as { type?: unknown; version?: unknown };
    if (data?.type !== 'tm.bridge.ready' || data.version !== 1) return;
    bridge?.close();
    const channel = new MessageChannel();
    bridge = channel.port1;
    bridge.onmessage = (message: MessageEvent<unknown>): void => {
      const request = message.data as {
        type?: unknown;
        method?: unknown;
        path?: unknown;
        headers?: unknown;
        protocols?: unknown;
      };
      if (request?.type === 'tm.bridge.incompatible') {
        onState(
          'This application uses its own Service Worker, which is incompatible with this isolated preview.',
        );
        return;
      }
      if (request?.type === 'tm.bridge.controlled') {
        onState('Preview ready');
        return;
      }
      const port = message.ports[0];
      if (
        port === undefined ||
        active.size >= 16 ||
        (request.type !== 'http' && request.type !== 'websocket')
      ) {
        port?.close();
        return;
      }
      const abort = new AbortController();
      active.set(port, abort);
      void (
        request.type === 'http'
          ? bridgeHTTP(session, port, request, abort.signal)
          : bridgeSocket(session, port, request, abort.signal)
      )
        .catch(() => {
          if (
            request.type === 'http' &&
            request.method !== 'GET' &&
            request.method !== 'HEAD'
          )
            onState(
              'Request result is unknown. Verify the application state before retrying',
            );
          port.postMessage({
            type: 'error',
            message:
              request.type === 'http' &&
              request.method !== 'GET' &&
              request.method !== 'HEAD'
                ? 'REQUEST_RESULT_UNKNOWN'
                : 'RESOURCE_UNAVAILABLE',
          });
        })
        .finally(() => {
          active.delete(port);
          port.close();
        });
    };
    frame.contentWindow!.postMessage(
      { type: 'tm.bridge.init', version: 1, path: initialPath },
      origin,
      [channel.port2],
    );
  };
  window.addEventListener('message', listener);
  return {
    navigate: (command, path) =>
      bridge?.postMessage({ type: 'navigate', command, path }),
    dispose: () => {
      window.removeEventListener('message', listener);
      bridge?.postMessage({ type: 'dispose' });
      bridge?.close();
      for (const [port, abort] of active) {
        abort.abort();
        port.postMessage({ type: 'error', message: 'SESSION_CLOSED' });
        port.close();
      }
      active.clear();
    },
  };
}
export function allowedPreviewPath(path: unknown): path is string {
  return (
    typeof path === 'string' &&
    path.length <= 8192 &&
    path.startsWith('/') &&
    !path.startsWith('//') &&
    !path.includes('\\') &&
    !Array.from(path).some((c) => c.charCodeAt(0) < 32) &&
    !path.startsWith('/.tailmouse/')
  );
}
function portInbox(port: MessagePort): {
  next: () => Promise<Record<string, unknown>>;
  stop: () => void;
} {
  const queued: Record<string, unknown>[] = [];
  let waiter: ((value: Record<string, unknown>) => void) | undefined;
  let stopped = false;
  port.onmessage = (event: MessageEvent<unknown>) => {
    if (
      typeof event.data !== 'object' ||
      event.data === null ||
      Array.isArray(event.data)
    ) {
      stopped = true;
      waiter?.({ type: 'cancel' });
      return;
    }
    const value = event.data as Record<string, unknown>;
    if (waiter !== undefined) {
      const receive = waiter;
      waiter = undefined;
      receive(value);
    } else if (queued.length < 4) queued.push(value);
    else {
      stopped = true;
      queued.length = 0;
      queued.push({ type: 'cancel' });
    }
  };
  port.start();
  return {
    next: () => {
      if (stopped) return Promise.resolve({ type: 'cancel' });
      const value = queued.shift();
      if (value !== undefined) return Promise.resolve(value);
      return new Promise((resolve) => {
        waiter = resolve;
      });
    },
    stop: () => {
      stopped = true;
      waiter?.({ type: 'cancel' });
      waiter = undefined;
    },
  };
}
export async function bridgeHTTP(
  session: ResourceSession,
  port: MessagePort,
  request: Record<string, unknown>,
  signal: AbortSignal,
): Promise<void> {
  if (
    !allowedPreviewPath(request.path) ||
    typeof request.method !== 'string' ||
    !['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(
      request.method,
    ) ||
    (request.credentials !== undefined &&
      (typeof request.credentials !== 'string' ||
        !['omit', 'same-origin', 'include'].includes(request.credentials))) ||
    !Array.isArray(request.headers) ||
    request.headers.length > 128 ||
    request.headers.some(
      (h: unknown) =>
        !Array.isArray(h) ||
        h.length !== 2 ||
        h.some((v: unknown) => typeof v !== 'string' || v.length > 8192),
    )
  )
    throw new Error('Invalid preview request.');
  const inbox = portInbox(port);
  let wire: ResourceWire | undefined;
  let bodyDone: Promise<void> | undefined;
  let ack: (() => void) | undefined;
  let canceled = false;
  const cancel = (): void => {
    canceled = true;
    inbox.stop();
    ack?.();
    ack = undefined;
    void wire?.close().catch(() => undefined);
  };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    wire = await session.open('http', 'web');
    if (signal.aborted) {
      cancel();
      return;
    }
    await wire.json({
      type: 'request',
      method: request.method,
      credentials: request.credentials ?? 'same-origin',
      path: request.path,
      headers: request.headers,
    });
    const stream = wire;
    let responseAck = false;
    bodyDone = (async () => {
      let ended = false;
      while (true) {
        const message = await inbox.next();
        if (message.type === 'cancel') {
          cancel();
          await stream.close();
          return;
        }
        if (message.type === 'response.ack') {
          if (ack !== undefined) {
            ack();
            ack = undefined;
          } else responseAck = true;
          continue;
        }
        if (ended) throw new Error('Unexpected body frame.');
        if (message.type === 'body.end') {
          ended = true;
          await stream.write(3);
          continue;
        }
        if (
          message.type !== 'body' ||
          !(message.data instanceof Uint8Array) ||
          message.data.length > CHUNK
        )
          throw new Error('Invalid request chunk.');
        await stream.write(2, message.data);
        port.postMessage({ type: 'body.ack' });
      }
    })().catch(async () => {
      cancel();
      await stream.close();
    });
    const head = await wire.object();
    if (
      head.type !== 'response' ||
      typeof head.status !== 'number' ||
      !Number.isInteger(head.status) ||
      head.status < 200 ||
      head.status > 599 ||
      !Array.isArray(head.headers)
    )
      throw new Error('Invalid HTTP response.');
    port.postMessage({
      type: 'response',
      status: head.status,
      headers: head.headers,
    });
    while (true) {
      const frame = await wire.read();
      if (frame.kind === 3) {
        port.postMessage({ type: 'response.end' });
        return;
      }
      if (frame.kind !== 2) throw new Error('HTTP response interrupted.');
      const waiting = new Promise<void>((resolve) => {
        if (responseAck) {
          responseAck = false;
          resolve();
        } else ack = resolve;
      });
      port.postMessage({ type: 'response.data', data: frame.data }, [
        frame.data.buffer,
      ]);
      await waiting;
      if (canceled) return;
    }
  } finally {
    signal.removeEventListener('abort', cancel);
    cancel();
    if (wire !== undefined) await session.release(wire);
    await bodyDone;
  }
}
export async function bridgeSocket(
  session: ResourceSession,
  port: MessagePort,
  request: Record<string, unknown>,
  signal: AbortSignal,
): Promise<void> {
  if (
    !allowedPreviewPath(request.path) ||
    !Array.isArray(request.protocols) ||
    request.protocols.length > 16 ||
    request.protocols.some(
      (p: unknown) => typeof p !== 'string' || p.length > 128,
    )
  )
    throw new Error('Invalid socket target.');
  const inbox = portInbox(port);
  const wire = await session.open('websocket', 'web');
  let received: (() => void) | undefined;
  let canceled = false;
  const cancel = (): void => {
    canceled = true;
    received?.();
    received = undefined;
    inbox.stop();
    void wire.close().catch(() => undefined);
  };
  signal.addEventListener('abort', cancel, { once: true });
  let reader: Promise<void> | undefined;
  try {
    if (signal.aborted) return;
    await wire.json({
      type: 'websocket',
      path: request.path,
      protocols: request.protocols,
    });
    const opened = await wire.object();
    if (opened.type !== 'websocket.open')
      throw new Error('Socket could not open.');
    port.postMessage({ type: 'websocket.open', protocol: opened.protocol });
    reader = (async () => {
      while (true) {
        const message = await inbox.next();
        if (message.type === 'cancel') {
          cancel();
          await wire.close();
          return;
        }
        if (message.type === 'websocket.received') {
          if (received === undefined)
            throw new Error('Unexpected socket acknowledgement.');
          received();
          received = undefined;
          continue;
        }
        if (message.type === 'websocket.close') {
          await wire.json({
            type: message.type,
            code: message.code,
            reason: message.reason,
          });
          received?.();
          received = undefined;
          return;
        }
        if (
          message.type !== 'websocket.message' ||
          !(message.data instanceof Uint8Array) ||
          message.data.length > 1 << 20 ||
          typeof message.text !== 'boolean'
        )
          throw new Error('Invalid socket data.');
        await wire.json({
          type: 'websocket.message',
          text: message.text,
          size: message.data.length,
        });
        for (let i = 0; i < message.data.length; i += CHUNK)
          await wire.write(2, message.data.slice(i, i + CHUNK));
        await wire.write(3);
        port.postMessage({ type: 'websocket.ack', bytes: message.data.length });
      }
    })().catch(async () => {
      cancel();
      await wire.close();
    });
    while (true) {
      const message = await wire.object();
      if (message.type === 'websocket.close') {
        port.postMessage(message);
        return;
      }
      if (
        message.type !== 'websocket.message' ||
        typeof message.size !== 'number' ||
        !Number.isSafeInteger(message.size) ||
        message.size < 0 ||
        message.size > 1 << 20
      )
        throw new Error('Invalid socket response.');
      const data = new Uint8Array(message.size);
      let offset = 0;
      while (true) {
        const f = await wire.read();
        if (f.kind === 3) break;
        if (f.kind !== 2 || offset + f.data.length > data.length)
          throw new Error('Invalid socket data.');
        data.set(f.data, offset);
        offset += f.data.length;
      }
      if (offset !== data.length) throw new Error('Incomplete socket message.');
      const acknowledged = new Promise<void>((resolve) => {
        received = resolve;
      });
      port.postMessage(
        { type: 'websocket.message', text: message.text === true, data },
        [data.buffer],
      );
      await acknowledged;
      if (canceled) return;
    }
  } finally {
    signal.removeEventListener('abort', cancel);
    cancel();
    await session.release(wire);
    await reader;
  }
}
