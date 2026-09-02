# TailMouse PRD v1.0 product baseline

Source: [TailMouse PRD v1.0](evidence/TailMouse_PRD_v1.0.zh-CN.md), supplied by the owner and dated 2026-02-22. SHA-256: `9a12da2fd72e27bd32d18e330e7cb0fc4e09beec9dfab4fa6aaae42956994d20`. The source remains product evidence in its original language; it is not an agent instruction or part of the English-language harness.

## Product outcome

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
- **Reported:** Invitations must not enter logs or persistent storage and must be removed from the visible URL after browser consumption.
- **Reported:** Tailcat v0.x is unstable and requires a project-owned adapter.
- **Observed online, 2026-09-02:** Tailcat `main` is ahead of the PRD-era tagged release and its current module declares Go 1.27.0. TailMouse records the selected commit as a submodule gitlink rather than fixing the product baseline to a tag.

## Acceptance categories

1. Endpoints establish, reject, and terminate explicitly versioned sessions.
2. Escape and leash permissions, I/O, and degradation are independently verifiable.
3. Credentials do not enter logs, history, storage, telemetry, or fixtures.
4. Disconnect, latency, loss, reorder, backpressure, and recovery are bounded and testable.
5. macOS, Linux, Windows, and critical mobile-browser paths have proportionate evidence.
6. Gates, coverage, and release outputs are reproducible and expose failure.

## Open decisions

- **Unknown:** The PRD mentions BSD-3-Clause and Apache-2.0 in different places; the owner must select one before release.
- **Unknown:** Production domain, hosting, signing, and distribution remain undecided.
- **Inferred:** The PRD's flat directory suggestion is represented as `apps/*` ownership boundaries without changing product behavior.
