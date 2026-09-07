# Cloudflare publication and rollback

This runbook records the original static-only production topology for the
TailMouse Web client: one dedicated Cloudflare R2 bucket, one custom domain
`link.tailmouse.com`, and Cloudflare cache, compression, URL-rewrite and
response-header rules. Clean revision `65d1c7458272` was published and verified
with this topology on 2026-09-07. The accepted V2 protected-short-invitation
change adds a narrowly scoped Worker and SQLite Durable Object in front of
the same exact R2 objects. The Worker procedure below is planned deployment
guidance, not evidence that the short-link service is live. Record its exact
deployed revision and acceptance results before changing that status.

The repository stores no account identifier, API token, DNS credential,
invitation, access code, or management capability. The future edge may retain a
full protected-Leash invitation in its active plaintext mapping only for a
renewable 15-minute lease. It never receives the separate access code. Active
mapping deletion is distinct from Cloudflare recovery-copy retention, described
below. Escape, link-only, and self-hosted invitations remain URL fragments and
do not enter that service. The root-domain and `www` website remain V3 work.

## Invitation lifecycle and trust

The operator and Cloudflare can read a short link's complete invitation while
its mapping is active. The six-character, case-sensitive Base62 path is only a
locator; protected Host authentication remains mandatory. The Host holds a
separate random management capability in memory, and the object stores only its
hash. Neither that capability nor the independent access code belongs in URLs,
logs, traces, analytics, error messages, deployment commands, or retained test
evidence. The browser submits a challenge proof to the Host through Tailcat;
the short-link API never receives that proof or relays terminal traffic.

The Host renews every five minutes; each successful renewal grants 15 minutes
from renewal. Browser reads do not extend it. Revocation, configured session
expiry, post-exit retention completion, and Host shutdown request immediate
authenticated deletion. A crash or lost connection leaves the last lease as
the deadline. Reads and renewals reject an expired mapping even if its deletion
alarm is delayed; the alarm and expiry checks remove active state, with bounded
cleanup retries on failure.

Cloudflare documents SQLite Durable Object point-in-time recovery over the
preceding 30 days. Consequently, a 15-minute lease and `deleteAll()` do not prove
physical erasure or erasure of provider recovery copies within 15 minutes.
TailMouse creates no invitation archive or recovery API. Operators must never
restore invitation storage from PITR, exports, or historical backups; rollback
restores code and static assets, not invitation data. This provider retention
boundary remains an explicit limitation, not a verified erasure guarantee.
[Cloudflare SQLite storage and PITR](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#pitr-point-in-time-recovery-api).

Official protected-Leash creation fails before child startup if publication
fails; it does not silently emit a full invitation. Renewal uses bounded
attempts and backoff and closes remote access if the lease cannot be preserved
safely. Existing local-process termination policies still apply. A failed
shutdown deletion leaves alarm expiry as the backstop. Browser resolution
failure displays a generic unavailable result, clears its input, and performs
no Tailcat dial. Full-fragment sessions need no resolver API, but still need
their static origin and relay connectivity.

## Bounded service configuration

`apps/link-edge/wrangler.jsonc` is the deployment source: Worker
`tailmouse-link-edge`, route `link.tailmouse.com/*`, R2 binding `STATIC_ASSETS`
to `tailmouse-link-production`, and SQLite class `ShortInvitation` through
`SHORT_INVITATIONS`. The declared class export establishes its storage backend;
confirm the deployed namespace/class transition rather than inferring it from
a successful local build. Keep `workers_dev`, preview URLs, observability,
Logpush, and Wrangler telemetry disabled as configured.

| Bound                           | Configured value and scope                                                                                       |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Create rate                     | 5 requests per 60 seconds per source IP in one edge location; 100 per 60 seconds across that location            |
| Resolve, renew, and delete rate | 60 requests per 60 seconds per source IP in one edge location; 1000 per 60 seconds across that location          |
| API concurrency                 | 64 in-flight operations per isolate, with no waiting queue                                                       |
| API time and size               | 10-second work deadline; request and response bodies at most 2048 bytes; full invitation shorter than 1400 bytes |
| Allocation                      | At most eight attempts; never overwrite an existing mapping or allocate a manifest-listed static filename        |
| Worker execution                | 50 ms CPU and 20 subrequests per invocation in the reviewed configuration                                        |

Rate-limit namespaces `8101`–`8104` must be reserved for these four bindings in
the account. Keys contain neither a locator nor invitation/management material.
Over-limit API calls receive 429 and `Retry-After: 60`; missing or failing
required bindings fail closed. Shared NATs can exhaust a source-IP allowance.
These counters are local and eventually consistent, not strict global quotas,
global concurrency limits, or billing caps. Review aggregate request/storage
usage and account billing without collecting invitation-bearing traces; abuse
can still incur Worker, Durable Object, and R2 charges.
[Cloudflare rate-limit locality and accuracy](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/#locality).

Cloudflare documents `r2.dev` as a rate-limited development endpoint and allows
an R2 bucket to use a custom domain without enabling it. Keep the bucket private
while staging a new bucket, connect only `link.tailmouse.com`, and leave Public
Development URL access disabled. The existing production domain remains online
during candidate preparation. Do not create a CNAME to an `r2.dev` hostname.

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

Retained prior objects are rollback input, not an expanded Worker allowlist.
The Worker serves only its embedded current manifest: an in-flight older page
requesting an uncached obsolete hash can receive 404 after cutover and must
reopen its original invitation on the new client. Existing complete browser
static caches remain independently scoped. Do not claim zero-downtime asset
handoff or historical-asset availability through the new Worker. Coordinate
mutable entry uploads and route changes inside the accepted cutover window;
an older Worker rejects mutable bytes that no longer match its own manifest.

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
| Listed `.br` variant                           | underlying uncompressed type     | `br`               | underlying immutable policy plus `no-transform`               |
| Listed `.gz` variant                           | underlying uncompressed type     | `gzip`             | underlying immutable policy plus `no-transform`               |
| `LICENSE`, `NOTICE`, `THIRD_PARTY_NOTICES.txt` | `text/plain; charset=utf-8`      | none               | `no-cache`                                                    |

Cloudflare supports `Content-Type`, `Content-Encoding` and `Cache-Control` as R2
HTTP object metadata. The listed `.br` and `.gz` files remain independently
verifiable release objects. Their origin metadata includes `no-transform` so
Cloudflare does not decode or recompress those evidence objects. Browser
requests use the raw content-named path; the Cloudflare compression rule below
negotiates Brotli, then gzip, from the browser's `Accept-Encoding` header without
changing that path.

## Historical R2-only domain and rules

These are the rules verified for `65d1c7458272`. Preserve their rollback values;
use the Worker cutover procedure below when activating short links.

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

## Worker cutover

1. Complete the release-input checks above and record the preceding static
   manifest, entry-object hashes, domain settings, and hostname-scoped rule and
   route configuration. These records contain no invitation data. Keep all
   immutable objects needed by both releases available in the existing bucket.
2. Run the local edge build and integration suite against the matching Web
   output. The build verifies and embeds that exact static allowlist; it is a
   Wrangler dry run and does not publish anything:

   ```sh
   pnpm --filter @tailmouse/link-edge build
   pnpm --filter @tailmouse/link-edge test:integration
   ```

3. Review the release configuration for the exact R2 binding, SQLite export
   and namespace, four rate bindings, runtime limits, and disabled alternate
   endpoints/logging. Use the pinned workspace Wrangler; do not replace its
   configuration with dashboard-edited application code. Deploying with the
   configured `link.tailmouse.com/*` route is a production cutover, not a
   staging command:

   ```sh
   node tools/link-edge-release.mjs verify
   pnpm --filter @tailmouse/link-edge exec wrangler deploy dist/index.js --no-bundle --config wrangler.jsonc
   ```

4. During the reviewed cutover, retain the R2 custom-domain origin and bind the
   Worker route to the existing hostname. Disable the historical root rewrite
   once the Worker owns root routing. Change the existing mutable-document
   cache rule to bypass all paths outside `/assets/` and `/tailcat/` on this
   hostname. Keep the immutable-asset rule and all security headers. Set the
   existing hostname compression rule to **Disable compression**: the Worker
   already selects the exact precompressed representation from the original
   client encoding header and returns it with `no-transform`, so Cloudflare
   must not recompress it. This also excludes every short/API response from
   default compression, without adding another rule. All locator/API successes
   and failures use `no-store`. Keep minimum TLS 1.2, TLS 1.3, and disabled
   `r2.dev` access. The exact domain/rule interaction is verified during this
   cutover; the R2-only evidence does not prove Worker behavior. Preserve all
   three prior rule values for rollback before saving changes.
5. Verify the deployed Worker identity, storage backend and bindings before
   releasing the new official protected-Leash CLI default. Compare every static
   object and its HTTP metadata with the matching manifest, including raw,
   gzip, and Brotli Wasm. A short path serves the same verified `index.html`
   bytes with `no-store`; manifest-listed names such as `NOTICE` retain static
   precedence. Other unknown paths remain 404. Full fragments produce no API
   request and never become redirects, R2 metadata, or server-visible material.
6. Use only synthetic, nonfunctional invitation fixtures for production API
   checks: create, exact-case resolution, an unallocated case variant,
   non-renewing reads, renewal, immediate deletion from a separate request
   context, and expiry without browser traffic. Verify the 15-minute active
   expiry separately from delayed alarm cleanup and provider PITR; do not
   shorten production leases to speed acceptance. Delete remaining synthetic
   mappings and retain only redacted outcomes. Finish with a real macOS
   protected Host/browser flow whose credentials never enter retained output.

Any missing or failed publication check stops release and invokes rollback.
Local tests, an uploaded bundle, or an attached route do not establish public
short-link availability. Record the verified revision and results in
`docs/evidence/prd-conformance.md`; Linux, Windows, and physical-device runtime
evidence stays deferred until its environment is supplied.

After those deployment checks pass, the explicit macOS public-flow probe runs
from a non-PTY task shell (an ordinary controlling terminal is rejected so
credentials cannot escape the owned capture):

```sh
TAILMOUSE_PUBLIC_SHORT_ACCEPTANCE=1 GOWORK=off go test \
  -tags=tailcatintegration -count=1 -failfast -v -timeout=4m \
  -run='^TestOfficialShortLeashBrowser$' ./apps/cli/cmd/tailmouse
```

It uses the real CLI owner, official Tailcat relay selection, public Web origin
with ordinary TLS verification, separately entered access code, independently
decoded compact QR, isolated zsh I/O, same-process fresh-context reconnect and
Host-end deletion. It does not use or replace the owner's manual binary. Its
opt-in and exact selector keep public mutation outside the hermetic gate. Only
after this and every other publication check passes may the new CLI be delivered.

Cloudflare's disable-compression option also disables its default compression;
responses carrying `no-transform` retain their supplied bytes. Direct R2
binding reads do not themselves prove a Cloudflare CDN cache hit. Preserve
browser/static cache semantics and measure actual public responses instead of
inferring cache behavior from a configured zone rule.
[Compression settings](https://developers.cloudflare.com/rules/compression-rules/settings/),
[no-transform behavior](https://developers.cloudflare.com/rules/compression-rules/),
and [Worker cache interaction](https://developers.cloudflare.com/workers/reference/how-the-cache-works/).

## Static verification and rollback

Before calling the publication complete, compare every public object and its
HTTP metadata with the local manifest, verify internal root rewriting and 404
routing, require TLS 1.1 to fail and TLS 1.2+ to succeed, and confirm that the
`r2.dev` endpoint is disabled. Record cold and warm transfers without an
invitation, then run one real macOS Host-to-browser official-DERP flow. The
repository's bounded public-origin verifier is the required independent check;
dashboard screenshots or successful uploads are not substitutes.

Run the verifier only after the reviewed rules are active:

```sh
pnpm verify:origin -- https://link.tailmouse.com/ apps/web/dist/web-manifest.json --short-invitations
```

Omit `--short-invitations` only when verifying an independently hosted static
bundle or the historical R2-only rollback. The opted-in check verifies short
navigation and generic API cache policy, but deliberately labels lifecycle
`not-tested`; it never creates or resolves a potentially live invitation.
Worker identity is separately bound to the reviewed configuration, compiler and
source inventory, matching Web-manifest hash, and exact bundle/map hashes by
`edge-manifest.json`. The distribution includes its eight edge files and an
eighth CycloneDX SBOM while preserving the Web schema-2 self-hosting contract.

After explicit production-cutover authorization, run the bounded synthetic
lifecycle check separately:

```sh
pnpm --filter @tailmouse/link-edge exec node verify-lifecycle.mjs --production --abandoned-lease
```

This command creates at most two nonfunctional synthetic mappings, keeps their
invitations/capabilities only in memory, and emits only redacted outcomes and
numeric deadlines. It checks exact/alternate casing, non-renewing reads,
renewal, deletion and abandoned-lease unavailability. The abandoned probe waits
until three minutes after expiry before its first GET, leaving a window for
metadata-only observation of active-storage cleanup. A public expired GET can
itself trigger deletion and therefore does not prove alarm-only cleanup.
Cloudflare's namespace object metadata exposes `hasStoredData`, but object IDs
do not identify locator names and metadata freshness is not guaranteed; a
before/after observation is attributable only without concurrent objects.
Never add a production introspection endpoint or restore historical storage to
make this check pass. Provider recovery-copy erasure remains unverified.

The static verifier is necessary but does not replace the Worker identity,
binding, and lifecycle checks above. The command rejects credentials, query strings and fragments; public origins
must use HTTPS. It makes only bounded `HEAD` and `GET` requests, never sends an
invitation, and emits a JSON report covering the selected address, negotiated
TLS, root routing and static-client backend independence, exact object bytes and metadata, required
headers, and first/repeated raw-Wasm transfer timings. HTTP is accepted only for
the loopback test fixture. When an origin omits the optional `Content-Length`,
the verifier still proves the bounded GET body size and digest; when the header
is present, it must equal the manifest size. Encoded evidence objects are
requested with their exact recorded encoding and must remain byte-identical.

If verification fails, stop publication. For a Worker regression, restore only
a reviewed prior Worker version compatible with the existing SQLite class and
static manifest. A code rollback is not a data rollback; never restore the
invitation namespace from backup or delete that namespace to reset a rollout.
If a compatible previous Worker is unavailable, remove the hostname's Worker
route, restore the recorded R2-only domain/rules, and restore the preceding
coherent static entry, service worker, manifest, and unversioned notice files.
All referenced immutable objects must still exist. Purge changed entry/metadata
keys and rerun the static verifier. Retain failed static objects until their
hashes are recorded; they contain no invitation material.

Returning to R2-only deliberately makes new short links and renewal unavailable;
it does not convert them into full invitations. Hosts then follow their bounded
fail-closed lifecycle. Keep the deployed Durable Object class and alarms
available to expire abandoned mappings even after removing its public route.
Full-fragment operation resumes only after the restored static release passes
verification. Provider rollback constraints must be checked against the actual
deployed class transitions; do not force an incompatible rollback.
[Cloudflare Worker rollback constraints](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/).

Sources verified 2026-09-07:

- [Cloudflare R2 public buckets and custom domains](https://developers.cloudflare.com/r2/buckets/public-buckets/)
- [Cloudflare R2 object uploads and HTTP metadata](https://developers.cloudflare.com/r2/objects/upload-objects/)
- [Cloudflare URL Rewrite Rules](https://developers.cloudflare.com/rules/transform/url-rewrite/)
- [Cloudflare Cache Rules](https://developers.cloudflare.com/cache/how-to/cache-rules/)
- [Cloudflare Compression Rules](https://developers.cloudflare.com/rules/compression-rules/)
- [Cloudflare response-header transforms](https://developers.cloudflare.com/rules/transform/response-header-modification/)
- [Cloudflare R2 custom-domain TLS guidance](https://developers.cloudflare.com/r2/buckets/public-buckets/#minimum-tls-version--cipher-suites)
