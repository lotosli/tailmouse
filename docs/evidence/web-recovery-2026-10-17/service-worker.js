const __TAILMOUSE_STATIC_CACHE__ = {"version":"7946b10000c60cf7d2fbad0bf7e8b4b958a8b8e7aa75892643dfca12d127d1ca","assets":[{"path":"assets/index-Sm7q14NK.js","integrity":"sha256-0FyzZRGUvWGGfa/qFoFhNV0j3svb3iXaWGK5JawxHnQ="},{"path":"assets/index-kPuT16TY.css","integrity":"sha256-qKOb7BGdmPWYcJz/XczJKpuT+TJ41qel1vYXUUv1PQs="},{"path":"tailcat/tailcat-web-eac28adc6b2c97ee8850550aa0400b56791751bb9fa9ea1e19abd0b32abc747b.wasm","integrity":"sha256-6sKK3Gssl+6IUFUKoEALVnkXUbufqeoeGavQsyq8dHs="},{"path":"tailcat/wasm_exec-0c949f4996f9a89698e4b5c586de32249c3b69b7baadb64d220073cc04acba14.js","integrity":"sha256-DJSfSZb5qJaY5LXFht4yJJw7abe6rbZNIgBzzASsuhQ="}]};
const worker = self;
const prefix = `tailmouse-static:${new URL(worker.registration.scope).pathname}:`;
const name = `${prefix}${__TAILMOUSE_STATIC_CACHE__.version}`;
const assets = new Map(__TAILMOUSE_STATIC_CACHE__.assets.map((asset) => [new URL(asset.path, worker.registration.scope).href, asset.integrity]));
function requestFor(url, integrity) {
	return new Request(url, {
		credentials: "omit",
		referrerPolicy: "no-referrer",
		redirect: "error",
		cache: "force-cache",
		integrity
	});
}
worker.addEventListener("install", (event) => {
	event.waitUntil((async () => {
		try {
			const cache = await caches.open(name);
			await cache.addAll([...assets].map(([url, integrity]) => requestFor(url, integrity)));
		} catch (error) {
			await caches.delete(name);
			throw error;
		}
	})());
});
// Do not skipWaiting or claim live pages: a new build must not replace the
// asset set underneath an active terminal or game. Activation waits for them.
worker.addEventListener("activate", (event) => {
	event.waitUntil((async () => {
		for (const key of await caches.keys()) {
			if (key.startsWith(prefix) && key !== name) await caches.delete(key);
		}
	})());
});
worker.addEventListener("fetch", (event) => {
	const request = event.request;
	const url = new URL(request.url);
	// Locator navigation and its API never enter the application cache or a
	// worker-owned fetch. The browser performs the resolver's no-store request.
	if (/^\/[0-9A-Za-z]{6}$/u.test(url.pathname) || url.pathname.startsWith("/api/v1/short-invitations")) return;
	// Explicit network-only navigation preserves control in the supported
	// Firefox engine. No page response, request metadata or invitation is stored.
	if (request.mode === "navigate") {
		event.respondWith(fetch(request));
		return;
	}
	const integrity = assets.get(url.href);
	if (request.method !== "GET" || url.search !== "" || url.hash !== "" || integrity === undefined) return;
	event.respondWith((async () => {
		const cache = await caches.open(name);
		// Only install-time requests write to storage. Session traffic, page
		// navigations, query strings and unknown assets never enter this cache.
		return await cache.match(url.href) ?? fetch(requestFor(url.href, integrity));
	})());
});
