# Session foundation specification

## Purpose

Define the interoperable and bounded session behavior used by protected Leash and resource sharing without binding the TMOUSE/1 contract to either runtime implementation.

## Requirements

### Requirement: Explicit protocol negotiation

Each session MUST validate the TMOUSE protocol version, role, mode and negotiated capabilities before accepting mode data or side effects.

#### Scenario: Peer presents an unsupported version

- **WHEN** the opening handshake identifies an unsupported protocol version
- **THEN** the receiver rejects the session with a bounded non-secret reason and performs no mode action

### Requirement: Strict framed input

Every frame SHALL have a defined maximum length and legal session states, and a receiver MUST reject truncation, overflow, unknown mandatory semantics and illegal transitions before unbounded allocation.

#### Scenario: Declared frame length exceeds its limit

- **WHEN** a peer declares a frame larger than the limit for its type
- **THEN** the receiver closes the protocol path without allocating the declared size

### Requirement: Bounded flow control

Session senders and receivers SHALL apply bounded buffering and backpressure and MUST propagate cancellation to blocked operations.

#### Scenario: Consumer stops reading

- **WHEN** buffered data reaches the accepted limit
- **THEN** the producer blocks or fails according to the specified flow policy without unbounded memory growth

### Requirement: Observable reconnect outcome

Reconnect behavior SHALL have an explicit time/attempt budget, preserve only state declared resumable by the mode spec, and surface terminal failure.

#### Scenario: Reconnect budget expires

- **WHEN** connectivity cannot be restored within the negotiated policy
- **THEN** the session enters a terminal failed state and releases its resources

### Requirement: Complete session lifecycle

Every session SHALL transition only through creating, listening, connecting, active, reconnect-grace, expired, and closed states as applicable, with one terminal transition and idempotent cleanup. Mode completion, local revoke, TTL, protocol failure, transport failure, and grace expiry MUST have explicit outcomes.

#### Scenario: TTL expires while active

- **WHEN** authoritative session time reaches its nonzero expiry
- **THEN** the host rejects new mode work, notifies the peer when safe, applies mode cleanup policy, drains transport within its bound, and exits with expiry/revocation code 8

### Requirement: Mode-specific lifetime defaults

Resource sessions SHALL default to one hour and one visitor. Protected legacy Leash SHALL default to host lifetime, host-retained process results and no browser-absence deadline; obsolete reconnect-grace settings SHALL fail with migration guidance. TTL zero MAY retain a session only until host exit or mode completion and SHALL produce a warning for public sharing.

#### Scenario: Zero TTL is selected

- **WHEN** a user explicitly configures unlimited host lifetime
- **THEN** TailMouse accepts it, displays the elevated bearer-risk warning, and still closes on local revoke or mode completion

### Requirement: One active browser with bounded takeover

The first connection completing a valid HELLO SHALL own the active slot. A concurrent valid connection MUST receive `SESSION_BUSY` without affecting the owner. After disconnect, exactly one valid replacement MAY take over during grace, with no claim of strong device identity.

#### Scenario: Leaked link races during grace

- **WHEN** two replacement connections present the same bearer invitation
- **THEN** at most one atomically acquires the slot and the other receives `SESSION_BUSY`

### Requirement: Bounded peer liveness

As confirmed in PRD section 7.4 on 2026-09-03, the Host SHALL detect an established connection with no valid PONG for 30 seconds using its existing one-hertz heartbeat and local monotonic time. Timing starts at successful handshake and refreshes only on a PONG matching an outstanding PING sequence and timestamp on that connection. At the deadline, the Host MUST close that stream, cancel its connection-local work, release the active lease and apply the existing disconnect/grace policy without waiting for underlying TCP failure. The deadline MUST NOT extend invitation TTL, an earlier session/mode deadline or an existing shutdown. Duplicate, stale, unmatched PONGs, other application data and another connection's messages MUST NOT refresh it.

#### Scenario: Browser process crashes without closing the stream

- **WHEN** the active browser is forcibly killed without sending CLOSE and no valid PONG arrives for 30 seconds
- **THEN** the Host closes the old stream and frees its active slot before accepting a replacement during the existing reconnect grace
- **AND** default Leash policy keeps the same child and local terminal alive, and the replacement receives reset/history/live output without restarting the child or replaying old input
- **AND** an explicitly selected kill-on-disconnect policy still applies

#### Scenario: Valid heartbeat or unrelated traffic reaches the Host

- **WHEN** a current connection's valid PONG arrives before its deadline
- **THEN** its liveness time refreshes and missing-PONG detection cannot declare it lost before another 30 seconds without a valid PONG; independent expiry, shutdown and mode outcomes still apply
- **AND** duplicate, stale or unmatched PONGs, non-PONG data and other peers' traffic cannot postpone that deadline

### Requirement: Capabilities are host-authoritative

The host SHALL derive capabilities from mode and local flags, publish them in welcome, and check them again before every input, resize, control, or other side effect. Browser declarations and MouseCard fields MUST NOT grant authority.

#### Scenario: Readonly browser sends terminal input

- **WHEN** a syntactically valid input frame arrives in a readonly session
- **THEN** the host returns `READONLY`, writes no PTY bytes, and retains the session unless policy requires closure

### Requirement: Reconnect preserves only declared state

Reconnect SHALL create a new Tailcat stream and protocol handshake, retain host-authoritative mode state, discard stale connection-local writes, and resume only the state defined by the active mode. Grace expiry MUST free the browser slot and mode resources according to policy.

#### Scenario: A browser reconnects to a live terminal

- **WHEN** a valid replacement completes negotiation while the Host share remains live
- **THEN** it receives the current terminal reset, process state and scrollback, and no terminal input queued by the old stream is replayed

### Requirement: Ordered bounded shutdown

Shutdown SHALL stop accepting frames, cancel connection-local work, close the application stream, clean up the mode, drain Tailcat for at most two seconds, close Tailcat, restore the terminal, and erase invitation references. Repeating shutdown MUST be safe.

#### Scenario: Tailcat drain exceeds its deadline

- **WHEN** drain remains incomplete after two seconds
- **THEN** TailMouse preserves the root outcome, force-closes transport, completes remaining cleanup, and reports the bounded drain failure safely
