## MODIFIED Requirements

### Requirement: Fixed v1 message registry

TMOUSE/1 SHALL implement the shared type IDs and directions for browser `CLIENT_HELLO` 0x01, Host `SERVER_WELCOME` 0x02, bidirectional `ERROR` 0x03, `PING` 0x04, `PONG` 0x05, `CLOSE` 0x06, Host `AUTH_CHALLENGE` 0x07, browser `AUTH_PROOF` 0x08, terminal messages 0x10 through 0x16, and game messages 0x20 through 0x24. Identifier 1 receivers MUST reject authentication messages as unknown; identifier 2 Leash receivers MUST apply their defined pre-admission states. Control payloads SHALL use bounded JSON and high-frequency game payloads SHALL use documented fixed binary layouts.

#### Scenario: Message arrives in an illegal direction or state

- **WHEN** a known message type is sent by the wrong peer or before its required handshake or authentication state
- **THEN** the receiver rejects it as `BAD_FRAME`, `AUTH_REQUIRED`, or `UNAUTHORIZED_CAPABILITY` without invoking mode behavior

#### Scenario: Unknown type arrives

- **WHEN** a frame has an unrecognized mandatory type or nonzero unsupported flag
- **THEN** the receiver fails closed with a bounded protocol error

### Requirement: Authoritative handshake

The first browser message MUST be `CLIENT_HELLO` containing protocol min/max, session ID, mode, bounded client identity, and optional terminal dimensions. The Host MUST select a mutually supported identifier and validate session and mode before continuing. Identifier 1 SHALL retain the existing Escape `CLIENT_HELLO` then `SERVER_WELCOME` sequence. Identifier 2 SHALL be Leash-only: a code-protected Host replies with `AUTH_CHALLENGE`, accepts only one `AUTH_PROOF`, then performs active-slot admission; a link-only Host performs admission directly. Only an admitted stream receives `SERVER_WELCOME` containing authoritative mode, state, expiry, relay description, capabilities, and `access_mode` of `code` or `link` before any mode traffic is accepted.

#### Scenario: No protocol version overlaps

- **WHEN** the client and Host ranges have no mutually supported identifier for the card's mode
- **THEN** the Host returns `PROTOCOL_MISMATCH` and closes without allocating the active slot, exposing state, authenticating, or starting a child

#### Scenario: Authentication is required

- **WHEN** an identifier-2 protected Host validates `CLIENT_HELLO`
- **THEN** its next non-error frame is one fresh `AUTH_CHALLENGE`, and `SERVER_WELCOME` or mode data cannot be sent until the corresponding proof succeeds and the stream acquires the active slot

#### Scenario: Link-only access was selected locally

- **WHEN** an identifier-2 Host was launched with `--no-password` and validates `CLIENT_HELLO`
- **THEN** it sends no authentication challenge, admits at most one stream, and identifies `access_mode` as `link` in `SERVER_WELCOME`

#### Scenario: A compatible invitation includes unknown higher identifiers

- **WHEN** a Leash invitation advertises identifiers other than exact identifier 2 or an Escape invitation advertises identifiers other than exact identifier 1
- **THEN** the phase-two implementation rejects the card before handshake rather than enabling an unknown codec, field, message, or capability

### Requirement: Stable error vocabulary

Error frames SHALL contain bounded code, human message, and retryable status and MUST support `BAD_MOUSE_CARD`, `EXPIRED`, `MODE_MISMATCH`, `PROTOCOL_MISMATCH`, `SESSION_BUSY`, `AUTH_REQUIRED`, `AUTH_FAILED`, `AUTH_THROTTLED`, `UNAUTHORIZED_CAPABILITY`, `FRAME_TOO_LARGE`, `BAD_FRAME`, `PROCESS_NOT_RUNNING`, `RESTART_DISABLED`, `TERMINATE_DISABLED`, `READONLY`, `BACKPRESSURE`, and `INTERNAL` without embedding credentials, proofs, challenges, terminal data, or upstream error text. `AUTH_THROTTLED` SHALL include only the remaining integer `retry_after_ms` in `1..30000`; other authentication errors MUST NOT expose a retry count or expected value.

#### Scenario: Internal failure contains sensitive upstream text

- **WHEN** an internal or Tailcat error includes credential-shaped content
- **THEN** the protocol sends a classified redacted `INTERNAL` error and retains no original text in the frame

#### Scenario: Authentication fails

- **WHEN** a proof is malformed, incorrect, expired, replayed, or bound to another stream or share
- **THEN** the Host returns the same bounded `AUTH_FAILED` classification unless the finite share cooldown requires `AUTH_THROTTLED`, then closes that stream without disclosing which check failed

#### Scenario: Cooldown is already active

- **WHEN** a new stream reaches authentication during the share's finite cooldown
- **THEN** the Host returns `AUTH_THROTTLED` with the current non-extending remaining milliseconds and no credential-derived data, then closes the stream

## ADDED Requirements

### Requirement: TMOUSE minor identifiers are mode-specific

Wire identifier 1 SHALL denote TMOUSE/1.0 and remain the only Escape identifier. Wire identifier 2 SHALL denote TMOUSE/1.1 and be the only phase-two Leash identifier. Identifier selection MUST NOT imply that every integer between a product's lowest and highest supported identifiers is valid for every mode.

#### Scenario: A phase-two browser receives a v1 Leash invitation

- **WHEN** the card selects Leash and advertises only identifier 1
- **THEN** the browser rejects it as incompatible before dialing and offers no legacy bearer-only connection path

#### Scenario: An old browser receives a phase-two Leash invitation

- **WHEN** a browser implementing only identifier 1 parses a Leash card advertising exactly identifier 2
- **THEN** it rejects the non-overlapping invitation without interpreting identifier-2 messages

#### Scenario: The same browser opens Escape

- **WHEN** a phase-two browser receives a valid Escape card advertising identifier 1
- **THEN** it negotiates the unchanged TMOUSE/1.0 Escape contract without an access-code exchange

### Requirement: Authentication message payloads are exact and bounded

For identifier 2, `AUTH_CHALLENGE` SHALL carry bounded JSON with exactly authentication scheme `hmac-sha256-v1` and a canonical unpadded base64url encoding of 32 challenge bytes. `AUTH_PROOF` SHALL carry bounded JSON with exactly that scheme and a canonical unpadded base64url encoding of 32 proof bytes. Unknown fields, schemes, encodings, lengths, duplicate messages, or nonzero flags MUST fail closed. These frames remain subject to the 1 MiB envelope but their complete encoded payload MUST NOT exceed 512 bytes.

#### Scenario: A challenge or proof is oversized

- **WHEN** either authentication payload exceeds 512 bytes or its decoded value is not exactly 32 bytes
- **THEN** the receiver rejects it before allocating according to the claimed size and performs no admission or mode action

#### Scenario: A proof is duplicated

- **WHEN** a browser sends another `AUTH_PROOF` after one was processed on the same stream
- **THEN** the Host rejects and closes the stream without retrying the challenge or replaying either proof
