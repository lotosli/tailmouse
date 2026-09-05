## MODIFIED Requirements

### Requirement: MouseCard v1 schema

A MouseCard v1 SHALL encode version, mode, full self-contained Tailcat address, virtual port, 128-bit cryptographically random session ID, expiration Unix time or zero for Host-lived access, and protocol minimum/maximum using the CBOR keys `v`, `m`, `t`, `p`, `s`, `e`, `a`, and `z`. It MUST NOT contain an access code, authentication proof, command, cwd, environment, username, log, capability, or process data. Phase-two Leash cards SHALL advertise exactly `a=2,z=2`; Escape cards remain exactly `a=1,z=1`.

#### Scenario: A valid card is decoded

- **WHEN** a decoder receives a canonical supported MouseCard
- **THEN** it returns the complete bounded fields without accepting trailing data, duplicate keys, wrong types, or unknown mandatory semantics

#### Scenario: Card mode is altered

- **WHEN** a bearer changes the mode stored in a MouseCard
- **THEN** the host rejects the handshake on session ID and mode mismatch because the card is a UI hint rather than authority

#### Scenario: An old Leash card reaches the phase-two browser

- **WHEN** a MouseCard selects Leash with a protocol range that does not equal identifier 2
- **THEN** the browser reports `PROTOCOL_MISMATCH` before Tailcat dialing and never treats identifier 1 as a password-disabled phase-two share

#### Scenario: Invitation advertises a wider compatible range

- **WHEN** a Leash card advertises a range wider than exact identifier 2 or an Escape card does not advertise exact identifier 1
- **THEN** the phase-two browser rejects the mode/identifier pair before transport rather than inferring compatibility from a numeric interval

#### Scenario: An Escape card is decoded

- **WHEN** a valid Escape invitation advertises identifier 1
- **THEN** the browser retains the existing Escape negotiation and does not require or infer Leash access authentication

### Requirement: Expiration and revocation

The host MUST reject a card whose nonzero expiration has passed, terminate access when an explicit session TTL expires or the local user revokes it, and erase retained card, connection, access-code, and authentication material from application references during teardown. A zero expiration SHALL mean only that no wall-clock TTL was configured; it MUST NOT survive Host exit, local revocation, or mode completion policy.

#### Scenario: Expired invitation is presented

- **WHEN** a browser connects using a card after its nonzero expiration time
- **THEN** the host returns the stable non-secret `EXPIRED` outcome, performs no authentication or mode action, and releases the connection

#### Scenario: Explicit browser exit encounters a close failure

- **WHEN** the user exits and transport shutdown fails or reaches its deadline
- **THEN** the browser reports the redacted failure, erases the invitation and access code, and removes both retry and mode controls

### Requirement: Invitation security notice

Every displayed invitation SHALL say that it is sensitive connection material and must be kept private. Protected Leash SHALL state that the separate access code is also required and MUST display that code outside the URL and QR area. Link-only Leash SHALL warn that anyone with the full invitation can access the terminal with the selected permissions, explicitly including shell-level access when running a shell; readonly SHALL instead state that access is view-only. Escape retains its bearer-invitation warning.

#### Scenario: Protected readonly Leash displays its credentials

- **WHEN** a protected readonly Leash reaches listening state
- **THEN** its local presentation separates invitation and access code, explains that both are required, and states that authenticated access is view-only without implying input authority

#### Scenario: Link-only Leash displays its invitation

- **WHEN** Leash was explicitly launched with `--no-password`
- **THEN** the mandatory warning appears before the invitation and cannot be suppressed by quiet mode
