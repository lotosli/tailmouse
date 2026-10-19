(() => {
  const query = new URLSearchParams(location.search);
  const parentOrigin = query.get('parent');
  if (
    parentOrigin === null ||
    new URL(parentOrigin).origin !== parentOrigin ||
    !parentOrigin.startsWith('https://') ||
    window.parent === window
  )
    throw new Error('Open this preview from its TailMouse workspace.');
  const app = document.querySelector<HTMLIFrameElement>('#application');
  if (app === null) throw new Error('Preview frame missing.');
  if (!('serviceWorker' in navigator)) {
    const status = document.querySelector('#loading');
    if (status !== null)
      status.textContent =
        'This browser cannot isolate web previews. Service Workers are required.';
    return;
  }
  const testPath = /^\/\.tailmouse\/p\/([a-f0-9]{32})\/bridge\.html$/u.exec(
    location.pathname,
  );
  const scopePath = testPath === null ? '/' : `/.tailmouse/p/${testPath[1]}/`;
  const appPath = testPath === null ? '' : `${scopePath}app`;
  const applicationURL = (path: string): string => appPath + path;
  let trusted: MessagePort | undefined;
  let initialized = false;
  let binding: Promise<void> | undefined;
  let workerPort: MessagePort | undefined;
  async function bindWorker(): Promise<void> {
    const registration = await navigator.serviceWorker.ready;
    const worker = navigator.serviceWorker.controller ?? registration.active;
    if (worker === null) throw new Error('Preview worker unavailable.');
    const channel = new MessageChannel();
    workerPort?.close();
    workerPort = channel.port1;
    const bound = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        channel.port1.close();
        reject(new Error('Preview binding timed out.'));
      }, 5000);
      channel.port1.onmessage = (
        event: MessageEvent<{ type?: string }>,
      ): void => {
        if (event.data.type === 'bound') {
          clearTimeout(timer);
          resolve();
          return;
        }
        const port = event.ports[0];
        if (
          trusted === undefined ||
          port === undefined ||
          event.data.type !== 'http'
        ) {
          port?.close();
          return;
        }
        trusted.postMessage(event.data, [port]);
      };
    });
    worker.postMessage({ type: 'tm.bind', version: 1 }, [channel.port2]);
    await bound;
  }
  navigator.serviceWorker.addEventListener(
    'message',
    (event: MessageEvent<{ type?: string }>) => {
      if (event.data?.type === 'tm.rebind' && initialized) {
        binding = bindWorker();
        void binding.catch(showFailure);
      }
    },
  );
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (initialized) {
      binding = bindWorker();
      void binding.catch(showFailure);
    }
  });
  window.addEventListener('message', (event: MessageEvent<unknown>) => {
    const value = event.data as {
      type?: unknown;
      version?: unknown;
      path?: unknown;
      command?: unknown;
    };
    if (
      event.source === app.contentWindow &&
      event.origin === location.origin &&
      value?.type === 'tm.unsupported'
    ) {
      trusted?.postMessage({ type: 'tm.bridge.incompatible' });
      return;
    }
    if (
      event.source === app.contentWindow &&
      event.origin === location.origin &&
      value?.type === 'tm.websocket'
    ) {
      const port = event.ports[0];
      if (trusted !== undefined && port !== undefined)
        trusted.postMessage({ ...value, type: 'websocket' }, [port]);
      return;
    }
    if (
      event.source !== window.parent ||
      event.origin !== parentOrigin ||
      value?.type !== 'tm.bridge.init' ||
      value.version !== 1 ||
      initialized ||
      event.ports.length !== 1
    )
      return;
    initialized = true;
    trusted = event.ports[0]!;
    trusted.onmessage = (
      message: MessageEvent<{ type?: string; command?: string; path?: string }>,
    ) => {
      if (message.data.type === 'dispose') {
        app.src = 'about:blank';
        workerPort?.close();
        trusted?.close();
        // Native revocation is authoritative even if browser cleanup cannot finish.
        void (async () => {
          const registration =
            await navigator.serviceWorker.getRegistration(scopePath);
          await registration?.unregister();
          if (testPath === null) {
            for (const name of await caches.keys()) await caches.delete(name);
            localStorage.clear();
            sessionStorage.clear();
          }
        })().catch(() => undefined);
        return;
      }
      if (message.data.type !== 'navigate') return;
      switch (message.data.command) {
        case 'back':
          app.contentWindow?.history.back();
          break;
        case 'forward':
          app.contentWindow?.history.forward();
          break;
        case 'reload':
          app.contentWindow?.location.reload();
          break;
        case 'path':
          if (safePath(message.data.path))
            app.src = applicationURL(message.data.path);
          break;
      }
    };
    void (async () => {
      if (!('serviceWorker' in navigator))
        throw new Error('This browser cannot isolate web previews.');
      await navigator.serviceWorker.register(
        `/.tailmouse/sw.js${testPath === null ? '' : '?session=' + testPath[1]}`,
        {
          scope: scopePath,
          type: 'module',
          updateViaCache: 'none',
        },
      );
      await navigator.serviceWorker.ready;
      if (navigator.serviceWorker.controller === null)
        await new Promise<void>((resolve) =>
          navigator.serviceWorker.addEventListener(
            'controllerchange',
            () => resolve(),
            { once: true },
          ),
        );
      binding = bindWorker();
      await binding;
      trusted!.postMessage({ type: 'tm.bridge.controlled' });
      app.src = applicationURL(safePath(value.path) ? value.path : '/');
      document.querySelector('#loading')?.remove();
    })().catch(showFailure);
  });
  function safePath(value: unknown): value is string {
    return (
      typeof value === 'string' &&
      value.startsWith('/') &&
      !value.startsWith('//') &&
      !value.startsWith('/.tailmouse/') &&
      !value.includes('\\') &&
      !Array.from(value).some((c) => c.charCodeAt(0) < 32)
    );
  }
  function showFailure(): void {
    const status = document.querySelector('#loading');
    if (status !== null)
      status.textContent =
        'Preview could not start. Check browser capabilities and reconnect from the workspace.';
  }
  // Retry only the public bootstrap signal while the workspace mounts its listener.
  let attempts = 0;
  const ready = (): void => {
    if (initialized || attempts++ >= 20) return;
    window.parent.postMessage(
      { type: 'tm.bridge.ready', version: 1 },
      parentOrigin!,
    );
    setTimeout(ready, 250);
  };
  ready();
})();
