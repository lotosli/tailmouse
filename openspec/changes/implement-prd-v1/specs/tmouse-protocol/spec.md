## Purpose

Define the interoperable TMOUSE/1 byte protocol shared by native Go and browser TypeScript implementations over one Tailcat stream.

## ADDED Requirements

### Requirement: Single bounded virtual stream

TMOUSE/1 SHALL use one reliable ordered Tailcat virtual TCP stream on port 44321. The host MUST reject other virtual ports, and TMOUSE/1 MUST NOT add encryption, compression, or retransmission above Tailcat.

#### Scenario: Client dials another virtual port

- **WHEN** a peer attempts a connection to any port other than 44321
- **THEN** the host rejects or resets it before creating a TailMouse session

### Requirement: Exact frame envelope

Each frame SHALL contain a four-byte unsigned big-endian length followed by one-byte type, one-byte flags, and payload, where length excludes its own field and includes type, flags, and payload. A frame MUST be at least two bytes after the length and at most 1 MiB; terminal input and output frames MUST be at most 32 KiB.

#### Scenario: Length exceeds the allowed maximum

- **WHEN** a receiver reads an oversized declared length
- **THEN** it emits `FRAME_TOO_LARGE` when safely possible, allocates no declared-size buffer, and closes the session

#### Scenario: Stream ends within a frame

- **WHEN** EOF occurs after a frame length but before the complete envelope arrives
- **THEN** the receiver classifies `BAD_FRAME`, closes the session, and never dispatches partial payload

### Requirement: Fixed v1 message registry

TMOUSE/1 SHALL implement the PRD type IDs and directions for `CLIENT_HELLO` 0x01, `SERVER_WELCOME` 0x02, `ERROR` 0x03, `PING` 0x04, `PONG` 0x05, `CLOSE` 0x06, terminal messages 0x10 through 0x16, and game messages 0x20 through 0x24. Control payloads SHALL use bounded JSON and high-frequency game payloads SHALL use documented fixed binary layouts.

#### Scenario: Message arrives in an illegal direction or state

- **WHEN** a known message type is sent by the wrong peer or before its required handshake state
- **THEN** the receiver rejects it as `BAD_FRAME` or `UNAUTHORIZED_CAPABILITY` without invoking mode behavior

#### Scenario: Unknown type arrives

- **WHEN** a frame has an unrecognized mandatory type or nonzero unsupported flag
- **THEN** the receiver fails closed with a bounded protocol error

### Requirement: Authoritative handshake

The first browser message MUST be `CLIENT_HELLO` containing protocol min/max, session ID, mode, bounded client identity, and optional terminal dimensions. The host MUST select a mutually supported protocol, validate the session and mode, and reply with `SERVER_WELCOME` containing authoritative mode, state, expiry, relay description, and capabilities before accepting mode traffic.

#### Scenario: No protocol version overlaps

- **WHEN** the client and host ranges have no common version
- **THEN** the host returns `PROTOCOL_MISMATCH` and closes without allocating a player or starting a child

### Requirement: Application-level latency measurement

Both peers SHALL support one-hertz PING/PONG with an unsigned 64-bit sequence and monotonic send timestamp echoed unchanged. The measuring peer SHALL compute RTT EWMA with alpha 0.2, jitter EWMA from absolute consecutive RTT difference with alpha 0.2, and p50/p95 over the latest 60 samples without deriving one-way latency.

#### Scenario: Pong sequence does not match an outstanding ping

- **WHEN** a duplicate, stale, or unsolicited PONG arrives
- **THEN** it is ignored for latency statistics and does not change session authority

### Requirement: Stable error vocabulary

Error frames SHALL contain bounded code, human message, and retryable status and MUST support `BAD_MOUSE_CARD`, `EXPIRED`, `MODE_MISMATCH`, `PROTOCOL_MISMATCH`, `SESSION_BUSY`, `UNAUTHORIZED_CAPABILITY`, `FRAME_TOO_LARGE`, `BAD_FRAME`, `PROCESS_NOT_RUNNING`, `RESTART_DISABLED`, `TERMINATE_DISABLED`, `READONLY`, `BACKPRESSURE`, and `INTERNAL` without embedding credentials or terminal data.

#### Scenario: Internal failure contains sensitive upstream text

- **WHEN** an internal or Tailcat error includes credential-shaped content
- **THEN** the protocol sends a classified redacted `INTERNAL` error and retains no original text in the frame

### Requirement: Cross-language conformance

Go and TypeScript codecs MUST accept and reject the same versioned golden corpus, including boundary, malformed, and fragmentation cases, and every decoder MUST be fuzzed or property-tested against bounded arbitrary input.

#### Scenario: A wire definition changes

- **WHEN** either codec or a frame layout changes
- **THEN** the shared protocol specification and fixtures change first and both runtimes pass the same conformance cases
