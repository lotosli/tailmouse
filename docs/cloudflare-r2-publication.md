# Cloudflare R2 static publication

This runbook defines the smallest production topology for the TailMouse Web
client: one dedicated Cloudflare R2 bucket, one custom domain
`link.tailmouse.com`, and Cloudflare's cache, compression, URL-rewrite and
response-header rules. It uses no Worker, Pages project, application backend,
redirect service, account identifier, API token or DNS credential in source.
Publication remains pending until the owner supplies authority for the selected
Cloudflare account, zone and bucket.

Cloudflare documents `r2.dev` as a rate-limited development endpoint and allows
an R2 bucket to use a custom domain without enabling it. Keep the bucket private
while staging, connect only `link.tailmouse.com`, and leave Public Development
URL access disabled. Do not create a CNAME to an `r2.dev` hostname.

## Release input

1. Start from a clean candidate with the recorded Tailcat submodule initialized.
2. Run `pnpm gate`, `pnpm build`, `pnpm release:snapshot`,
   `pnpm release:sbom` and `pnpm release:verify` locally in that order before
   any upload. A failure stops publication.
3. Treat `apps/web/dist/web-manifest.json` itself plus the exact keys under its
   `files` field as the complete upload allowlist. Each file entry supplies the
   required object `contentType`, `contentEncoding` when present, and
   `cacheControl`; `staticHosting.manifestObject` supplies the manifest's own
   metadata. Do not upload a local directory recursively, unlisted source maps,
   logs, environment files, invitations or credentials.
4. Upload content-named assets and their listed compressed variants first,
   followed by notices and metadata files. Upload `service-worker.js` and
   `index.html` last. Retain the preceding manifest's hashed objects until its
   active clients have aged out; never replace bytes at a content-named key.

The upload operation must assign HTTP metadata from the following table. It may
use an operator-owned dashboard or short-lived local tooling, but that tooling
and its credentials are not committed to this repository.

| Object class                                   | `Content-Type`                   | `Content-Encoding` | `Cache-Control`                                               |
| ---------------------------------------------- | -------------------------------- | ------------------ | ------------------------------------------------------------- |
| `index.html`                                   | `text/html; charset=utf-8`       | none               | `no-cache`                                                    |
| `service-worker.js`                            | `text/javascript; charset=utf-8` | none               | `no-cache`                                                    |
| `web-manifest.json` and source maps            | `application/json`               | none               | `no-cache` for the manifest; immutable for content-named maps |
| Content-named `.js`                            | `text/javascript; charset=utf-8` | none               | `public, max-age=31536000, immutable`                         |
| Content-named `.css`                           | `text/css; charset=utf-8`        | none               | `public, max-age=31536000, immutable`                         |
| Content-named `.wasm`                          | `application/wasm`               | none               | `public, max-age=31536000, immutable`                         |
| Listed `.br` variant                           | underlying uncompressed type     | `br`               | same as its underlying object                                 |
| Listed `.gz` variant                           | underlying uncompressed type     | `gzip`             | same as its underlying object                                 |
| `LICENSE`, `NOTICE`, `THIRD_PARTY_NOTICES.txt` | `text/plain; charset=utf-8`      | none               | `no-cache`                                                    |

Cloudflare supports `Content-Type`, `Content-Encoding` and `Cache-Control` as R2
HTTP object metadata. The listed `.br` and `.gz` files remain independently
verifiable release objects. Browser requests use the raw content-named path;
the Cloudflare compression rule below negotiates Brotli, then gzip, from the
browser's `Accept-Encoding` header without changing that path.

## Domain and rules

Connect the bucket's custom domain to `link.tailmouse.com` in the same
Cloudflare zone. Wait for the domain status to become Active, then verify that
Public Development URL access remains disabled. Configure the following rules
only for `http.host eq "link.tailmouse.com"`:

1. URL Rewrite Rule: when `http.request.uri.path eq "/"`, statically rewrite
   the path to `/index.html` and clear the query string. This is an internal
   rewrite, not a redirect, so an invitation fragment stays in the address bar
   until the application consumes it and never reaches Cloudflare. Do not add an
   SPA fallback; unknown object paths return 404.
2. Cache Rule for `/`, `/index.html`, `/service-worker.js`,
   `/web-manifest.json`, `/LICENSE`, `/NOTICE` and
   `/THIRD_PARTY_NOTICES.txt`: bypass edge caching and respect the objects'
   `no-cache` browser policy.
3. Cache Rule for requests whose path starts with `/assets/` or `/tailcat/`:
   make the response cache-eligible and respect origin `Cache-Control`. Only
   manifest-listed, content-named objects may exist under those prefixes.
4. Compression Rule for the custom hostname and successful JavaScript, CSS,
   JSON, text or `application/wasm` responses: prefer Brotli, then gzip; return
   the uncompressed representation if neither is accepted. Preserve
   `Vary: Accept-Encoding`.
5. Response Header Transform Rule: set the following values on all responses,
   including errors. Cache Rules, rather than this transform, control edge
   caching because response-header transforms run after cache evaluation.

| Header                    | Exact value                                                                                                                                                                                                    |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Content-Security-Policy` | `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'self' https: wss:; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'` |
| `Referrer-Policy`         | `no-referrer`                                                                                                                                                                                                  |
| `Permissions-Policy`      | `camera=(), microphone=(), geolocation=(), payment=(), usb=(), accelerometer=(self), gyroscope=(self), magnetometer=()`                                                                                        |
| `X-Content-Type-Options`  | `nosniff`                                                                                                                                                                                                      |

Set the R2 custom domain's `minTLS` value to `1.2`; the ordinary zone-level
Minimum TLS setting does not apply to R2 custom domains. Leave TLS 1.3 enabled.
Do not customize cipher suites without a separate compatibility decision.

## Verification and rollback

Before calling the publication complete, compare every public object and its
HTTP metadata with the local manifest, verify internal root rewriting and 404
routing, require TLS 1.1 to fail and TLS 1.2+ to succeed, and confirm that the
`r2.dev` endpoint is disabled. Record cold and warm transfers without an
invitation, then run one real macOS Host-to-browser official-DERP flow. The
repository's bounded public-origin verifier is the required independent check;
dashboard screenshots or successful uploads are not substitutes.

Run the verifier only after the reviewed rules are active:

```sh
pnpm verify:origin -- https://link.tailmouse.com/ apps/web/dist/web-manifest.json
```

The command rejects credentials, query strings and fragments; public origins
must use HTTPS. It makes only bounded `HEAD` and `GET` requests, never sends an
invitation, and emits a JSON report covering the selected address, negotiated
TLS, root and no-backend routing, exact object bytes and metadata, required
headers, and first/repeated raw-Wasm transfer timings. HTTP is accepted only for
the loopback test fixture.

If verification fails, stop. Restore the preceding `index.html` and
`service-worker.js` only if all of their referenced immutable objects still
exist, purge those two entry keys, and keep the failed objects for inspection
until their hashes are recorded. Do not deploy a Worker, alternate origin or
unverified asset to work around a failed rule.

Sources verified 2026-09-07:

- [Cloudflare R2 public buckets and custom domains](https://developers.cloudflare.com/r2/buckets/public-buckets/)
- [Cloudflare R2 object uploads and HTTP metadata](https://developers.cloudflare.com/r2/objects/upload-objects/)
- [Cloudflare URL Rewrite Rules](https://developers.cloudflare.com/rules/transform/url-rewrite/)
- [Cloudflare Cache Rules](https://developers.cloudflare.com/cache/how-to/cache-rules/)
- [Cloudflare Compression Rules](https://developers.cloudflare.com/rules/compression-rules/)
- [Cloudflare response-header transforms](https://developers.cloudflare.com/rules/transform/response-header-modification/)
- [Cloudflare R2 custom-domain TLS guidance](https://developers.cloudflare.com/r2/buckets/public-buckets/#minimum-tls-version--cipher-suites)
