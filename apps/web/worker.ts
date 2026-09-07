declare const __TAILMOUSE_STATIC_CACHE__: {
  version: string;
  assets: readonly { path: string; integrity: string }[];
};

declare const self: ServiceWorkerGlobalScope;
const worker = self;
const prefix = `tailmouse-static:${new URL(worker.registration.scope).pathname}:`;
const name = `${prefix}${__TAILMOUSE_STATIC_CACHE__.version}`;
const assets = new Map(
  __TAILMOUSE_STATIC_CACHE__.assets.map((asset) => [
    new URL(asset.path, worker.registration.scope).href,
    asset.integrity,
  ]),
);

function requestFor(url: string, integrity: string): Request {
  return new Request(url, {
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
    redirect: 'error',
    cache: 'force-cache',
    integrity,
  });
}

worker.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      try {
        const cache = await caches.open(name);
        await cache.addAll(
          [...assets].map(([url, integrity]) => requestFor(url, integrity)),
        );
      } catch (error: unknown) {
        await caches.delete(name);
        throw error;
      }
    })(),
  );
});

// Do not skipWaiting or claim live pages: a new build must not replace the
// asset set underneath an active terminal or game. Activation waits for them.
worker.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) {
        if (key.startsWith(prefix) && key !== name) await caches.delete(key);
      }
    })(),
  );
});

worker.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  // Locator navigation and its API never enter the application cache or a
  // worker-owned fetch. The browser performs the resolver's no-store request.
  if (
    /^\/[0-9A-Za-z]{6}$/u.test(url.pathname) ||
    url.pathname.startsWith('/api/v1/short-invitations')
  )
    return;
  // Explicit network-only navigation preserves control in the supported
  // Firefox engine. No page response, request metadata or invitation is stored.
  if (request.mode === 'navigate') {
    event.respondWith(fetch(request));
    return;
  }
  const integrity = assets.get(url.href);
  if (
    request.method !== 'GET' ||
    url.search !== '' ||
    url.hash !== '' ||
    integrity === undefined
  )
    return;
  event.respondWith(
    (async () => {
      const cache = await caches.open(name);
      // Only install-time requests write to storage. Session traffic, page
      // navigations, query strings and unknown assets never enter this cache.
      return (
        (await cache.match(url.href)) ?? fetch(requestFor(url.href, integrity))
      );
    })(),
  );
});
