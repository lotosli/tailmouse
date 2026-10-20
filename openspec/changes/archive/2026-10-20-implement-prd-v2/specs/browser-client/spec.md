## MODIFIED Requirements

### Requirement: Invitation fragment is consumed safely

The client MUST validate invitation fragment size, mode, and protocol identifier, remove it from the visible URL immediately after in-memory consumption, and MUST NOT persist or emit its content. A Leash access code SHALL be entered and retained separately in active-page memory, MUST NOT be added to the invitation, URL, history, form restoration, browser storage, cache, clipboard without a separate user action, analytics, or error output, and SHALL be erased with the invitation on terminal disposal.

#### Scenario: Valid invitation opens the client

- **WHEN** the page loads with a supported identifier-2 Leash fragment
- **THEN** the client retains only the minimum in-memory connection material, replaces browser-visible history with a fragment-free URL, and presents a separate access-code entry before terminal access

#### Scenario: Oversized invitation opens the client

- **WHEN** the fragment exceeds its specified limit
- **THEN** the client rejects it before decoding or storage, erases any entered code, and displays a non-secret error

#### Scenario: The browser offers form restoration

- **WHEN** the page is reloaded, restored, or resumed after disposal
- **THEN** access-code input is not restored by the application or browser form semantics and the original invitation plus new code entry are required

### Requirement: Mode-selected application shell

The single PWA SHALL select `escape` or `leash` presentation from a validated MouseCard only for initial routing, display explicit loading, connection, authentication, admission, and error states as applicable, and MUST defer all authority, access mode, task state, and capabilities to the admitted `SERVER_WELCOME`. Before welcome, Leash UI MUST expose no terminal output, metadata, or enabled mode controls.

#### Scenario: Card mode disagrees with host

- **WHEN** the initial route says Escape but the Host rejects or reports another mode
- **THEN** the client performs no mode action and shows a non-secret mode mismatch rather than trusting the route

#### Scenario: Host requires a code

- **WHEN** identifier-2 Leash returns a valid authentication challenge
- **THEN** the client proves the separately entered code and does not infer capabilities or render a terminal until admitted welcome arrives

### Requirement: Browser cold-start experience

The production client SHALL target less than 3 seconds from warm cache to usable UI, less than 15 seconds on ordinary 4G from cold cache excluding human code-entry time, and a compressed Wasm target below 8 MiB, and SHALL report measured regressions in release evidence. It MUST record UI readiness, code-entry wait, Wasm transfer/initialization, relay connection, authentication/admission, and terminal-ready time separately.

#### Scenario: Invitation starts a cold connection

- **WHEN** a valid invitation starts the locally hosted Wasm download and connection
- **THEN** the UI displays actual Wasm download percentage, a combined `Connecting to relay / Meow handshake` stage, an access-code/authentication stage, the admitted session-handshake result, and the usable mode UI in observable order
- **AND** human code-entry time is excluded from network and initialization measurements

#### Scenario: Performance target is exceeded

- **WHEN** a release measurement exceeds a cold-start or compressed-size target
- **THEN** the conformance report records the observed value and blocks an unqualified performance-complete claim

### Requirement: Safe static caching

The service worker SHALL cache only versioned static application assets and MUST NOT include invitation fragments, MouseCards, ConnBlobs, access codes, derived keys, challenges, proofs, session responses, process metadata, or terminal data in cache keys or values.

#### Scenario: A new release activates

- **WHEN** content-hashed assets change
- **THEN** the new worker serves a coherent asset set and removes obsolete application caches without touching browser session secrets

## ADDED Requirements

### Requirement: Access authentication is explicit and recoverable

The Leash UI SHALL provide an accessible access-code field accepting the specified canonicalization, a user-triggered connect action, bounded `AUTH_FAILED` retry feedback, cooldown countdown for `AUTH_THROTTLED`, and a visible `Password protected` or `No password — link grants access` state derived only from Host messages. It MUST NOT automatically retry a proof, reuse a proof across streams, or offer a browser-controlled downgrade.

#### Scenario: The user mistypes a code

- **WHEN** the Host rejects a proof without starting cooldown
- **THEN** the browser shows one non-secret failure, keeps no proof, permits a user-triggered retry, and leaves terminal controls unavailable

#### Scenario: The Host enters cooldown

- **WHEN** the browser receives `AUTH_THROTTLED`
- **THEN** it disables connection attempts for the reported bounded cooldown, shows when the user may retry, and neither extends the Host cooldown nor starts an automatic timer-driven connection loop

#### Scenario: Link-only access is admitted

- **WHEN** `SERVER_WELCOME` authoritatively reports `access_mode` as `link`
- **THEN** the browser shows the persistent no-password warning for that connection and never claims password verification

### Requirement: Connection and task states remain distinct

The Leash UI SHALL distinguish connection loss or user departure from waiting, running, exited, failed, and retained-result task states. A recoverable connection outcome MUST offer only an explicit fresh-stream action using credentials still held in the active page; it MUST discard old input, control, resize, and proof work and MUST NOT imply that browser departure stopped the Host task.

#### Scenario: Browser returns after connection loss

- **WHEN** the page still holds the original invitation and code and the user selects reconnect
- **THEN** it creates a fresh Tailcat stream, completes a fresh challenge and admission, then applies reset/history/live ordering without replaying any old browser input

#### Scenario: The page is closed and reopened

- **WHEN** the user later opens the original invitation in a new page
- **THEN** the browser requests code entry again and can display retained task state only after fresh Host authentication
