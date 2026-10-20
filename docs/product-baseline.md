# TailMouse PRD v1.0 product baseline

Source: [TailMouse PRD v1.0](evidence/TailMouse_PRD_v1.0.zh-CN.md), supplied by the owner with baseline date 2026-09-01 in its header. The original supplied file has SHA-256 `9a12da2fd72e27bd32d18e330e7cb0fc4e09beec9dfab4fa6aaae42956994d20`. The source remains product evidence in its original language; it is not an agent instruction or part of the English-language harness.

**Observed, 2026-09-04:** The repository copy includes the owner-approved section 7.4 liveness supplement dated 2026-09-03 and section 13.4 startup-stage correction dated 2026-09-04. After the latter correction its SHA-256 is `f6374403775d72f5b9d379e81aeb63aab3f94170054efb43f5fdf66eab03e466`; the original supplied file remains unchanged. The 30-second valid-PONG deadline still precedes existing reconnect grace and preserves default child survival and explicit kill policies.

**Current scope, owner-directed 2026-10-20:** Resource sharing and protected Leash are retained for 1.0; the minigame is completely removed. The original PRD below remains historical product evidence, superseded by `finish-first-share-v1` for this decision.

## Original product outcome

- **Reported:** TailMouse connects two devices for direct terminal collaboration through Tailcat/Tailscale networking without a central business-traffic relay.
- **Reported:** The native side embeds Tailcat as a Go library; the browser uses Tailcat's Go/Wasm transport.
- **Reported:** `escape` is a 30–45 second host-authoritative cat-and-mouse game in which application-level RTT and jitter are visible game mechanics; it does not create or control a PTY.
- **Reported:** `leash` launches one real PTY/ConPTY command and lets a mobile browser observe and control only that command and its process tree.
- **Reported:** The browser is a static mobile-first TypeScript, Preact, Vite, and xterm Canvas PWA; the native entry point is a Go CLI.
- **Reported:** TMOUSE/1 frames handshake, capability, control, and data behavior across PTY/ConPTY, backpressure, reconnect, and supported platforms.

## P0 boundary

P0 includes the local CLI, static Web client, Tailcat transport, escape and leash, invitation and connection flows, protocol and security boundaries, tests, and release engineering.

Accounts, databases, a cloud control plane, business traffic relay, persistent terminal history, organizations/tenants, a plugin marketplace, and P1/P2 capabilities are not P0. They must not enter v0.1 as speculative extension hooks.

## Security-critical facts

- **Reported:** Tailcat ConnBlob and invitation fragment material are bearer credentials.
- **Reported:** Invitations must not enter logs and must be removed from the visible URL after browser consumption. The original v1 flow keeps them out of persistent storage; the accepted V2 official protected-short-invitation exception is recorded below.
- **Reported:** Tailcat v0.x is unstable and requires a project-owned adapter.
- **Observed online, 2026-09-02:** Tailcat `main` is ahead of the PRD-era tagged release and its current module declares Go 1.27.0. TailMouse records the selected commit as a submodule gitlink rather than fixing the product baseline to a tag.

## Acceptance categories

1. Endpoints establish, reject, and terminate explicitly versioned sessions.
2. Escape and leash permissions, I/O, and degradation are independently verifiable.
3. Credentials do not enter logs, history, telemetry, or fixtures. Storage is prohibited except for the accepted lease-bounded V2 official protected-invitation mapping.
4. Disconnect, latency, loss, reorder, backpressure, and recovery are bounded and testable.
5. macOS, Linux, Windows, and critical mobile-browser paths have proportionate evidence.
6. Gates, coverage, and release outputs are reproducible and expose failure.

## Accepted clarification

- **Reported, 2026-09-07, accepted owner V2 addition:** The official origin may map a case-sensitive six-character locator to one protected-Leash invitation in plaintext for a rolling 15-minute lease. The separate access code never enters that service. Host renewal, immediate authoritative deletion, and alarm expiry bound retention. Escape, explicit link-only access, and self-hosted origins continue to use full fragments. This addition is governed by `add-protected-short-invitations`; it does not amend the original supplied v1 PRD or add accounts, terminal relaying, or a generic control plane.

- **Reported, 2026-09-04, accepted owner correction of PRD 13.4:** Display relay connection and the Meow/Meowed exchange as one `Connecting to relay / Meow handshake` stage because the selected Wasm bridge does not expose separate progress events. Actual Wasm download percentage, the subsequent session-handshake stage, safe errors, the 60-second connection limit and startup targets remain required. Tailcat source remains unchanged.

- **Reported, 2026-09-03, accepted owner override of PRD 16.1:** Browser idle memory is a best-effort optimization goal, not a hard acceptance gate for now. The original 200 MiB reference and actual measurements remain visible without asserting compliance or selecting a new accounting scope. Host memory, startup, bounded resources, correctness, security and coverage requirements are unchanged.

## Open decisions

- **Observed/owner-delegated, 2026-09-04:** Apache-2.0 is selected for owned source and distributed with reviewed third-party notices; see `docs/decisions/2026-002-product-dependencies.md`.
- **Observed, 2026-09-07:** The official static browser origin is `https://link.tailmouse.com/` on Cloudflare R2. The accepted V2 short-link edge is implemented locally but its public cutover remains unverified; Native signing and distribution remain undecided.
- **Inferred:** The PRD's flat directory suggestion is represented as `apps/*` ownership boundaries without changing product behavior.
