## Purpose

Define the Host-owned access boundary that protects every phase-two Leash stream without adding accounts, persistent credentials, or a trusted application service.

## ADDED Requirements

### Requirement: Share-scoped access code

A password-protected Leash share SHALL generate 16 independent symbols uniformly from `23456789ABCDEFGHJKLMNPQRSTUVWXYZ` using a cryptographically secure random source, display them as four groups of four, and retain only the canonical ungrouped uppercase value in Host memory. The code MUST remain valid only for that Host share and MUST be replaced for every new share.

#### Scenario: A browser returns to the same share

- **WHEN** the original invitation and access code are presented on a new stream while the Host share remains live
- **THEN** the browser can perform a new authentication with the same code without the Host persisting or reissuing the credential

#### Scenario: The share ends

- **WHEN** local revocation, Host shutdown, or an explicit share deadline reaches its terminal outcome
- **THEN** the Host erases the access code and pending authentication state, rejects the old invitation and code, and generates an unrelated code if a later protected share starts

### Requirement: Challenge-bound proof

Every protected stream MUST authenticate through a fresh 32-byte Host challenge after preliminary invitation, session, mode, and protocol validation. The browser SHALL canonicalize case-insensitive code input by removing ASCII spaces and hyphens, reject any result outside the exact 16-symbol alphabet and length, derive `SHA-256(UTF-8("tailmouse-access-key-v1\0" + canonical_code))`, and send `HMAC-SHA-256(derived_key, UTF-8("tailmouse-access-proof-v1\0") || session_id || challenge)`. The Host MUST compare the complete proof without data-dependent early exit, MUST never receive the code itself, and MUST accept each challenge at most once on its issuing stream.

#### Scenario: A captured proof is replayed

- **WHEN** a proof from an earlier connection is sent for a new challenge, another session ID, or after its stream has closed
- **THEN** authentication fails without exposing terminal state or invoking a mode action

#### Scenario: A valid proof arrives

- **WHEN** the proof matches the current stream's challenge and live share
- **THEN** the Host marks only that stream authenticated and proceeds to active-slot admission

### Requirement: Authentication precedes authority and disclosure

Before successful authentication, the Host MUST NOT expose terminal output, history, title, PID, process state, result, capabilities, or access-mode-sensitive metadata; allocate the active browser slot; accept input, resize, or process control; or trigger browser-mediated process startup. Local Enter and `--start=now` remain independent local actions.

#### Scenario: An unauthenticated browser requests startup

- **WHEN** a protected share is waiting and the peer sends a validly framed start, input, resize, control, or other mode message before proof acceptance
- **THEN** the Host rejects the stream without starting the child or changing the active remote

#### Scenario: Authentication succeeds while another remote is active

- **WHEN** a second peer proves the code correctly after another authenticated stream owns the active slot
- **THEN** the Host returns `SESSION_BUSY`, closes only the second stream, and leaves the current remote and task unchanged

### Requirement: Bounded guessing and unauthenticated resources

A Host share SHALL allow at most four concurrent unauthenticated streams, at most 4096 received bytes and 30 seconds before authentication on each stream, and ten failed proofs across the share before a 30-second cooldown. During cooldown it MUST reject new proof attempts with `AUTH_THROTTLED`; after the finite cooldown the failure budget SHALL reset. Malformed proofs count as failures after safe frame validation. A successful proof resets the failure budget. Rejections MUST release their stream resources and MUST NOT stop the task, revoke the share, reveal the expected proof, or evict an authenticated remote.

#### Scenario: Guessing spans multiple connections

- **WHEN** incorrect proofs reach ten across one or more streams for the same share
- **THEN** the Host starts one 30-second share-wide cooldown and rejects further attempts without extending it per rejected connection

#### Scenario: A peer stalls before proving access

- **WHEN** an unauthenticated stream exceeds its connection count, byte, or time budget
- **THEN** the Host closes that stream with a bounded non-secret outcome and retains no connection-local challenge or input

### Requirement: Explicit link-only access mode

Only a Host launched with the per-launch `--no-password` flag SHALL select link-only access. That share MUST generate no access code or challenge and MUST still require a valid identifier-2 handshake before active-slot admission, disclosure, startup, or control. Invitation fields, peer messages, missing authentication support, failed proofs, configuration files, and environment variables MUST NOT select or downgrade to link-only access.

#### Scenario: A new launch omits the exception

- **WHEN** a prior link-only share has ended and Leash starts again without `--no-password`
- **THEN** the new Host returns to protected mode and generates a new access code

#### Scenario: An old peer lacks authentication

- **WHEN** a protected phase-two Host receives a Leash peer that supports only identifier 1 or omits the proof exchange
- **THEN** the Host fails closed with no bearer-only fallback and no terminal disclosure

### Requirement: Credential handling remains memory-only

The Host and browser MUST NOT persist, log, place in process arguments, include in MouseCard/URL/QR, send as telemetry, or expose through diagnostic errors the access code, derived key, proof, or invitation-plus-code pair. The browser MAY retain a canonical code only in the active page's memory for bounded user-initiated retries and MUST erase it on page disposal, explicit exit, invitation failure, revocation, or terminal protocol error.

#### Scenario: The invited page reloads

- **WHEN** a protected browser page reloads after consuming its fragment
- **THEN** neither invitation nor access code is recovered from browser storage, history, cache, URL, or service worker state and the user must reopen the original invitation and enter the code again
