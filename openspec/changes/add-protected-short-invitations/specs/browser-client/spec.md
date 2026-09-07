## MODIFIED Requirements

### Requirement: Static client with one optional resolver

The browser application SHALL build to self-hostable static assets and MUST NOT require remote scripts, remote styles, remote fonts, third-party analytics, or a server for full fragment invitations. The official deployment MAY require only its same-origin bounded short-invitation resolver before loading the same static client; terminal traffic, authentication, mode behavior, and full self-hosted invitations MUST NOT depend on that service.

#### Scenario: Production build is inspected

- **WHEN** the built HTML and assets are checked
- **THEN** no executable, style, font, analytics, telemetry, or terminal endpoint points to an external origin

#### Scenario: A full invitation uses a self-hosted client

- **WHEN** an operator serves the documented static output and opens a supported fragment invitation
- **THEN** invitation parsing, Tailcat dialing, access authentication, and both mode UIs require no TailMouse server API

### Requirement: Invitation input is consumed safely

The client MUST accept either a bounded full invitation fragment or one canonical official short path, never both. It MUST validate fragment, locator, resolved body size, mode, and protocol identifier before Tailcat dialing; consume the complete invitation only in memory; remove fragment or short path from visible history; and MUST NOT persist or emit either the invitation or access code. A Leash access code SHALL be entered separately in active-page memory and MUST NOT be sent to the resolver or added to URL, history, form restoration, browser storage, static cache, clipboard without a separate user action, analytics, or error output.

#### Scenario: Valid short invitation opens the client

- **WHEN** the official page loads with a canonical active locator
- **THEN** it resolves one supported identifier-2 protected-Leash invitation, replaces browser-visible history with the root URL, and presents separate access-code entry before Tailcat dialing

#### Scenario: Short resolution is invalid

- **WHEN** the locator is malformed or unavailable, the response is oversized, or the returned invitation is unsupported or malformed
- **THEN** the client aborts resolution and decoding, erases partial bytes and any entered access code, makes no Tailcat request, and displays a generic non-secret invitation-unavailable error

#### Scenario: Both path and fragment are supplied

- **WHEN** a URL contains a short locator and a full invitation fragment
- **THEN** the client rejects the ambiguous credential input before resolution or decoding and preserves neither value

### Requirement: Safe static and resolver caching

The service worker SHALL cache only versioned static application assets and MUST NOT include short paths, resolver requests or responses, invitation fragments, MouseCards, ConnBlobs, access codes, management capabilities, derived keys, challenges, proofs, session responses, process metadata, or terminal data in cache keys or values. Resolver requests SHALL bypass application caches and require network `no-store` behavior.

#### Scenario: A short invitation is resolved while a service worker controls the page

- **WHEN** the browser requests the same-origin resolver
- **THEN** the worker does not intercept or cache the request or response and an offline or failed network produces the bounded unavailable state

#### Scenario: A new release activates

- **WHEN** content-hashed assets change
- **THEN** the new worker serves a coherent asset set and removes obsolete application caches without touching browser invitation or session material
