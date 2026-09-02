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
