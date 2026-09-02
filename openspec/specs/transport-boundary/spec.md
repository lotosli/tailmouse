# Transport boundary specification

## Purpose

Isolate Tailcat's unstable API and credential-bearing connection material from TailMouse protocol, policy, user interface and diagnostic surfaces.

## Requirements

### Requirement: Tailcat imports remain inside adapters

Native Tailcat imports SHALL occur only in `apps/cli/internal/transport/tailcat`, browser bridge calls SHALL occur only in `apps/web/src/transport/tailcat`, and upstream types MUST NOT cross either boundary.

#### Scenario: Core session code needs a stream

- **WHEN** core session logic consumes transport functionality
- **THEN** it depends on a narrow TailMouse-owned contract and receives no Tailcat value or type

### Requirement: Connection credentials remain ephemeral

ConnBlobs and invitation fragment material MUST remain in memory for the minimum required lifetime and MUST NOT enter logs, errors, metrics, command arguments, persistent browser storage, snapshots or fixtures.

#### Scenario: Dial fails with an upstream error

- **WHEN** Tailcat returns an error containing credential-shaped data
- **THEN** the adapter returns a classified redacted error with no original secret material

### Requirement: Bounded transport behavior

Transport operations SHALL accept cancellation, bound waits, retries, buffers and concurrency, and propagate a final inspectable failure rather than silently degrading.

#### Scenario: Connectivity does not recover

- **WHEN** the accepted retry/time budget is exhausted
- **THEN** outstanding work is canceled and the session receives the root transport failure

### Requirement: Explicit upstream upgrades

A Tailcat update MUST advance the parent repository's exact submodule gitlink from the configured `main` branch, be explicitly requested and reviewed as a dedicated dependency change, and be verified by adapter contract, integration and full repository gates. Builds MUST NOT float the gitlink automatically.

#### Scenario: A new Tailcat release is available

- **WHEN** dependency maintenance discovers a later release
- **THEN** no source automatically floats to it and an explicit reviewed change is required

### Requirement: Read-only upstream source

Tailcat source in the submodule MUST remain clean and unmodified during ordinary TailMouse work. A source modification requires an explicit owner request and its own Tailcat repository commit before the parent gitlink changes.

#### Scenario: An ordinary TailMouse change edits the submodule

- **WHEN** tracked or untracked content appears inside `third_party/tailcat` without an explicit Tailcat source-change request
- **THEN** the architecture or dependency gate fails before product tests run
