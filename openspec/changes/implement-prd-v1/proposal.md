## Why

TailMouse currently has an engineering harness and accepted high-level specifications but no product implementation. PRD v1.0 defines a complete P0 product: a single native `tailmouse` executable, a static mobile-first PWA, a Tailcat-backed encrypted byte stream, the TMOUSE/1 session protocol, the `escape` game, the `leash` PTY controller, and cross-platform release evidence. Implementing those pieces as one traceable change makes the PRD the delivery baseline and prevents milestone-by-milestone reinterpretation.

The measurable outcome is a PRD-conformance matrix with every P0 requirement linked to passing unit, integration, browser, impairment, security, build, or manual acceptance evidence on its applicable platforms.

## What Changes

- Build the native Go CLI with the exact PRD commands, configuration precedence, exit behavior, invitation/QR flow, structured logging, session lifecycle, and embedded Tailcat server adapter.
- Compile the single read-only Tailcat submodule revision into both the native executable and the browser Go/Wasm transport. Do not invoke or ship the upstream Tailcat CLI.
- Define and implement MouseCard v1 and TMOUSE/1 in Go and TypeScript with strict limits, version negotiation, shared golden fixtures, fuzzing, flow control, reconnect behavior, and secret redaction.
- Build the static Preact/Vite PWA with in-memory invitation handling, Tailcat Wasm loading, capability policy, CSP, offline static assets, mobile accessibility, and a narrow `ByteStream` adapter around `tailcatDial`.
- Implement `escape` as a host-authoritative 30 Hz game with five deterministic solvable maps, bounded 20 Hz input, 10 Hz snapshots, RTT-shaped scent pursuit, touch/tilt controls, prediction/reconciliation, terminal spectator output, and the PRD's win/loss/reconnect rules.
- Implement `leash` with one explicitly launched command, Unix PTY and Windows ConPTY/Job Object boundaries, local terminal mirroring, bounded output/scrollback, xterm browser rendering, ordered input, resize, readonly, interrupt, terminate, restart, reconnect, and reliable cleanup.
- Add hermetic Tailcat/DERP integration, browser end-to-end, network impairment, security, cross-platform, packaging, checksum, SBOM, and PRD-conformance verification.
- Deliver in the PRD order M0 transport spike, M1 protocol/session, M2 escape, M3 Unix leash, M4 Windows leash, and M5 release hardening. A milestone is complete only when its tasks and acceptance evidence pass.

Material decisions:

- Tailcat remains one upstream Go implementation. Native imports `github.com/tailscale/tailcat`; Web builds the upstream browser bridge to Wasm. TailMouse owns only the two narrow adapters.
- The host owns authoritative session, game, permission, and process state. Browser prediction never becomes authority.
- Go and TypeScript implement the small TMOUSE/1 wire contract independently against shared fixtures. Code generation is rejected because it adds a generator and generated ownership without eliminating runtime-specific state handling.
- The owner's later instruction supersedes the PRD's v0.4.0 tag wording: `.gitmodules` names `main` as the explicit update source, while every TailMouse commit and release still records one exact gitlink for both native and Wasm builds. Gates never auto-update it.
- The PRD's `sessionStorage` reload requirement conflicts with its rule that bearer invitation material must not be persisted and with the accepted browser security specification. The stricter security boundary wins: consume the fragment once, retain only minimum material in memory, remove it from visible history, and require a new invitation after reload.

## Capabilities

### New Capabilities

- `cli-configuration`: CLI surface, configuration precedence, validation, exit codes, and process-level behavior.
- `invitation-card`: MouseCard v1 encoding, QR/fragment construction, TTL, size bounds, and secret-safe lifecycle.
- `tmouse-protocol`: TMOUSE/1 framing, negotiation, message catalog, sequencing, limits, and cross-language conformance.
- `relay-configuration`: Official, custom-host, and custom-map DERP behavior, including full embedded region data.
- `observability`: Human and JSON diagnostics, in-memory metrics, build identity, and mandatory redaction.
- `release-delivery`: Native and static Web artifacts, platform matrix, checksums, SBOM, compatibility metadata, and conformance evidence.

### Modified Capabilities

- `browser-client`: Add the complete PWA runtime, Wasm lifecycle, security headers, offline/static behavior, accessibility, and mode presentation requirements.
- `engineering-system`: Add PRD traceability, platform-specific gates, dependency artifact generation, packaging, and completion audit requirements.
- `escape-mode`: Add all PRD game constants, maps, controls, rendering, terminal spectator, timing, prediction, impairment, and outcome details.
- `leash-mode`: Add PTY/ConPTY behavior, local/browser concurrency, output buffering, control operations, process lifecycle, and platform cleanup details.
- `session-foundation`: Add the complete session state machine, TTL, single-client/reconnect rules, frame catalog, ping/pong, and teardown behavior.
- `transport-boundary`: Add native server and browser dial contracts, DERP variants, exact native/Wasm revision identity, integration tests, and shutdown semantics.

## Impact

- Adds production code under `apps/cli`, `apps/web`, and `protocol`, plus shared fixtures and system tests under `tests`.
- Adds generated build output only under ignored artifact/build directories; generated Wasm and release files are never edited by hand.
- Adds direct Go dependencies for CBOR, QR encoding, Unix PTY, terminal control, and platform syscalls; adds Web dependencies for CBOR and xterm rendering. All versions will be exact and recorded in the existing module/lock files.
- Uses Tailcat and Tailscale DERP packages for transport and hermetic integration only. Tailcat source remains clean in its submodule.
- Changes no remote service and adds no application backend, account, database, control plane, analytics, or business relay.
- External publication, production domain selection, signing-key custody, and third-party package-manager accounts require separate owner-operated release credentials; the repository will produce and verify publishable artifacts without storing those credentials.

## Evidence / Assumptions

- **Reported:** PRD v1.0 is marked development-ready and defines P0 requirements, M0-M5 milestones, tests, security behavior, and release Definition of Done.
- **Observed, 2026-09-02:** The current Tailcat root is an importable `package tailcat`; `cmd/tailcat` and `web` are separate `package main` consumers of that same library.
- **Observed, 2026-09-02:** The selected Tailcat submodule commit exposes `Server`, `Client`, `ConnBlob`, native TCP streams, and browser `tailcatDial`/`tailcatListen` bridge functions.
- **Reported:** The owner requires complete PRD implementation, later PRD conformance verification, and no PRD deviation unless an error is identified.
- **Reported:** The owner requires Tailcat source to remain unchanged unless explicitly requested and wants dependency updates to follow explicit submodule updates from `main` rather than a fixed v0.4.0 tag.
- **Inferred:** One release-ready implementation may be completed through milestone task groups inside this change without adding separate services, repositories, or framework layers.
- **Unknown:** The final open-source license, production Web domain/host, signing identity, and publication accounts remain owner decisions. They do not block local implementation or reproducible release artifacts but do block claiming an externally published release.

## Non-Goals

- Reimplementing or forking Tailcat, WireGuard, DERP, NAT traversal, Netstack, or the Tailcat wire format.
- Shipping or invoking the upstream `tailcat` CLI.
- Accounts, databases, cloud control planes, short-code services, business traffic relays, daemons, unattended remote control, native GUI streaming, remote desktop, browser SSH, HTTP tunnels, file management, camera, microphone, or P1/P2 capabilities.
- A generic transport plugin system, dependency-injection container, protocol generator, shared UI framework, server-rendered Web application, or speculative extension points.
- Persisting terminal history, invitations, ConnBlobs, capability grants, or other session credentials.

## Simplicity Budget

- **Workspace:** No new workspace. `apps/cli` remains the Go composition root and `apps/web` remains the only JavaScript workspace; the alternative of splitting modes or protocol packages into publishable workspaces has no current deployment consumer.
- **Tailcat dependency:** Existing read-only submodule and Go workspace; required for every connection scenario. Reimplementation or an external executable would violate single-install and browser requirements.
- **CBOR libraries:** One Go and one browser decoder/encoder are required for MouseCard interoperability. A handwritten general CBOR implementation is less safe; only the fixed schema surface will be exposed.
- **QR encoder:** One native Go dependency is required for the terminal invitation. Hand-authoring QR error correction is out of scope and unsafe.
- **PTY/platform packages:** One Unix PTY dependency plus official Go platform packages are required by the real TUI and cross-platform cleanup scenarios. Shell pipes cannot satisfy terminal emulation, resize, signals, or process-tree behavior.
- **xterm packages:** The terminal renderer and only the PRD-required fit/canvas facilities are required for ANSI/TUI browser acceptance. Building a terminal emulator is not a simpler alternative.
- **Configuration surface:** Only documented CLI flags, environment variables, TOML fields, MouseCard, TMOUSE/1, and static build metadata. No generic configuration framework.
- **Abstractions:** Tailcat server/byte-stream adapters, the OS PTY boundary, and language-neutral protocol fixtures are justified volatile, security, and platform boundaries. Mode logic otherwise uses concrete functions and state.
