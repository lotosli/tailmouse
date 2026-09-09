## Why

The self-contained Tailcat invitation makes the terminal QR physically large and produces a URL that cannot be typed or remembered. The owner has moved a six-character, case-sensitive `link.tailmouse.com/<code>` experience into V2 for protected Leash shares. This requires a deliberately bounded server-side mapping instead of pretending that roughly 36 bits can encode or protect the complete invitation.

## What Changes

- Make the default official protected-Leash invitation a six-character Base62 short URL. The short code is a locator, not an authenticator; the independently delivered access code remains mandatory.
- Add one Cloudflare Worker application backed by one SQLite Durable Object per short code. It stores the complete invitation in plaintext, never receives or stores the access code, and exposes only bounded create, resolve, renew, and delete operations.
- Give every mapping a 15-minute rolling lease. Only the Host's separate in-memory management capability can renew it, every five minutes. Host revocation, expiry, post-exit completion, or shutdown requests immediate deletion; a Durable Object alarm deletes abandoned state after the lease. Browser reads never extend lifetime.
- Keep Escape, explicit `--no-password`, and non-official/self-hosted Web bases on the existing self-contained fragment invitation. A six-character locator without separate authentication is not accepted as a bearer credential.
- Fail an official protected-Leash launch before child startup when short-link creation fails. Do not silently fall back to the long invitation. A renewal that cannot complete before the current lease's safety boundary closes the share locally and leaves alarm cleanup as the server-side backstop.
- Resolve a valid short path into page memory without redirecting the full invitation into browser history. All short-link API and page responses are non-cacheable; application code, logs, analytics, traces, error text, and metrics must not contain the invitation or management capability.
- Render the shortest decodable level-M QR allowed by its actual payload, with a four-module quiet zone and a compact one-column/two-row terminal representation. Do not force a larger QR version for a short URL.
- Move the short-link requirement from the deferred Phase 2/V3 discussion into the V2 PRD, mark it as moved rather than duplicate it in V3, and amend the current no-server/no-persistence governance statements narrowly for this service.
- Preserve the full invitation-card and TMOUSE wire formats. Tailcat and its gitlink do not change.

## Capabilities

### New Capabilities

- `short-invitation-service`: Six-character allocation, bounded plaintext invitation storage, no-access-code boundary, strong-consistency lifecycle, renewal, deletion, abuse limits, and Cloudflare delivery behavior.

### Modified Capabilities

- `invitation-card`: Official protected Leash may present a short locator while full invitations remain fragment-only; terminal QR sizing follows the actual encoded URL.
- `cli-configuration`: Protected Leash selects the official short-link flow without changing Escape, `--no-password`, or self-hosted behavior, and fails before child startup when required publication fails.
- `browser-client`: The official page accepts a bounded short path, resolves it only into memory, then performs the unchanged Host-side access-code authentication.
- `release-delivery`: Official delivery adds the minimum Worker and Durable Object service while the Web bundle remains independently self-hostable with full fragment invitations.

## Impact

- Adds `apps/link-edge` as one independently deployed TypeScript workspace because the accepted short URL cannot be resolved by static R2 objects alone.
- Changes `apps/cli` invitation publication and teardown, `apps/web` initial invitation loading, Cloudflare deployment/verification, security documentation, the V2/V3 PRDs, architecture, constitution, and conformance evidence.
- Adds a versioned same-origin HTTP surface for create/resolve/renew/delete. It is not a terminal relay, account system, session directory, or TMOUSE protocol extension.
- Adds one exact Wrangler development dependency for local Worker validation and deployment and reuses the existing exact `cborg` catalog dependency for strict canonical MouseCard validation. Runtime infrastructure uses Cloudflare platform APIs and existing test tooling; no general Web framework, ORM, service layer, or queue is added. Wrangler generates platform declaration types from the reviewed configuration; no application code generator is introduced.
- The service can read a stored invitation during its lease. For protected Leash that invitation is insufficient without the separately held access code, but it remains sensitive connection material. Cloudflare compromise or operator access is therefore an explicit trust boundary.

## Evidence / Assumptions

- **Reported, 2026-09-07:** The owner requires a case-sensitive six-character URL, permits Cloudflare to store the invitation in plaintext, forbids storing the access code, and moves this behavior into V2.
- **Observed, 2026-09-07:** The current official invitation is long enough to produce an impractically large terminal QR. Its screenshot also demonstrates why real invitations and access codes must not enter retained evidence.
- **Observed, 2026-09-07:** `62^6` is 56,800,235,584 possibilities (about 35.7 bits). This is suitable only as a rate-limited locator paired with the existing independent protected-Leash access code.
- **Observed, 2026-09-07:** Cloudflare documents Workers KV as eventually consistent, with changes potentially taking 60 seconds or longer to become visible elsewhere. Durable Object storage is strongly consistent and supports alarm-driven TTL plus complete storage deletion; KV is therefore rejected for revocation-sensitive mappings.
- **Observed, 2026-09-07:** `link.tailmouse.com` currently serves a verified static release directly from R2 with no Worker. The new Worker must preserve exact static bytes, compression, cache policy, security headers, TLS policy, 404 behavior, and public-origin verification.
- **Assumed:** A 15-minute lease renewed every five minutes gives one bounded retry window without retaining abandoned mappings indefinitely. Browser traffic does not renew it.
- **Unknown:** Production request volume, Cloudflare cost, WAF/rate-limit thresholds, and custom-domain cutover behavior require measurement before publication; no capacity or SLA claim is made.
- **Observed, 2026-09-07:** Cloudflare SQLite storage offers 30-day point-in-time recovery. An API lease expiry and `deleteAll()` of active storage do not prove immediate physical or recovery-copy erasure. Every resolve/renew checks the lease independently of alarms; alarms delete active data and preserve cleanup retries. TailMouse adds no archive, restore endpoint, or operator restoration procedure. See [SQLite storage](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/) and [alarms](https://developers.cloudflare.com/durable-objects/api/alarms/).
- **Observed, 2026-09-07:** `NOTICE` is both an existing static filename and six Base62 characters. Allocation skips all manifest-listed static filenames. Exact-case resolution can distinguish an active mapping from no mapping, but unavailable reasons share one response; another casing is a different potential locator.
- **Reported/decision, updated 2026-09-09:** The owner identifies the official hostname as a prelaunch development/test deployment and explicitly replaces the earlier automatic-rollback requirement with diagnose, fix, redeploy, and retest in place. Credential-free local workerd/SQLite verification and clean release checks precede deployment; public lifecycle/static checks and real macOS short-link acceptance follow on the same official origin. A failed check remains failed and prevents a completion claim, but does not remove the route or restore the old static deployment. Keep the deployed storage class and expiry alarms intact. Adding a preview domain/service or weakening origin validation remains rejected. This supersedes only the 2026-09-07 rollback policy, not the functional or security acceptance requirements.

## Non-Goals

- Accounts, user identity, recovery, device trust, a session list, discovery, analytics, terminal traffic relay, persistent history, multi-user control, or a general control plane.
- Six-character short URLs for Escape or `--no-password` until they have an independent high-entropy authentication secret or a separately accepted bearer-token design.
- Persisting, transmitting, deriving, validating, or logging access codes in Cloudflare.
- Changing MouseCard, TMOUSE, Tailcat, DERP selection, PTY behavior, or earlier Tailcat compatibility.
- A second cloud provider, pluggable storage, local server framework, ORM, queue, generic repository/service layers, or speculative V3 hooks.

## Simplicity Budget

- **Workspace — `apps/link-edge`:** Required because a static R2 origin cannot create, renew, resolve, and immediately revoke six-character mappings. Keeping long fragment invitations was simpler but fails the accepted memorable-link and compact-QR scenarios.
- **Development dependency — exact Wrangler release:** Required to typecheck, test, configure, and deploy the Cloudflare Worker/Durable Object boundary reproducibly. Ad-hoc dashboard-only source would not be reviewable or gated.
- **Existing runtime dependency — `cborg` 6.1.2:** Required to strictly decode and canonically re-encode the untrusted invitation before storing it. Reusing the Web client's pinned codec avoids a handwritten CBOR decoder or cross-application source imports. Only the narrow MouseCard validation policy is repeated at this separate network boundary.
- **Reviewed install scripts — `esbuild` 0.28.1 and `workerd` 1.20260903.1:** Wrangler requires their platform executables. Only these exact transitive releases may run their inspected binary-install/version-verification scripts; all other dependency build scripts retain the default block.
- **Cloudflare Durable Object binding:** Required for atomic code claim, strongly consistent resolve/delete, and alarm cleanup. Workers KV was simpler but its documented eventual consistency violates immediate revocation.
- **Cloudflare R2 binding:** Required so the Worker can preserve the already published large static/Wasm artifacts at the same hostname. Moving Wasm into Worker assets or a second public hostname would either exceed the established delivery boundary or change user-visible URLs.
- **Same-origin versioned HTTP surface:** Required for the native Host and browser to use the short mapping. It remains four concrete operations rather than a generic API framework.
- **Host management capability:** A separate random, memory-only value whose hash is stored is required so possession of a six-character locator cannot renew or delete another share. Reusing the access code would send that forbidden secret to Cloudflare.
- **No new application framework, ORM, database abstraction, queue, code generator, dependency-injection container, plugin system, or Tailcat layer.**
