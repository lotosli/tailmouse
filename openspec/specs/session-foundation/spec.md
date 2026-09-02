# Session foundation specification

## Purpose

Define the interoperable and bounded session behavior shared by escape and leash without binding the TMOUSE/1 contract to either runtime implementation.

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
