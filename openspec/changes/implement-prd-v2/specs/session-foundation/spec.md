## MODIFIED Requirements

### Requirement: Observable reconnect outcome

Every browser connection attempt SHALL have an explicit time/attempt budget, preserve only state declared resumable by the mode, and surface terminal connection failure. Escape retains its bounded automatic reconnect-grace behavior. Leash MUST use explicit user-initiated fresh-stream attempts and MUST NOT convert a failed connection attempt or browser absence into completion of the Host share.

#### Scenario: Reconnect budget expires

- **WHEN** the browser cannot dial, authenticate, or complete admission within the applicable connection deadline
- **THEN** that attempt releases its resources and shows a bounded failure while the live Host share and local task continue under their independent deadlines

#### Scenario: Escape reconnect budget expires

- **WHEN** Escape connectivity cannot be restored within its negotiated policy
- **THEN** the Escape session enters a terminal failed state and releases its resources

### Requirement: Complete session lifecycle

Every share SHALL transition only through its declared creating, listening, connecting, authenticating, active, reconnect-grace, retained-result, expired, and closed states, with one terminal transition and idempotent cleanup. Escape MAY use reconnect-grace; phase-two Leash MUST return from a lost or closed active stream to listening while the share remains live. Mode completion, local revoke, explicit TTL, protocol failure, transport failure, connection loss, and Host shutdown MUST have distinct explicit outcomes.

#### Scenario: TTL expires while active

- **WHEN** authoritative share time reaches its configured nonzero expiry
- **THEN** the Host rejects new work and authentication, notifies the peer when safe, applies the selected child cleanup policy, drains transport within its bound, erases credentials, and exits with expiry/revocation code 8

#### Scenario: A Leash browser leaves

- **WHEN** its active Leash stream closes or fails and no independent share deadline has fired
- **THEN** the Host cancels connection-local work, releases the active slot, returns to listening, and preserves only the current task, bounded output, retained result, and share credentials

### Requirement: Mode-specific lifetime defaults

Escape SHALL default to a ten-minute invitation/share TTL and its existing reconnect grace. Phase-two Leash SHALL default to no wall-clock share TTL, no browser-absence deadline, and result retention until Host shutdown or local revoke. An explicit Leash total TTL MUST remain available; post-exit retention MUST accept `host`, zero for immediate share completion, or a bounded duration. Every share still closes on local revoke or its mode completion policy.

#### Scenario: Default Leash runs without a browser

- **WHEN** a default Leash Host stays alive after its browser disconnects and the child remains running or its result is retained
- **THEN** no hidden four-hour, reconnect-grace, or post-exit deadline expires the share

#### Scenario: A bounded post-exit duration is selected

- **WHEN** the child exits and its explicit post-exit duration elapses
- **THEN** the Host erases result, history, invitation, and access-authentication state and reaches its declared terminal outcome

#### Scenario: Zero TTL is selected

- **WHEN** a default or explicit zero total TTL is effective for Leash
- **THEN** the share has no wall-clock expiry but still closes on local revoke, Host shutdown, or its configured mode-completion policy and reports that Host-lived boundary locally

### Requirement: One active browser with bounded takeover

At most one authenticated identifier-2 Leash stream or valid identifier-1 Escape stream SHALL own the active browser slot. Leash code proof MUST complete before slot acquisition; unauthenticated peers do not consume the slot. A concurrent otherwise valid admitted connection MUST receive `SESSION_BUSY` without affecting the owner. After Leash disconnection, exactly one newly authenticated stream MAY atomically acquire the released slot while the share remains live; no device identity is inferred.

#### Scenario: Leaked link races during grace

- **WHEN** two streams complete valid authentication after the prior remote has left
- **THEN** at most one atomically acquires the active slot and receives welcome, while the other receives `SESSION_BUSY` and no task data

#### Scenario: Unauthenticated peers fill their separate limit

- **WHEN** one or more peers are waiting for or failing authentication while an active browser is connected
- **THEN** their bounded pending slots remain separate from the active slot and cannot evict, pause, or replace that browser

### Requirement: Bounded peer liveness

The Host SHALL detect an established connection with no valid PONG for 30 seconds using its one-hertz heartbeat and local monotonic time. Timing starts at successful `SERVER_WELCOME` and refreshes only on a PONG matching an outstanding PING sequence and timestamp on that connection. At the deadline, the Host MUST close that stream, cancel its connection-local work, and release the active lease. Leash then returns the live share to listening; Escape applies its existing reconnect-grace policy. The deadline MUST NOT extend an earlier share, mode, or shutdown deadline. Duplicate, stale, unmatched PONGs, other application data, and another connection's messages MUST NOT refresh it.

#### Scenario: Browser process crashes without closing the stream

- **WHEN** the active browser is killed and no valid PONG arrives for 30 seconds
- **THEN** the Host closes the old stream, frees its active slot, and accepts a newly authenticated replacement without restarting the child or replaying old input

#### Scenario: Valid heartbeat or unrelated traffic reaches the Host

- **WHEN** a current connection's valid PONG arrives before its deadline
- **THEN** its liveness time refreshes; duplicate, stale or unmatched PONGs, non-PONG data, and other peers' traffic cannot postpone the deadline

### Requirement: Reconnect preserves only declared state

A replacement connection SHALL use a new Tailcat stream, handshake, and—when protected—authentication challenge. It MUST retain only Host-authoritative share state and mode-declared bounded history, discard stale connection-local writes, input, challenges, proofs, pending controls, and active-slot claims, and resume only after new admission. Leash replacement remains available while its share is live; Escape retains its existing grace limit.

#### Scenario: Leash reconnects after a long absence

- **WHEN** the original browser returns with the original invitation and access code after browser-connection deadlines have elapsed but before the Host share ends
- **THEN** a successful new authentication receives current state, bounded history, drop count, and live output without restarting the child or replaying input from the prior stream

#### Scenario: Escape reconnects during grace

- **WHEN** a valid Escape replacement completes negotiation before its existing grace deadline
- **THEN** it receives current authoritative game state and no movement intent queued by the old stream is replayed
