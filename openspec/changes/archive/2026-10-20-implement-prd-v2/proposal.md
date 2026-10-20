## Why

Leash currently expires after four hours and ends access after a short browser disconnect, so it cannot reliably support a long-running CLI task that a user leaves and revisits. Its bearer invitation also grants terminal access by itself. Phase two makes general CLI control the primary journey, keeps a Host share available by default while the Host is alive, and adds a separate Host-verified access code without introducing an account or application relay.

The measurable outcome is that one command creates an invitation for `https://link.tailmouse.com/` plus a separate access code; a compatible browser can authenticate, leave, and later reuse both credentials to operate the same bounded terminal task or inspect its retained result. Explicit deadlines and local revocation remain authoritative. An explicit per-launch `--no-password` exception remains encrypted and bounded but warns that the full invitation is sufficient access.

## What Changes

- Make Leash shares Host-lived by default: browser departure releases only the active connection, while the task, bounded recent output, and completed result remain available until local revocation, Host exit, or an explicit deadline. Preserve `--post-exit-ttl=0` as immediate share completion and reject explicit legacy reconnect-grace configuration with migration guidance.
- Generate a new in-memory access code for every password-protected Leash share and authenticate every new stream before exposing state, output, process metadata, the active-remote slot, control, or browser-triggered process startup. Bound unauthenticated peers, time, bytes, and guessing attempts with a share-wide finite cooldown.
- Add `--no-password` only as a Leash command-line flag. It is not configurable through environment or files, is never inferred as a compatibility fallback, and produces a mandatory human or redacted JSON warning before the invitation.
- Define Leash protocol identifier `2` as TMOUSE/1.1. It adds an authenticated challenge/proof admission phase and authoritative access-mode signaling. Phase-two Leash invitations advertise only identifier 2; incompatible old Leash peers fail closed. Escape continues to use identifier 1 unchanged, and MouseCard v1 remains connection-only with no access code.
- Add browser access-code entry and authentication states, visible no-password status, explicit fresh-stream reconnection, and separate connection/task lifecycle presentation. Invitation and access-code material remain memory-only and are never persisted or combined.
- Change the phase-two official Web default to `https://link.tailmouse.com/` while preserving the explicit self-hosting override. Publish the existing static client from a Cloudflare R2 public bucket on that custom domain, with root-path rewrite, cache rules, object metadata, and response-header rules; do not add a server runtime to work around Pages' static-asset limit.
- Reframe user documentation and acceptance around standards-based terminal CLI/TUI programs, with AI CLIs as examples and without claiming universal program compatibility or native GUI streaming.

## Capabilities

### New Capabilities

- `access-authentication`: Host-owned access-code generation, proof verification, no-password signaling, guessing resistance, credential lifetime, and fail-closed admission boundaries.

### Modified Capabilities

- `cli-configuration`: Host-lived defaults, explicit retention syntax, reconnect-grace migration, the CLI-only no-password switch, and the official Web origin.
- `invitation-card`: Leash protocol-identifier advertisement and the requirement that MouseCard, URL, and QR remain separate from the access code.
- `tmouse-protocol`: TMOUSE/1.1 identifier 2, challenge/proof messages, authenticated sequencing, access-mode signaling, and compatibility rejection.
- `session-foundation`: Share and connection lifetimes, post-authentication active-slot admission, reconnect semantics, and bounded unauthenticated work.
- `leash-mode`: Browser-independent process continuity, retained results, browser-triggered startup ordering, and explicit deadline/revocation behavior.
- `browser-client`: Access-code UI, authentication/no-password states, credential erasure, reconnection, and distinct task/connection presentation.
- `observability`: Mandatory no-password warnings plus access-authentication diagnostics and redaction.
- `release-delivery`: Static publication at `link.tailmouse.com`, artifact-size/encoding/header evidence, and public end-to-end acceptance.

## Impact

The change affects the Go CLI configuration and Leash owner, the shared Go/TypeScript protocol and fixtures, the static browser client, documentation, release validation, and phase-two acceptance tests. It does not change Tailcat source, MouseCard framing, Escape behavior, the Tailcat transport boundary, or the single executable/static Web workspace shape.

Security failures must close only the unauthenticated stream, must not disclose terminal data or consume/evict the authenticated remote, and must not silently switch to link-only access. Expiry and revocation invalidate both invitation and code. Existing v1 Leash peers are intentionally incompatible with phase-two Leash because accepting them would bypass the new default authentication requirement.

## Evidence / Assumptions

- **Reported, 2026-09-03:** The owner accepted general browser CLI control, `link.tailmouse.com`, a separately displayed temporary password, and an explicit warned `--no-password` exception.
- **Observed, 2026-09-06:** Current Leash has a four-hour default TTL, a 30-second reconnect grace, bounded output history, one active remote, and bearer-only TMOUSE/1 identifier 1 admission. Its valid HELLO can trigger browser-start, so authentication must precede both admission and startup.
- **Observed, 2026-09-03:** The current raw Tailcat Wasm is 27,136,514 bytes; its gzip and Brotli variants are below 8 MiB, but Cloudflare Pages' 25 MiB per-file upload limit makes Pages unsuitable without a separately verified artifact change.
- **Inferred:** A 16-character code drawn uniformly from the unambiguous 32-symbol alphabet provides 80 bits of random strength and is short enough for separate human transfer. HMAC-SHA-256 over a fresh 32-byte Host challenge can be implemented by Go's standard library and browser Web Crypto without a new runtime dependency.
- **Observed online, 2026-09-06:** [Cloudflare Pages](https://developers.cloudflare.com/pages/platform/limits/#file-size) still limits one site asset to 25 MiB and directs larger files to R2. [R2 limits](https://developers.cloudflare.com/r2/platform/limits/) permit objects far larger than the current Wasm, and [R2 public buckets](https://developers.cloudflare.com/r2/buckets/public-buckets/) support production custom domains and cache rules; Cloudflare also provides static URL rewrites and [response-header transforms](https://developers.cloudflare.com/rules/transform/response-header-modification/). R2 custom-domain static delivery is therefore the selected publication design; account access and DNS authority remain external prerequisites.
- **Observed online, 2026-09-06:** [NIST SP 800-63B](https://pages.nist.gov/800-63-4/sp800-63b.html) requires rate limiting of failed authentication attempts, and the [OWASP authentication guidance](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html#login-throttling) recommends associating failed-attempt counters with the protected account rather than only an IP and avoiding indefinite denial. TailMouse maps that boundary to one Host share and uses a finite cooldown because it has no account identity.
- **Unknown:** Real Linux, Windows, mobile-device, target-program, public-hosting, and target-network behavior remains unverified until matching environments are supplied. Linux and Windows native execution are explicitly deferred and do not block the current macOS development cycle or establish runtime-support claims.

## Non-Goals

- Accounts, identity verification, MFA, device trust, persistent credentials, password recovery, databases, control planes, short links, or a TailMouse application relay.
- Persistent terminal history, Host restart recovery, daemonization, arbitrary attachment to existing processes, multi-user collaboration, file transfer, native GUI streaming, or provider-specific Agent integration.
- Reimplementing Tailcat, changing its source/gitlink without explicit owner direction, or replacing the current Tailcat Wasm path with WebRTC, TinyGo, or a JavaScript network client.
- Changing Escape protocol or lifecycle behavior, promising universal CLI compatibility, or treating simulated/cross-compiled Linux or Windows evidence as native acceptance.

## Simplicity Budget

- **Dependencies:** None. Use Go `crypto/rand`, `crypto/sha256`, and `crypto/hmac`, plus browser Web Crypto. A password library or account service would add machinery without satisfying a current identity requirement.
- **Workspaces/packages:** None planned. Keep authentication beside the existing protocol/session boundaries unless implementation proves a second consumer that requires a narrowly owned package.
- **Configuration surfaces:** Add only the per-launch `--no-password` flag and a `host` value for post-exit retention; change built-in Leash TTL and official Web URL defaults; remove active use of reconnect grace and reject its explicit legacy configuration. Environment/file configuration for disabling the password is intentionally absent.
- **Protocol surface:** Add only identifier 2 and the minimum challenge/proof messages and access-mode field needed to prevent pre-authentication disclosure or action. Adding optional negotiation hooks would create downgrade paths and is not required.
- **Hosting:** Reuse the static distribution on one R2 bucket and custom domain. Root rewriting and header/cache rules are the minimum external configuration needed for the existing PWA. A Worker, server, database, split-asset pipeline, or Tailcat fork is not justified merely to fit Pages' upload limit.
- **Abstractions:** No plugin system, credential framework, authentication provider interface, service layer, event bus, or generic lifecycle engine. Direct state transitions and narrow consumer-owned interfaces are sufficient for the two concrete runtimes.
