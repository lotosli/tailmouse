## ADDED Requirements

### Requirement: PRD conformance ledger

The repository SHALL maintain a machine-checkable or reviewable ledger mapping every P0 PRD requirement and Definition-of-Done item to its specification, implementation location, and strongest available evidence. No requirement MAY be marked complete from intent, file presence, or a narrower test.

#### Scenario: Final implementation audit runs

- **WHEN** all implementation tasks appear complete
- **THEN** the audit evaluates every PRD item as proven, contradicted, incomplete, or externally pending and blocks completion for every non-proven software requirement

### Requirement: Milestone-ordered implementation

Implementation SHALL progress through M0 transport, M1 session/protocol, M2 escape, M3 Unix leash, M4 Windows leash, and M5 release hardening. A later milestone MUST NOT hide a failing prerequisite or redefine an earlier acceptance outcome.

#### Scenario: Transport echo is not proven

- **WHEN** M0 cannot establish bounded browser-to-host bidirectional bytes through Tailcat
- **THEN** feature implementation pauses at the root cause rather than replacing transport with a mock in product paths

### Requirement: Risk-matched verification topology

The gate SHALL cover unit, Go/TypeScript protocol conformance, native integration, hermetic Tailcat/DERP integration, Playwright browser behavior, network impairment, security, fuzz, race, vulnerability, build, packaging, and platform-specific tests, while applying the existing 80% coverage floor to TailMouse-owned production code.

#### Scenario: Platform-only code changes

- **WHEN** Unix PTY or Windows ConPTY behavior changes
- **THEN** the corresponding native integration and OS CI evidence are required in addition to portable unit tests

### Requirement: Bounded resource behavior

The implementation MUST keep all queues, rings, frames, samples, retries, timers, goroutines, browser subscriptions, and sessions within explicit limits. It SHALL target host idle memory below 150 MiB excluding the child, browser idle memory below 200 MiB, and average one-way Escape application payload below 20 KiB/s.

#### Scenario: Slow browser consumes leash output

- **WHEN** browser delivery cannot keep pace with PTY output
- **THEN** bounded data is dropped and measured without blocking the child or growing memory without limit

### Requirement: Cancellation and terminal restoration

Every blocking native operation SHALL accept or derive from cancellation, teardown SHALL bound Tailcat drain and process termination, and terminal raw state MUST be restored after normal return, error, signal, or recovered panic.

#### Scenario: Host receives Ctrl+C before any connection

- **WHEN** the local user interrupts a listening session
- **THEN** TailMouse immediately cancels outstanding work, closes Tailcat within its deadline, restores terminal state, and exits without leaked goroutines

### Requirement: Dependency boundary evidence

Build and contract tests MUST prove Tailcat API changes at compile time and verify that both Native and Wasm use the same recorded gitlink. Tailcat source SHALL remain clean throughout implementation.

#### Scenario: Upstream bridge signature changes

- **WHEN** an explicitly updated Tailcat commit changes the browser connection object
- **THEN** only the browser Tailcat adapter and its contract tests require product changes, or the update is rejected
