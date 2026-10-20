## Purpose

Define useful human and machine-readable diagnostics that expose session health while preventing credential or terminal-content disclosure.

## ADDED Requirements

### Requirement: Human diagnostics

Default stderr diagnostics SHALL show mode, relay mode or hostname, expiry, browser/session state, application RTT, jitter, and relevant bounded failures without sacrificing clarity for themed text. Quiet mode SHALL suppress nonessential diagnostics, while verbose and `--squeak` SHALL add safe detail.

#### Scenario: Session starts in official mode

- **WHEN** the native server reaches listening state
- **THEN** human output shows official relay mode, selected region or safe hostname, mode, expiry, browser waiting state, and the bearer warning without printing ConnBlob outside the invitation area

### Requirement: JSON event stream

JSON mode SHALL emit one valid event object per line to stderr with timestamp, event name, and bounded event-specific fields for relay selection, browser connection, RTT, process state, dropped output, mode result, and terminal failure.

#### Scenario: Automation reads JSON mode

- **WHEN** a session changes relay, connection, or process state
- **THEN** each stderr line is independently parseable JSON and stdout remains reserved for command or explicitly documented output

### Requirement: Mandatory diagnostic redaction

No diagnostic path MUST contain a complete URL, ConnBlob, invitation fragment, PTY output, browser input, command environment value, private key, or unredacted upstream error. Session identifiers SHALL be shortened or hashed, and token diagnostics MAY expose only a one-way hash prefix of at most eight hexadecimal characters.

#### Scenario: Debug logging handles a failed Tailcat dial

- **WHEN** upstream failure text contains a token-like value
- **THEN** human, JSON, test trace, and browser-visible output contain only a classification and safe context

### Requirement: Bounded in-memory metrics

Each active session SHALL maintain bounded counters and windows for bytes and frames sent/received, RTT p50/p95, jitter, active connection, reconnect count, protocol errors, output ring usage/drops, process generation, and escape input/snapshot rates. v0.1 MUST NOT expose a Prometheus or network metrics endpoint.

#### Scenario: RTT samples exceed the statistics window

- **WHEN** more than 60 valid samples are collected
- **THEN** percentile calculations retain only the latest 60 and memory use remains bounded

### Requirement: Build and dependency identity

Native `version` output and browser About/Debug output SHALL display the TailMouse build version, supported TMOUSE protocol range, and exact Tailcat gitlink revision without exposing credentials.

#### Scenario: Official artifacts are compared

- **WHEN** a user inspects Native and Web artifacts from one release
- **THEN** both report the same Tailcat revision and compatible TMOUSE ranges
