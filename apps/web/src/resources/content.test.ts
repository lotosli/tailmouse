import { afterEach, expect, it, vi } from 'vitest';

class Port {
  onmessage: ((event: MessageEvent) => void) | null = null;
  peer?: Port;
  closed = false;
  postMessage(data: unknown, ports: unknown[] = []) {
    if (!this.closed && !this.peer?.closed)
      this.peer?.onmessage?.({ data, ports } as unknown as MessageEvent);
  }
  close() {
    this.closed = true;
  }
}
class Channel {
  port1 = new Port();
  port2 = new Port();
  constructor() {
    this.port1.peer = this.port2;
    this.port2.peer = this.port1;
  }
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function shim(prefix = '') {
  const sent: { data: Record<string, unknown>; port: Port }[] = [];
  const win = {
    parent: {
      postMessage(
        data: Record<string, unknown>,
        _origin: string,
        ports: Port[],
      ) {
        sent.push({ data, port: ports?.[0] as Port });
      },
    },
  };
  vi.stubGlobal('window', win);
  vi.stubGlobal(
    'location',
    new URL('https://preview.example.test' + prefix + '/'),
  );
  vi.stubGlobal('document', {
    currentScript: {
      getAttribute(name: string) {
        return name === 'data-tailmouse-prefix' ? prefix : null;
      },
    },
    addEventListener: vi.fn(),
  });
  vi.stubGlobal('history', { pushState: vi.fn(), replaceState: vi.fn() });
  vi.stubGlobal('navigator', { serviceWorker: {} });
  vi.stubGlobal('MessageChannel', Channel);
  vi.stubGlobal(
    'CloseEvent',
    class extends Event {
      constructor(
        type: string,
        public detail: CloseEventInit,
      ) {
        super(type);
      }
    },
  );
  vi.resetModules();
  await import('../../content/shim.ts');
  return {
    Socket: (win as unknown as { WebSocket: typeof WebSocket }).WebSocket,
    sent,
  };
}
it('preview sockets bind their origin, deliver frames, acknowledge consumption and bound queued writes', async () => {
  const { Socket, sent } = await shim();
  for (const address of [
    'wss://foreign.invalid/',
    'wss://u@preview.example.test/',
    'wss://preview.example.test/#secret',
  ])
    expect(() => new Socket(address)).toThrow();
  expect(() => new Socket('/ws', ['duplicate', 'duplicate'])).toThrow();
  const socket = new Socket('/ws', ['json']);
  expect(() => socket.send('early')).toThrow();
  const connection = sent[0]!;
  expect(connection.data).toMatchObject({
    type: 'tm.websocket',
    path: '/ws',
    protocols: ['json'],
  });
  const outbound: Record<string, unknown>[] = [];
  connection.port.onmessage = (e) =>
    outbound.push(e.data as Record<string, unknown>);
  const messages: unknown[] = [];
  socket.onmessage = (e) => messages.push(e.data);
  connection.port.postMessage({ type: 'websocket.open', protocol: 'json' });
  expect(socket.readyState).toBe(1);
  expect(socket.protocol).toBe('json');
  connection.port.postMessage({
    type: 'websocket.message',
    text: true,
    data: new TextEncoder().encode('hello'),
  });
  expect(messages).toEqual(['hello']);
  expect(outbound.at(-1)).toEqual({ type: 'websocket.received' });
  socket.binaryType = 'arraybuffer';
  connection.port.postMessage({
    type: 'websocket.message',
    data: new Uint8Array([4, 5]),
  });
  expect(new Uint8Array(messages[1] as ArrayBuffer)).toEqual(
    new Uint8Array([4, 5]),
  );
  socket.send('request');
  await vi.waitFor(() =>
    expect(outbound.some((m) => m.type === 'websocket.message')).toBe(true),
  );
  expect(socket.bufferedAmount).toBe(7);
  connection.port.postMessage({ type: 'websocket.ack', bytes: 7 });
  expect(socket.bufferedAmount).toBe(0);
  expect(() => socket.send(new Uint8Array((1 << 20) + 1))).toThrow();
  expect(() => socket.close(1002)).toThrow();
  expect(() => socket.close(1000, 'x'.repeat(124))).toThrow();
  socket.close();
  expect(outbound.at(-1)).toEqual({
    type: 'websocket.close',
    code: 1000,
    reason: '',
  });
  connection.port.postMessage({ type: 'websocket.close', code: 1000 });
  expect(socket.readyState).toBe(3);
  socket.send('ignored');
});
it('same-origin test sockets remove only their own preview prefix', async () => {
  const prefix = '/.tailmouse/p/' + 'a'.repeat(32) + '/app';
  const { Socket, sent } = await shim(prefix);
  new Socket(prefix + '/hmr?token=synthetic');
  expect(sent[0]!.data.path).toBe('/hmr?token=synthetic');
  await expect(navigator.serviceWorker.register('/app-sw.js')).rejects.toThrow(
    'incompatible',
  );
});

async function serviceWorker(session = '') {
  const listeners = new Map<string, (event: Record<string, unknown>) => void>();
  const origin = 'https://preview.example.test';
  vi.stubGlobal(
    'location',
    new URL(
      origin + '/.tailmouse/sw.js' + (session ? '?session=' + session : ''),
    ),
  );
  vi.stubGlobal('clients', {
    claim: vi.fn(async () => undefined),
    matchAll: vi.fn(async () => []),
  });
  vi.stubGlobal(
    'addEventListener',
    (name: string, handler: (event: Record<string, unknown>) => void) =>
      listeners.set(name, handler),
  );
  vi.stubGlobal('MessageChannel', Channel);
  vi.resetModules();
  const workerModule = '../../content/sw.ts';
  await import(workerModule);
  const channel = new Channel();
  const bind = (path: string) =>
    listeners.get('message')!({
      data: { type: 'tm.bind', version: 1 },
      ports: [channel.port2],
      source: { url: origin + path },
    });
  const fetch = (request: Request) => {
    let response: Promise<Response> | undefined;
    let done: Promise<unknown> | undefined;
    listeners.get('fetch')!({
      request,
      respondWith(value: Response | Promise<Response>) {
        response = Promise.resolve(value);
      },
      waitUntil(value: Promise<unknown>) {
        done = value;
      },
    });
    return { response: () => response!, done: () => done };
  };
  return { channel, bind, fetch, origin, listeners };
}
it('preview HTTP forwards bounded bytes with credentials and strips response cookies', async () => {
  const sw = await serviceWorker('a'.repeat(32));
  const prefix = '/.tailmouse/p/' + 'a'.repeat(32);
  let forwarded: Record<string, unknown> | undefined;
  let stream: Port | undefined;
  sw.channel.port1.onmessage = (e) => {
    if (e.data.type !== 'http') return;
    forwarded = e.data as Record<string, unknown>;
    stream = e.ports[0] as unknown as Port;
    stream.onmessage = (message) => {
      if (message.data.type === 'body.end')
        stream!.postMessage({
          type: 'response',
          status: 200,
          headers: [
            ['Content-Type', 'text/event-stream'],
            ['Set-Cookie', 'private=secret'],
          ],
        });
    };
  };
  sw.bind(prefix + '/bridge.html');
  const transaction = sw.fetch(
    new Request(sw.origin + prefix + '/app/events?x=1', {
      credentials: 'omit',
    }),
  );
  const response = await transaction.response();
  expect(forwarded).toMatchObject({
    method: 'GET',
    path: '/events?x=1',
    credentials: 'omit',
  });
  expect(response.headers.get('set-cookie')).toBeNull();
  expect(response.headers.get('cache-control')).toBe('no-store');
  const reader = response.body!.getReader();
  stream!.postMessage({
    type: 'response.data',
    data: new TextEncoder().encode('data: ok\n\n'),
  });
  expect(new TextDecoder().decode((await reader.read()).value)).toBe(
    'data: ok\n\n',
  );
  stream!.postMessage({ type: 'response.end' });
  expect((await reader.read()).done).toBe(true);
  await transaction.done();
  expect(
    sw.fetch(new Request(sw.origin + '/.tailmouse/shim.js')).response(),
  ).toBeUndefined();
  for (const request of [
    new Request('https://foreign.invalid/'),
    { url: sw.origin + '/events', method: 'CONNECT' } as Request,
  ]) {
    expect((await sw.fetch(request).response()).status).toBe(403);
  }
});
it('preview HTTP cancellation closes its stream and uncertain writes remain visibly uncertain', async () => {
  const sw = await serviceWorker();
  sw.bind('/.tailmouse/bridge.html');
  let port: Port | undefined;
  const sent: unknown[] = [];
  sw.channel.port1.onmessage = (e) => {
    if (e.data.type === 'http') {
      port = e.ports[0] as unknown as Port;
      port.onmessage = (m) => sent.push(m.data);
      port.postMessage({ type: 'invalid' });
    }
  };
  const transaction = sw.fetch(
    new Request(sw.origin + '/write', { method: 'POST', body: 'one' }),
  );
  const response = await transaction.response();
  expect(response.status).toBe(503);
  expect(await response.text()).toContain('result is unknown');
  expect(sent).toContainEqual({ type: 'cancel' });
  await transaction.done();
});
