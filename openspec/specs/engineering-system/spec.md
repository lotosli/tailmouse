# Engineering system specification

## Purpose

Define the repository structure, change discipline and executable evidence required to evolve TailMouse safely without speculative architecture.

## Requirements

### Requirement: Product-shaped monorepo

The repository SHALL separate the native application, browser application, language-neutral protocol, cross-runtime tests, specifications, documentation and tooling, and SHALL add a workspace/package only for a current independently built or deployed unit.

Tailcat SHALL be represented as an initialized external Git submodule so its source remains outside TailMouse history while its selected revision participates in the local Go workspace.

#### Scenario: New deployable unit is proposed

- **WHEN** a change proposes a new workspace, package or service
- **THEN** its proposal identifies the current acceptance scenario that requires independent build or deployment and rejects the simpler existing placement

#### Scenario: A clean clone runs the gate

- **WHEN** CI or a developer validates a newly cloned TailMouse revision
- **THEN** checkout initializes the exact recorded Tailcat gitlink before any dependency build or test

### Requirement: Risk-proportional specification

Protocol, security, public behavior, cross-runtime, dependency and architecture changes MUST be specified through the configured OpenSpec lifecycle before implementation, while behavior-neutral mechanical or documentation changes SHALL use the smallest sufficient artifact.

#### Scenario: Protocol behavior changes

- **WHEN** a change alters a TMOUSE/1 frame, state, limit or compatibility behavior
- **THEN** an accepted delta spec and tasks with explicit verification evidence exist before implementation begins

#### Scenario: Typographical error is corrected

- **WHEN** a correction changes no behavior or governing decision
- **THEN** the correction may proceed without manufacturing an OpenSpec change

### Requirement: Fail-fast delivery gate

The repository gate SHALL execute required checks in a deterministic order, stop at the first non-zero result, preserve its exit status, and MUST NOT mutate source or report later stages as successful.

#### Scenario: An early architecture check fails

- **WHEN** the architecture checker returns a non-zero status
- **THEN** OpenSpec, build and test stages are not run and the gate returns failure

#### Scenario: The Go module has no production source yet

- **WHEN** the repository gate reaches Go validation before the first Go source file exists
- **THEN** module integrity and tidy checks still run, while source-dependent checks report an explicit skip

### Requirement: Coverage floor

Each workspace containing production code SHALL enforce at least 80% coverage for every metric supported by its configured language tool, with statements mandatory for Go and statements, branches, functions and lines mandatory for TypeScript.

Unmodified external submodule source SHALL remain outside TailMouse-owned coverage metrics and MUST pass its configured upstream-oriented integrity, format, vet, test and build checks.

#### Scenario: A metric is below the floor

- **WHEN** any required coverage metric is 79.99% or lower
- **THEN** the gate fails before delivery

#### Scenario: A workspace has no coverable source

- **WHEN** a configured workspace contains no production source eligible for coverage
- **THEN** the task reports an explicit skip instead of reporting synthetic coverage success

### Requirement: Evidence-backed simplicity

An abstraction, dependency, package, service or configuration surface MUST have a current acceptance scenario that needs it, and an abstraction without a second current consumer MUST be limited to a verified volatile or security boundary.

#### Scenario: Future extensibility is the only justification

- **WHEN** a proposal justifies a new layer only with possible future modes, backends or tenants
- **THEN** review rejects that layer and requires the smallest concrete implementation

### Requirement: Scoped agent instructions

Agent instructions SHALL place shared governance at repository root and only local differences in the nearest subtree file, with the nearest applicable instruction taking precedence.

#### Scenario: Work targets the Tailcat adapter

- **WHEN** an agent changes files below the native Tailcat adapter
- **THEN** both repository, Go CLI and adapter-specific instruction files govern the change without duplicating their full contents

#### Scenario: Work inspects the Tailcat dependency

- **WHEN** an agent operates below `third_party/tailcat`
- **THEN** the scoped third-party instruction forbids source or gitlink modification unless the owner explicitly requested that Tailcat action

### Requirement: PRD conformance ledger

The repository SHALL maintain a machine-checkable or reviewable ledger mapping every P0 PRD requirement and Definition-of-Done item to its specification, implementation location, and strongest available evidence. No requirement MAY be marked complete from intent, file presence, or a narrower test.

#### Scenario: Final implementation audit runs

- **WHEN** all implementation tasks appear complete
- **THEN** the audit evaluates every PRD item as proven, contradicted, incomplete, or externally pending and blocks completion for every non-proven software requirement

### Requirement: Milestone-ordered implementation

Implementation SHALL progress through transport, session/protocol, Unix/Windows Leash, resource sharing and release hardening. A later milestone MUST NOT hide a failing prerequisite or redefine an earlier acceptance outcome.

#### Scenario: Clean-source verification needs an implementation revision

- **WHEN** reviewed implementation has passed its full gate but clean-source artifact verification needs a committed source revision
- **THEN** a local implementation checkpoint MAY precede the final conformance audit and change archival
- **AND** only reviewed task paths are committed, unrelated owner changes remain untouched, and a clean verification checkout is used when necessary
- **AND** the checkpoint does not complete any unproven software, platform or device requirement or authorize publication

#### Scenario: Transport echo is not proven

- **WHEN** M0 cannot establish bounded browser-to-host bidirectional bytes through Tailcat
- **THEN** feature implementation pauses at the root cause rather than replacing transport with a mock in product paths

### Requirement: Risk-matched verification topology

The gate SHALL cover unit, Go/TypeScript protocol conformance, native integration, hermetic Tailcat/DERP integration, Playwright browser behavior, network impairment, security, fuzz, race, vulnerability, build, packaging, and platform-specific tests, while applying the existing 80% coverage floor to TailMouse-owned production code.

#### Scenario: Platform-only code changes

- **WHEN** Unix PTY or Windows ConPTY behavior changes
- **THEN** the corresponding native integration and OS CI evidence are required in addition to portable unit tests

#### Scenario: Owner defers a native platform environment

- **WHEN** the owner explicitly defers Linux or Windows native execution until a matching environment is available
- **THEN** current acceptance records that platform as `deferred / not verified` and may use cross-compilation, static analysis, packaging, and platform-specific test compilation as implementation evidence
- **AND** the missing native execution does not block the explicitly macOS-scoped development cycle, but no release or support claim may describe that platform as runtime-verified

### Requirement: Bounded resource behavior

The implementation MUST keep all queues, rings, frames, samples, retries, timers, goroutines, browser subscriptions, and sessions within explicit limits. It SHALL target host idle memory below 150 MiB excluding the child. Browser idle memory SHALL be measured and optimized on a best-effort basis. Per the owner's 2026-09-03 decision, the original 200 MiB browser target is an advisory reference, not a hard acceptance gate; accounting scope remains explicit and measurements MUST NOT be relabeled as meeting that target when they exceed it.

#### Scenario: Browser idle memory exceeds the advisory reference

- **WHEN** a valid browser idle measurement is at or above 200 MiB
- **THEN** acceptance reports the measured value, accounting scope and exceeded advisory reference without failing solely for that value; host memory, startup, bounded resources and all other acceptance requirements remain unchanged

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

### Requirement: Isolated upstream compatibility monitor

A scheduled and manually dispatchable CI workflow SHALL test the current Tailcat `main` in a disposable checkout without updating the recorded parent gitlink. It MUST fail fast through upstream module verification, vet, tests, native and Web/Wasm builds, then derive disposable candidate module metadata from the tracked files and compile the TailMouse CLI package tree against that candidate in readonly mode. The tracked module files MUST remain unchanged. The workflow MUST retain readonly repository permissions and MUST NOT commit, push, publish, open a change, or alter the ordinary exact-gitlink release gate.

#### Scenario: Current Tailcat main is incompatible

- **WHEN** the upstream candidate changes an API, dependency, native build or Wasm distribution contract used by TailMouse
- **THEN** the isolated workflow fails with the first build or test error while the parent gitlink and ordinary builds remain unchanged until an explicit reviewed dependency update
