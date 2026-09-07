# Static Web hosting

Build from the recorded, clean Tailcat submodule:

```sh
pnpm exec node tools/tailcat-gate.mjs build
pnpm --filter @tailmouse/web build
```

Serve `apps/web/dist/` as static files over HTTPS. A self-hosted origin has no
TailMouse API, application backend or connection credential in this directory.
The V2 short-invitation API is an official-origin-only service and is not a
requirement or hidden fallback for self-hosting. Native TailMouse and browser
Wasm embed the same Tailcat gitlink. `web-manifest.json` records their
compatibility metadata and SHA-256 identities of generated files.

The self-hosted static origin never receives URL fragments. Its Escape,
protected Leash, and link-only invitations remain full fragments; do not copy
the official six-character locator path without implementing a separately
specified trust and lifecycle boundary. Protected Leash access codes stay
in the active page's memory and are converted into fresh challenge proofs inside
the encrypted session; they are not static configuration, object metadata or
server logs. Link-only invitations remain full-access bearer credentials and
must not be placed in paths, queries, redirects or deployment tooling.

Deploy one coherent manifest at a time. Escape uses wire identifier 1 and Leash
uses identifier 2; an old Leash browser or Host must fail before terminal data or
child startup rather than loading a compatibility shim. The official target is
`https://link.tailmouse.com/`; local self-hosting does not inherit its short-link
service, storage, deployment status, or trust boundary. The original R2
publication and reviewed rule set are defined in the
[Cloudflare publication runbook](cloudflare-r2-publication.md). Revision
`65d1c7458272` is verified R2-only publication evidence; the Worker cutover is
planned and unverified until its separate deployment evidence is recorded.
The root-domain and `www` website remain V3 work.

Official short links have a different storage boundary: Cloudflare can read
their full invitation in an active 15-minute mapping, renewed by the Host every
five minutes. It never receives the independent access code. Host-end deletion
and expiry make the mapping unavailable; Cloudflare's SQLite recovery window
is separate, so this is not a physical-erasure guarantee. The linked runbook
covers its 30-day PITR limitation, forbidden restoration of invitation backups,
outage handling, local abuse limits, and rollback. None of that storage is
required or created by this static self-hosting procedure.

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
session or terminal response. It also bypasses every short-invitation API
request and canonical short navigation; copying the Web directory does not
provide the official resolver or an offline invitation cache. Cached static files can be read offline; opening
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
