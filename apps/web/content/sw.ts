(() => {
  const scope = globalThis as unknown as ServiceWorkerGlobalScope;
  const session = new URLSearchParams(scope.location.search ?? '').get(
    'session',
  );
  if (session !== null && !/^[a-f0-9]{32}$/u.test(session))
    throw new Error('Invalid preview scope.');
  const testPrefix = session === null ? '' : `/.tailmouse/p/${session}/`;
  const bridgePath =
    testPrefix === '' ? '/.tailmouse/bridge.html' : `${testPrefix}bridge.html`;
  let active = 0;
  let bridge: MessagePort | undefined;
  let binding: (() => void)[] = [];
  scope.addEventListener('activate', (event) => {
    event.waitUntil(scope.clients.claim());
  });
  scope.addEventListener('message', (event) => {
    const value = event.data as { type?: unknown; version?: unknown };
    const source = event.source as Client | null;
    if (
      value?.type !== 'tm.bind' ||
      value.version !== 1 ||
      event.ports.length !== 1 ||
      source === null ||
      new URL(source.url).origin !== scope.location.origin ||
      new URL(source.url).pathname !== bridgePath
    )
      return;
    bridge?.close();
    bridge = event.ports[0]!;
    bridge.postMessage({ type: 'bound' });
    for (const resolve of binding) resolve();
    binding = [];
  });
  async function ensureBridge(): Promise<MessagePort> {
    if (bridge !== undefined) return bridge;
    const clients = await scope.clients.matchAll({
      type: 'window',
      includeUncontrolled: true,
    });
    for (const client of clients)
      if (new URL(client.url).pathname === bridgePath)
        client.postMessage({ type: 'tm.rebind' });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        binding = binding.filter((v) => v !== done);
        reject(new Error('Preview needs its workspace.'));
      }, 5000);
      const done = (): void => {
        clearTimeout(timer);
        resolve();
      };
      binding.push(done);
    });
    if (bridge === undefined) throw new Error('Preview unavailable.');
    return bridge;
  }
  scope.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);
    if (
      url.origin === scope.location.origin &&
      url.pathname.startsWith('/.tailmouse/') &&
      !(testPrefix !== '' && url.pathname.startsWith(`${testPrefix}app/`))
    )
      return;
    if (
      url.origin !== scope.location.origin ||
      !['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(
        event.request.method,
      )
    ) {
      event.respondWith(
        new Response('This preview permits only its shared origin.', {
          status: 403,
          headers: { 'Cache-Control': 'no-store' },
        }),
      );
      return;
    }
    if (active >= 16) {
      event.respondWith(
        new Response('Preview request limit reached.', {
          status: 503,
          headers: { 'Cache-Control': 'no-store' },
        }),
      );
      return;
    }
    active++;
    const operation = forward(event.request);
    event.respondWith(
      operation
        .then((value) => value.response)
        .catch(
          () =>
            new Response(
              ['GET', 'HEAD'].includes(event.request.method)
                ? 'Preview unavailable. Return to the TailMouse workspace and reconnect.'
                : 'Request result is unknown. Verify the application state before retrying.',
              { status: 503, headers: { 'Cache-Control': 'no-store' } },
            ),
        ),
    );
    event.waitUntil(
      operation
        .then((value) => value.done)
        .catch(() => undefined)
        .finally(() => {
          active--;
        }),
    );
  });
  async function forward(
    request: Request,
  ): Promise<{ response: Response; done: Promise<void> }> {
    const parent = await ensureBridge();
    const channel = new MessageChannel();
    const port = channel.port1;
    const url = new URL(request.url);
    let bodyAck: (() => void) | undefined;
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    let ended = false;
    let receivedResponse = false;
    let bodyReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let complete!: () => void;
    const done = new Promise<void>((resolve) => {
      complete = resolve;
    });
    let timer = setTimeout(cancel, 30_000);
    const refresh = (): void => {
      clearTimeout(timer);
      if (!receivedResponse) timer = setTimeout(cancel, 30_000);
    };
    let rejectResponse!: (reason: Error) => void;
    function cancel(): void {
      if (ended) return;
      ended = true;
      clearTimeout(timer);
      port.postMessage({ type: 'cancel' });
      port.close();
      bodyAck?.();
      void bodyReader?.cancel().catch(() => undefined);
      controller?.error(new Error('Preview connection interrupted.'));
      rejectResponse?.(new Error('Preview unavailable.'));
      complete();
    }
    request.signal.addEventListener('abort', cancel, { once: true });
    const response = new Promise<Response>((resolve, reject) => {
      rejectResponse = reject;
      port.onmessage = (
        event: MessageEvent<{
          type?: string;
          status?: number;
          headers?: [string, string][];
          data?: Uint8Array;
        }>,
      ) => {
        refresh();
        const value = event.data;
        if (value.type === 'body.ack') {
          const ack = bodyAck;
          bodyAck = undefined;
          ack?.();
          return;
        }
        if (
          value.type === 'response' &&
          !receivedResponse &&
          typeof value.status === 'number' &&
          Array.isArray(value.headers)
        ) {
          receivedResponse = true;
          clearTimeout(timer);
          const headers = new Headers(value.headers);
          headers.set('Cache-Control', 'no-store');
          headers.delete('Set-Cookie');
          const noBody =
            request.method === 'HEAD' || [204, 205, 304].includes(value.status);
          const body = noBody
            ? null
            : new ReadableStream<Uint8Array>(
                {
                  start(c) {
                    controller = c;
                  },
                  pull() {
                    port.postMessage({ type: 'response.ack' });
                  },
                  cancel,
                },
                { highWaterMark: 1 },
              );
          resolve(new Response(body, { status: value.status, headers }));
          return;
        }
        if (
          value.type === 'response.data' &&
          value.data instanceof Uint8Array &&
          value.data.length <= 32768 &&
          controller !== undefined
        ) {
          controller.enqueue(value.data);
          return;
        }
        if (value.type === 'response.end') {
          ended = true;
          clearTimeout(timer);
          request.signal.removeEventListener('abort', cancel);
          controller?.close();
          port.close();
          complete();
          return;
        }
        cancel();
      };
    });
    parent.postMessage(
      {
        type: 'http',
        method: request.method,
        credentials: request.credentials,
        path:
          (testPrefix !== '' && url.pathname.startsWith(`${testPrefix}app/`)
            ? url.pathname.slice(`${testPrefix}app`.length)
            : url.pathname) + url.search,
        headers: [...request.headers],
      },
      [channel.port2],
    );
    void (async () => {
      const reader = request.body?.getReader();
      bodyReader = reader;
      try {
        if (reader !== undefined) {
          while (!ended) {
            const part = await reader.read();
            if (part.done) break;
            for (let i = 0; i < part.value.length; i += 32768) {
              if (ended) return;
              const bytes = part.value.slice(i, i + 32768);
              const acknowledged = new Promise<void>((resolve) => {
                bodyAck = resolve;
              });
              port.postMessage({ type: 'body', data: bytes }, [bytes.buffer]);
              await acknowledged;
            }
          }
        }
        if (!ended) port.postMessage({ type: 'body.end' });
      } catch {
        cancel();
      } finally {
        reader?.releaseLock();
      }
    })();
    return { response: await response, done };
  }
})();
