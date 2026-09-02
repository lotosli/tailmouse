## Purpose

Define the compact, secret-bearing invitation exchanged by QR or URL and its validation, expiration, and lifetime safety boundaries.

## ADDED Requirements

### Requirement: MouseCard v1 schema

A MouseCard v1 SHALL encode version, mode, full self-contained Tailcat address, virtual port, 128-bit cryptographically random session ID, expiration Unix time, and protocol minimum/maximum using the CBOR keys `v`, `m`, `t`, `p`, `s`, `e`, `a`, and `z`. It MUST NOT contain command, cwd, environment, username, log, capability, or process data.

#### Scenario: A valid card is decoded

- **WHEN** a decoder receives a canonical supported MouseCard
- **THEN** it returns the complete bounded fields without accepting trailing data, duplicate keys, wrong types, or unknown mandatory semantics

#### Scenario: Card mode is altered

- **WHEN** a bearer changes the mode stored in a MouseCard
- **THEN** the host rejects the handshake on session ID and mode mismatch because the card is a UI hint rather than authority

### Requirement: Fragment-only invitation

The invitation SHALL use `/#/v1/<base64url-cbor>` and MUST place ConnBlob material only in the URL fragment. The browser MUST reject an oversized or malformed fragment before unbounded decode, consume valid material into memory, immediately remove it from visible history, and never write it to browser storage, cache keys, referrers, analytics, or error reports.

#### Scenario: Static host receives an invitation request

- **WHEN** a browser navigates to a complete invitation URL
- **THEN** the HTTP request contains no fragment or ConnBlob and uses a no-referrer policy

#### Scenario: User reloads after fragment removal

- **WHEN** the page reloads after the one-time in-memory invitation was consumed
- **THEN** no credential is recovered from storage and the page requests a new invitation

### Requirement: Bounded URL and QR rendering

An encoded invitation MUST be shorter than 1400 bytes. Terminal QR output SHALL use error correction level M, at least 33 by 33 visible modules when required by the payload, and a quiet zone; the full URL SHALL appear only in the QR area and one explicit `Open:` line unless suppressed.

#### Scenario: Invitation exceeds the QR budget

- **WHEN** a self-contained MouseCard produces a URL of 1400 bytes or more
- **THEN** TailMouse emits no partial QR, reports invitation construction failure without the credential, and exits with code 3

### Requirement: Expiration and revocation

The host MUST reject a card whose expiration has passed, terminate access when session TTL expires or the local user revokes it, and erase retained card and connection material from application references during teardown.

#### Scenario: Expired invitation is presented

- **WHEN** a browser connects using a card after its expiration time
- **THEN** the host returns the stable non-secret `EXPIRED` outcome, performs no mode action, and releases the connection

### Requirement: Bearer warning

Every displayed invitation SHALL warn that anyone with the link can access the session until expiry and that the link must be treated like a password. Leash SHALL additionally warn that allowed browser input has the selected terminal process's authority, while readonly SHALL state that access is view-only.

#### Scenario: Readonly leash displays its invitation

- **WHEN** a readonly leash reaches listening state
- **THEN** its local display includes the general bearer warning and the view-only statement without implying input authority
