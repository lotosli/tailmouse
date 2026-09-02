## ADDED Requirements

### Requirement: Native Tailcat server adapter

The native adapter SHALL create and own a Tailcat server, expose only a TailMouse-owned start/address/relay/close/drain contract, accept application connections only on virtual TCP port 44321, and convert the selected full-region ConnBlob into invitation input without exposing Tailcat types elsewhere.

#### Scenario: Tailcat server starts successfully

- **WHEN** valid official or custom relay configuration is supplied
- **THEN** the adapter returns a safe address value and relay description, dispatches only accepted application connections, and keeps keys and upstream types private

### Requirement: Browser Tailcat byte-stream adapter

The browser adapter SHALL be the only code that calls the upstream Wasm bridge. It MUST validate bridge readiness and returned shape and expose bounded asynchronous read, write, and close operations using TailMouse-owned types.

#### Scenario: Upstream connection object is malformed

- **WHEN** `tailcatDial` resolves without the required callable stream operations
- **THEN** the adapter closes any available resource, reports a redacted incompatibility, and does not expose the object to UI or protocol code

### Requirement: Same-revision native and Wasm transport

Native Tailcat imports and browser Tailcat Wasm MUST build from the exact parent gitlink recorded for that release. The build SHALL record that revision in both artifacts and MUST NOT consume an independently downloaded floating Wasm.

#### Scenario: Web build cannot identify the submodule revision

- **WHEN** dependency metadata or initialized submodule state is missing
- **THEN** the build fails before producing distributable Web assets

### Requirement: Browser path limitation

The product SHALL describe browser Tailcat traffic as DERP WebSocket-only and MUST NOT claim direct UDP, WebRTC, LAN discovery, or peer-to-peer upgrade for v0.1. Native Tailcat may use its available direct-path upgrade without changing application semantics.

#### Scenario: Native path becomes direct

- **WHEN** Tailcat upgrades an eligible native path from DERP to UDP
- **THEN** the adapter updates safe relay/path diagnostics while TMOUSE/1 behavior remains unchanged

### Requirement: Redacted transport failures

The adapters MUST map startup, dial, stream, cancellation, and close failures into bounded TailMouse classifications and remove ConnBlob, key, URL-fragment, address-token, and peer-secret content before returning errors or logs.

#### Scenario: Upstream error contains the dial address

- **WHEN** a connection failure formats the complete Tailcat address
- **THEN** the caller receives only a safe transport category and non-secret relay context

### Requirement: Hermetic transport integration

Integration tests SHALL exercise official-mode construction without depending on public availability and use controlled local DERP infrastructure for end-to-end server, full ConnBlob, custom host/map, Wasm dial, incorrect token, expiry, busy session, disconnect, drain, and close behavior.

#### Scenario: Public relay is unavailable in CI

- **WHEN** CI has no access to the public Tailcat relay service
- **THEN** deterministic transport integration still runs against local controlled infrastructure and no test silently skips required behavior
