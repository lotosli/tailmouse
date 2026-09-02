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
