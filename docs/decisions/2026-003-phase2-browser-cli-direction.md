# Decision 2026-003: Phase-two browser CLI direction

- Status: product direction accepted; implementation and hosting provider pending
- Verified: 2026-09-03
- Scope: future phase-two product evidence; does not amend the v0.1 baseline or the active `implement-prd-v1` change

## Evidence

- **Reported:** The owner selected "Control any CLI from your browser.", requested a revision of the separate phase-two PRD, permitted official DERP use, and selected `link.tailmouse.com` instead of a `www` entry point.
- **Reported, 2026-09-03:** The owner requested a separately displayed temporary password in addition to the invitation link and approved adding this requirement to the phase-two PRD.
- **Reported, 2026-09-03:** The owner also requested an explicit parameter to omit the password, provided that TailMouse warns the user.
- **Observed, 2026-09-03:** Current MouseCard and TMOUSE/1 specifications provide bearer invitation access without an independent access-code check. The accepted Leash browser-start trigger can fire on a valid HELLO, so adding authentication also requires an explicit admission and startup-order change.
- **Observed:** The accepted architecture already has a static browser client, native/browser Tailcat adapters, official DERP defaults and a configurable Web base URL. The current native default remains `https://tailmouse.dev/`.
- **Observed online, 2026-09-03:** [Tailcat](https://github.com/tailscale/tailcat#readme) permits its free, rate-limited DERP service with no SLA. Browser traffic currently requires DERP. Its [map](https://tailcat.dev/derpmap.json) lists New York, San Francisco, Frankfurt and Tokyo.
- **Observed, 2026-09-03:** Public DNS-over-HTTPS queries returned Cloudflare nameservers for `tailmouse.com` and NXDOMAIN for `link.tailmouse.com` A/CNAME. This records a lookup, not ownership or deployment verification.
- **Observed, 2026-09-03:** The existing local Wasm artifact is 27,136,514 bytes, exceeding [Cloudflare Pages' 25 MiB per-file limit](https://developers.cloudflare.com/pages/platform/limits/). Small compressed download variants alone do not establish upload compatibility.

## Options

1. Reuse the static browser and official DERP path, with a product-specific browser origin and durable in-process sessions.
2. Add a TailMouse application relay, short-link resolver or account-backed session directory.
3. Require upstream WebRTC support before delivering browser CLI control.

For default access control, retain bearer-only links, add a browser-only password prompt, or require an independent random access code verified by the native Host over the existing encrypted stream. Only the last option addresses link-only disclosure without requiring a new account service; a browser-only check can be bypassed. Separately, the owner requested an explicit bearer-only option with a warning.

## Decision

Use option 1 for phase-two planning. Make general CLI control the primary product journey, with AI CLIs as examples, and preserve the current Escape behavior. Retain the prior phase-two requirements for returning to the same live Host, bounded recent output and post-exit results.

Use `https://link.tailmouse.com/` as the intended official browser origin. Reserve the apex domain for the product website; no `www` dependency is required. Invitations retain the existing fragment structure. DNS points to static hosting, while Tailcat routes session traffic through DERP. Do not publish invitation material in DNS, HTTP paths or queries.

Keep the core CLI, browser and self-hosting path open source. Commercial plans and service guarantees remain outside this phase. Do not promise provider-specific Agent features or universal program compatibility.

Require an independent, cryptographically random access code by default for phase-two Leash, including readonly access and retained results. Display it separately from the invitation in the local sharing UI; exclude it from the URL, MouseCard and QR code. Keep it in memory, with explicit local delivery and user-initiated copying as the only presentation/export paths. Do not put it in diagnostic logs, process arguments, configuration, telemetry or browser persistent storage.

When access codes are enabled, the native Host must authenticate each new stream before exposing terminal output or process metadata, granting the active remote slot, accepting control or triggering browser-initiated startup. Reuse the existing end-to-end encrypted Tailcat connection and official DERP transport. Bound unauthenticated resources and enforce a share-level guessing budget across connections, with finite cooldown rather than permanent share lockout. Failed authentication must not stop the task or evict an authenticated remote.

An enabled code lasts for the same Host share, including browser absence, retained results and explicit child restarts. A new page requires code entry again; bounded retries in the same page may reuse its in-memory value but must reauthenticate each stream. Ending or expiring the share revokes the invitation and any enabled code, disconnects remotes and discards pending remote actions under the existing explicit child-process policy. A new Host generates a new code by default. This mitigates disclosure of the link alone; possession of both credentials can still grant access, and this is neither identity verification nor process isolation. Preserve Escape's accepted behavior.

Provide `tailmouse leash --no-password -- <command>` as an explicit per-launch exception. It generates no code and grants admission using the full invitation and ordinary protocol/permission checks. Before presenting the invitation, the CLI must warn that anyone holding the full link can access the terminal with the shared permissions; quiet mode cannot suppress this warning, and JSON output must preserve an equivalent redacted warning event. The browser must visibly identify the disabled-password mode. The flag itself is the user's choice; do not add an interactive confirmation. Do not add environment or file configuration for this opt-out. A later launch without the flag returns to code protection.

Only the native Host's startup choice can set the access mode, which stays fixed for that share and must be explicitly conveyed over the encrypted connection. A browser request, editable invitation field, authentication failure or old peer cannot disable an enabled code. The exception retains encryption, invitation validation, readonly permissions, single-remote admission, bounded connections and local revocation. In disabled-password mode a valid admitted handshake can trigger browser-start without a code.

## Consequences and open work

- The [phase-two PRD](../evidence/TailMouse_PRD_phase2.zh-CN.md) is Chinese product evidence. A separate accepted OpenSpec change is still required after v0.1 delivery.
- Select and validate static hosting before publication. Pages is a candidate, conditional on artifact-size and delivery compatibility; the existing Nginx static example is another path. Follow the provider's domain-binding process before publishing DNS records.
- Future implementation must synchronize the default Web URL, help, examples and release artifacts, preserving explicit self-hosting configuration.
- PRD revision 0.3 records default access-code protection, the explicit `--no-password` exception with mandatory warnings, and acceptance scenarios. A later OpenSpec must specify entropy and encoding, verification and session binding, resource limits, retry/cooldown budgets, local credential delivery, access-mode signaling and protocol compatibility. Leash version mismatches must fail closed without an automatic bearer-only fallback; an old Host's missing authentication is not evidence of an explicit opt-out. Local Enter and immediate startup remain independent of remote authentication.
- Official DERP is suitable for initial evaluation subject to its service terms. Actual target-network latency, availability and CLI compatibility remain unverified here. WebRTC integration is a separate future change.
- **Reported, 2026-09-03:** The owner questioned browser Wasm necessity and first-load cost. The current architecture requires the Tailcat client in Wasm to recover terminal bytes from relayed encrypted packets. The same artifact has 6,284,332-byte gzip and 5,071,424-byte Brotli variants; these are local artifact measurements, not public transfer measurements. Preserve a cold-start measurement requirement and evaluate size optimizations without treating a JavaScript/service redesign as already accepted.

## Outcome review

The product evidence and project memory are revised. No application behavior, Tailcat source/gitlink, hosting account, DNS record or public deployment is changed by this decision.
