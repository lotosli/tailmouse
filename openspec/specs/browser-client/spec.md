# Browser client specification

## Purpose

Define a static mobile-first browser client that protects invitations, handles capability differences explicitly and keeps the Tailcat bridge isolated.

## Requirements

### Requirement: Static self-contained client

The browser application SHALL build to static assets and MUST NOT require application servers, remote scripts, remote styles, remote fonts or third-party analytics at runtime.

#### Scenario: Production build is inspected

- **WHEN** the built HTML and assets are checked
- **THEN** no executable, style, font or analytics resource points to an external origin

### Requirement: Invitation fragment is consumed safely

The client MUST validate invitation fragment size and version, remove it from the visible URL immediately after in-memory consumption and MUST NOT persist or emit its content.

#### Scenario: Valid invitation opens the client

- **WHEN** the page loads with a supported invitation fragment
- **THEN** the client retains only the minimum in-memory connection material and replaces browser-visible history with a fragment-free URL

#### Scenario: Oversized invitation opens the client

- **WHEN** the fragment exceeds its specified limit
- **THEN** the client rejects it before decoding or storage and displays a non-secret error

### Requirement: Capability-driven behavior

Clipboard, keyboard lock, wake lock and related browser capabilities SHALL be requested only from a user-triggered flow, represented explicitly in session state and degrade according to mode specifications when unavailable.

#### Scenario: Clipboard permission is denied

- **WHEN** the user or browser denies clipboard access
- **THEN** the client reports the unavailable capability and continues only with behavior permitted by the active mode

### Requirement: User-visible browser verification

Critical browser flows SHALL be tested through isolated browser contexts using accessible, user-visible interactions rather than implementation call counts.

#### Scenario: A critical flow regresses

- **WHEN** its rendered state or accessible interaction no longer meets the requirement
- **THEN** Playwright fails with trace evidence without contacting third-party systems

### Requirement: Mode-selected application shell

The single PWA SHALL select `escape` or `leash` presentation from a validated MouseCard only for initial routing, display an explicit connection/loading/error state before mode data, and MUST defer all authority and capabilities to `SERVER_WELCOME`.

#### Scenario: Card mode disagrees with host

- **WHEN** the initial route says escape but the authenticated host rejects or reports another mode
- **THEN** the client performs no mode action and shows a non-secret mode mismatch rather than trusting the route

### Requirement: Tailcat Wasm lifecycle

The client SHALL load locally hosted `wasm_exec.js` and Tailcat Wasm from the recorded submodule revision, display load progress, wait for bridge readiness, connect with a 60-second bound, and expose the result only through a TailMouse-owned byte-stream contract.

#### Scenario: Wasm fails to initialize

- **WHEN** download, compilation, runtime startup, bridge readiness, or dial fails
- **THEN** the client identifies the failed stage, redacts upstream text, releases partial resources, and offers only a bounded retry initiated by the user

### Requirement: Browser cold-start experience

The production client SHALL target less than 3 seconds from warm cache to usable UI, less than 15 seconds on ordinary 4G from cold cache, and a compressed Wasm target below 8 MiB, and SHALL report measured regressions in release evidence.

#### Scenario: Invitation starts a cold connection

- **WHEN** a valid invitation starts the locally hosted Wasm download and connection
- **THEN** the UI displays actual Wasm download percentage, a combined `Connecting to relay / Meow handshake` stage, the separately observed session-handshake stage, and the usable mode UI in that order
- **AND** relay connection and Meow/Meowed are not presented as independently observed events; the owner-approved PRD 13.4 correction preserves the 60-second connection bound and stage-specific safe errors without modifying Tailcat

#### Scenario: Performance target is exceeded

- **WHEN** a release measurement exceeds a cold-start or compressed-size target
- **THEN** the conformance report records the observed value and blocks an unqualified performance-complete claim

### Requirement: Static security policy

Production delivery MUST enforce a policy equivalent to `default-src 'self'`, `script-src 'self' 'wasm-unsafe-eval'`, `style-src 'self' 'unsafe-inline'`, `connect-src 'self' https: wss:`, `img-src 'self' data:`, `object-src 'none'`, `base-uri 'none'`, and `frame-ancestors 'none'`, plus no-referrer and least-privilege browser permissions.

#### Scenario: Built page references external executable content

- **WHEN** release inspection finds an external script, style, font, analytics, telemetry, or worker resource
- **THEN** the build fails before deployment

### Requirement: Safe static caching

The service worker SHALL cache only versioned static application assets and MUST NOT include invitation fragments, MouseCards, ConnBlobs, session responses, or terminal data in cache keys or values.

#### Scenario: A new release activates

- **WHEN** content-hashed assets change
- **THEN** the new worker serves a coherent asset set and removes obsolete application caches without touching browser session secrets

### Requirement: Supported browser behavior

The PWA SHALL support the latest two major versions of Safari, Chrome, Edge, and Firefox, with iOS Safari and Android Chrome as P0 mobile targets. Touch MUST remain the fallback wherever tilt or optional APIs are unavailable.

#### Scenario: Optional capability is missing

- **WHEN** wake lock, clipboard, keyboard lock, sensor, or another optional API is unavailable
- **THEN** the UI reports the degradation and retains all mode behavior that does not require that capability

### Requirement: Accessible mobile interaction

Controls SHALL expose accessible names, visible focus, sufficient touch targets, safe-area layout, reduced-motion behavior, and keyboard alternatives where meaningful, without using a large component framework.

#### Scenario: User navigates controls by keyboard

- **WHEN** focus moves through the active mode controls
- **THEN** order, labels, state, confirmation, and disabled behavior remain perceivable and operable

#### Scenario: Terminal text input and screen-reader support

- **WHEN** a Leash view opens
- **THEN** Unicode text input uses xterm's default input behavior, and an explicitly labeled connection-local Screen reader support control allows assistive-technology users to enable xterm's accessibility mode without changing host permissions or persisting terminal data
- **AND** readonly viewers can enable the same output accessibility support without gaining input capability
