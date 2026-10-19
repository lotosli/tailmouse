(() => {
  const prefix =
    document.currentScript?.getAttribute('data-tailmouse-prefix') ?? '';
  const testPrefix = /^\/\.tailmouse\/p\/[a-f0-9]{32}\/app$/u.test(prefix)
    ? prefix
    : '';
  const previewURL = (value: string | URL): string => {
    const target = new URL(value, location.href);
    if (
      target.origin !== location.origin ||
      target.pathname.startsWith(testPrefix + '/')
    )
      return target.href;
    target.pathname = testPrefix + target.pathname;
    return target.href;
  };
  if (testPrefix !== '') {
    for (const method of ['pushState', 'replaceState'] as const) {
      const original = history[method].bind(history);
      history[method] = (
        data: unknown,
        unused: string,
        url?: string | URL | null,
      ): void => original(data, unused, url == null ? url : previewURL(url));
    }
    document.addEventListener(
      'click',
      (event) => {
        const target =
          event.target instanceof Element
            ? event.target.closest('a[href]')
            : null;
        if (
          target instanceof HTMLAnchorElement &&
          target.target !== '_blank' &&
          new URL(target.href).origin === location.origin
        )
          target.href = previewURL(target.href);
      },
      true,
    );
    document.addEventListener(
      'submit',
      (event) => {
        if (
          event.target instanceof HTMLFormElement &&
          new URL(event.target.action).origin === location.origin
        )
          event.target.action = previewURL(event.target.action);
      },
      true,
    );
  }
  const redirected = document.currentScript?.getAttribute(
    'data-tailmouse-path',
  );
  if (redirected?.startsWith('/') === true && !redirected.startsWith('//'))
    history.replaceState(null, '', redirected);

  if ('serviceWorker' in navigator) {
    Object.defineProperty(navigator.serviceWorker, 'register', {
      configurable: false,
      writable: false,
      value: () => {
        window.parent.postMessage(
          { type: 'tm.unsupported', feature: 'application-service-worker' },
          location.origin,
        );
        return Promise.reject(
          new DOMException(
            'Application Service Workers are incompatible with this isolated preview.',
            'NotSupportedError',
          ),
        );
      },
    });
  }

  // Installed synchronously before upstream scripts. Only main-thread sockets
  // are supported; workers, custom service workers and multiple origins are W3.
  class SharedSocket extends EventTarget {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;
    readonly CONNECTING = 0;
    readonly OPEN = 1;
    readonly CLOSING = 2;
    readonly CLOSED = 3;
    readonly url: string;
    readonly extensions = '';
    protocol = '';
    readyState = 0;
    bufferedAmount = 0;
    binaryType: BinaryType = 'blob';
    onopen: ((event: Event) => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;
    onclose: ((event: CloseEvent) => void) | null = null;
    readonly #port: MessagePort;
    #sending: Promise<void> = Promise.resolve();
    constructor(value: string | URL, protocols: string | string[] = []) {
      super();
      const url = new URL(value, location.href);
      if (url.protocol === 'http:') url.protocol = 'ws:';
      if (url.protocol === 'https:') url.protocol = 'wss:';
      if (
        !['ws:', 'wss:'].includes(url.protocol) ||
        url.host !== location.host ||
        url.username !== '' ||
        url.password !== '' ||
        url.hash !== ''
      )
        throw new DOMException(
          'Only the shared origin is available.',
          'SecurityError',
        );
      this.url = url.href;
      const list = typeof protocols === 'string' ? [protocols] : protocols;
      if (
        list.length > 16 ||
        new Set(list).size !== list.length ||
        list.some((p) => !/^[-!#$%&'*+.^_`|~0-9A-Za-z]+$/u.test(p))
      )
        throw new DOMException('Invalid subprotocol.', 'SyntaxError');
      const channel = new MessageChannel();
      this.#port = channel.port1;
      this.#port.onmessage = (
        event: MessageEvent<{
          type?: string;
          protocol?: string;
          text?: boolean;
          data?: Uint8Array;
          bytes?: number;
          code?: number;
          reason?: string;
        }>,
      ) => {
        const m = event.data;
        if (m.type === 'websocket.open' && this.readyState === 0) {
          this.protocol = m.protocol ?? '';
          this.readyState = 1;
          const e = new Event('open');
          this.dispatchEvent(e);
          this.onopen?.(e);
          return;
        }
        if (m.type === 'websocket.ack' && typeof m.bytes === 'number') {
          this.bufferedAmount = Math.max(0, this.bufferedAmount - m.bytes);
          return;
        }
        if (
          m.type === 'websocket.message' &&
          m.data instanceof Uint8Array &&
          this.readyState === 1
        ) {
          const data =
            m.text === true
              ? new TextDecoder().decode(m.data)
              : this.binaryType === 'arraybuffer'
                ? m.data.slice().buffer
                : new Blob([m.data.slice().buffer]);
          const e = new MessageEvent('message', {
            data,
            origin: location.origin,
          });
          this.dispatchEvent(e);
          try {
            this.onmessage?.(e);
          } finally {
            this.#port.postMessage({ type: 'websocket.received' });
          }
          return;
        }
        if (m.type !== 'websocket.close') {
          const e = new Event('error');
          this.dispatchEvent(e);
          this.onerror?.(e);
        }
        this.readyState = 3;
        this.#port.close();
        const e = new CloseEvent('close', {
          code: m.code ?? 1006,
          reason: m.reason ?? '',
          wasClean: m.code === 1000,
        });
        this.dispatchEvent(e);
        this.onclose?.(e);
      };
      window.parent.postMessage(
        {
          type: 'tm.websocket',
          path:
            (testPrefix !== '' && url.pathname.startsWith(testPrefix + '/')
              ? url.pathname.slice(testPrefix.length)
              : url.pathname) + url.search,
          protocols: list,
        },
        location.origin,
        [channel.port2],
      );
    }
    send(value: string | ArrayBufferLike | Blob | ArrayBufferView): void {
      if (this.readyState === 0)
        throw new DOMException('Socket is connecting.', 'InvalidStateError');
      if (this.readyState !== 1) return;
      const size =
        typeof value === 'string'
          ? new TextEncoder().encode(value).length
          : value instanceof Blob
            ? value.size
            : ArrayBuffer.isView(value)
              ? value.byteLength
              : value.byteLength;
      if (size > 1 << 20 || this.bufferedAmount + size > 1 << 20)
        throw new DOMException(
          'Socket buffer limit reached.',
          'QuotaExceededError',
        );
      this.bufferedAmount += size;
      this.#sending = this.#sending
        .then(async () => {
          const data =
            typeof value === 'string'
              ? new TextEncoder().encode(value)
              : value instanceof Blob
                ? new Uint8Array(await value.arrayBuffer())
                : ArrayBuffer.isView(value)
                  ? new Uint8Array(
                      value.buffer,
                      value.byteOffset,
                      value.byteLength,
                    ).slice()
                  : new Uint8Array(value).slice();
          if (this.readyState === 1)
            this.#port.postMessage(
              {
                type: 'websocket.message',
                text: typeof value === 'string',
                data,
              },
              [data.buffer],
            );
        })
        .catch(() => this.close(3000, 'Send failed'));
    }
    close(code = 1000, reason = ''): void {
      if (code !== 1000 && (code < 3000 || code > 4999))
        throw new DOMException('Invalid close code.', 'InvalidAccessError');
      if (new TextEncoder().encode(reason).length > 123)
        throw new DOMException('Close reason too long.', 'SyntaxError');
      if (this.readyState >= 2) return;
      this.readyState = 2;
      this.#port.postMessage({ type: 'websocket.close', code, reason });
    }
  }
  Object.defineProperty(window, 'WebSocket', {
    value: SharedSocket,
    writable: true,
    configurable: true,
  });
})();
