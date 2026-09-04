# Static Web hosting

Build from the recorded, clean Tailcat submodule:

```sh
pnpm exec node tools/tailcat-gate.mjs build
pnpm --filter @tailmouse/web build
```

Serve `apps/web/dist/` as static files over HTTPS. There is no TailMouse API,
application backend or connection credential in this directory. Native TailMouse
and browser Wasm embed the same Tailcat gitlink. `web-manifest.json` records their
compatibility metadata and SHA-256 identities of generated files.

## Nginx example

The minimal example uses the official Nginx 1.30.4 stable image with an exact
multi-platform digest, verified on 2026-09-03. The container only serves an
already-built directory; it does not compile source or run Tailcat.

```sh
docker build -f apps/web/Dockerfile -t tailmouse-web:local .
docker run --rm --read-only --tmpfs /tmp --cap-drop ALL \
  --security-opt no-new-privileges -p 127.0.0.1:8080:8080 tailmouse-web:local
```

The image runs as the unprivileged `nginx` user. Its PID and all Nginx temporary
paths use the command's `/tmp` tmpfs, so the image root remains read-only; omit
neither `--read-only` nor `--tmpfs /tmp` when using this example.

Use `http://localhost:8080` for a local secure-context test. Public deployment
needs operator-configured HTTPS. Setting a production domain, certificates or
publishing this image remains an operator action. Configure native `--web-base-url`
to that public HTTPS directory. A non-root mount must retain the trailing slash
and preserve all relative asset paths and the worker's directory scope.

`nginx.conf` supplies the PRD CSP, no-referrer, nosniff and restricted browser
permissions on successful and error responses. It serves only existing files,
rejects non-read methods and does not rewrite arbitrary paths to the app. Access
logging is off. Invitations belong exclusively in fragments, which are not HTTP
request targets; never put credentials in query strings or paths.

## Compression and cache policy

- Serve `.wasm` with `Content-Type: application/wasm`.
- Hashed JavaScript, CSS and Wasm get `Cache-Control: public, max-age=31536000, immutable`.
- HTML, the service worker, Web manifest and release manifest get `Cache-Control: no-cache`.
- The build emits `.gz` and `.br` alongside hashed assets. Nginx's included
  `gzip_static` support negotiates gzip and emits `Vary: Accept-Encoding`.
  Brotli-aware static hosts may serve `.br` with `Content-Encoding: br` and the
  original MIME type. Do not enable a nonexistent Nginx Brotli module or serve
  compressed bytes without the encoding header.
- Deploy each directory atomically and retain old hashed assets while old tabs
  may still use them. Never overwrite a content-named asset with different bytes.

The service worker precaches only its build-time hashed-resource allowlist with
integrity checks. It stores no HTML, navigation, query-string, relay, invitation,
session or terminal response. Cached static files can be read offline; opening
or reloading the HTML still requires the host, and a live session requires relay
connectivity. Cache registration failure is visible under About TailMouse and
does not prevent online operation.

A new worker waits until old TailMouse tabs close, then removes only obsolete
TailMouse caches in its own mount scope. It never takes over a running terminal.
The browser may evict caches; a missing allowed asset is fetched without adding
dynamic data to storage.

## Local verification

```sh
pnpm exec node --test tools/web-assets.test.ts
pnpm exec playwright test --config apps/web/playwright.config.ts tests/e2e/static-cache.spec.ts --max-failures=1
pnpm exec node tests/integration/static-web.mjs
```

The last command needs a native `nginx` with `gzip_static` on PATH. It starts and
stops only its own loopback process with temporary paths; it does not use a
system service or start a container engine. It checks headers on success/errors,
read-only routing, compression, file checksums and actual Tailcat Wasm startup.
It does not prove a Docker image run or a native terminal on another OS.

The static sensor header permits same-origin accelerometer/gyroscope access;
only Escape's explicit tilt action requests it. Leash does not subscribe to
sensors. Camera, microphone, geolocation, payment, USB and magnetometer are denied.
Static response headers cannot select a policy using a private invitation fragment.

Sources: [Nginx stable releases](https://nginx.org/en/download.html),
[static gzip](https://nginx.org/en/docs/http/ngx_http_gzip_static_module.html),
[header inheritance](https://nginx.org/en/docs/http/ngx_http_headers_module.html),
[service worker lifecycle](https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API/Using_Service_Workers).
