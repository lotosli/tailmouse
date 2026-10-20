## MODIFIED Requirements

### Requirement: Human diagnostics

Default local diagnostics SHALL show mode, relay mode or hostname, configured expiry or Host-lived status, browser/authentication/session state, application RTT, jitter, and relevant bounded failures without sacrificing clarity for themed text. Quiet mode SHALL suppress nonessential diagnostics, while verbose and `--squeak` SHALL add safe detail. Protected Leash MUST present its access code only through the dedicated controlling-terminal credential area; link-only Leash MUST emit its mandatory warning before the invitation even in quiet mode.

#### Scenario: Session starts in official mode

- **WHEN** the native Host reaches listening state
- **THEN** local output shows official relay mode, selected region or safe hostname, mode, lifetime, browser waiting state, separate invitation and access-code areas, and the applicable security notice without copying either credential into ordinary diagnostics

#### Scenario: Link-only Leash starts quietly

- **WHEN** `--no-password` and `--quiet` are both supplied
- **THEN** the full-link access warning still appears before the invitation while unrelated progress diagnostics remain suppressed

### Requirement: JSON event stream

JSON mode SHALL emit one valid event object per line to stderr with timestamp, event name, and bounded event-specific fields for relay selection, browser connection, access mode, authentication state, cooldown remaining, RTT, process state, dropped output, mode result, and terminal failure. JSON fields MUST NOT contain the invitation, access code, challenge, proof, derived key, or terminal content.

#### Scenario: Automation reads JSON mode

- **WHEN** a protected session presents its access code locally or changes authentication, connection, or process state
- **THEN** stderr remains independently parseable JSON with only redacted state such as `access_code_presented: true`, while stdout remains reserved for command or explicitly documented output

#### Scenario: Automation reads link-only JSON mode

- **WHEN** `--no-password` selects link-only access
- **THEN** a mandatory redacted warning event precedes the invitation event and cannot be suppressed by quiet mode

### Requirement: Mandatory diagnostic redaction

No diagnostic path MUST contain a complete URL, ConnBlob, invitation fragment, access code, derived authentication key, challenge, proof, invitation-plus-code pair, PTY output, browser input, command environment value, private key, or unredacted upstream error. Session identifiers SHALL be shortened or hashed. Authentication diagnostics MAY expose only bounded state, failure count, and cooldown duration, without any credential-derived prefix.

#### Scenario: Debug logging handles a failed proof

- **WHEN** verbose diagnostics, a test trace, or browser-visible reporting observes malformed or incorrect authentication data
- **THEN** every output contains only the stable classification and safe counters, with no supplied value, expected value, proof, challenge, URL, terminal data, or upstream text

#### Scenario: Debug logging handles a failed Tailcat dial

- **WHEN** upstream failure text contains a token-like value
- **THEN** human, JSON, test trace, and browser-visible output contain only a classification and safe context

### Requirement: Bounded in-memory metrics

Each active share SHALL maintain bounded counters and windows for bytes and frames sent/received, RTT p50/p95, jitter, active connection, reconnect count, protocol errors, authentication failures, cooldown state, unauthenticated connection count, output ring usage/drops, process generation, and Escape input/snapshot rates. TailMouse MUST NOT expose a Prometheus or network metrics endpoint.

#### Scenario: RTT samples exceed the statistics window

- **WHEN** more than 60 valid samples are collected
- **THEN** percentile calculations retain only the latest 60 and memory use remains bounded

#### Scenario: Authentication attempts exceed one cooldown

- **WHEN** repeated failures span multiple streams and cooldown cycles
- **THEN** metrics retain only bounded aggregate counts and current cooldown state without peer identities, submitted values, challenges, or proofs
