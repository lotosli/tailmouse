## ADDED Requirements

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
