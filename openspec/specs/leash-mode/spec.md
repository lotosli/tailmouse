# Leash mode specification

## Purpose

Define the v0.1 leash contract for exposing explicitly negotiated remote assistance to a local terminal without granting implicit device-wide authority.

## Requirements

### Requirement: Capabilities are deny-by-default

A leash session SHALL expose only capabilities explicitly negotiated for that session, and the native side MUST reject any unnegotiated operation before invoking a platform API.

#### Scenario: Peer requests an undeclared capability

- **WHEN** a peer sends an operation for a capability absent from the negotiated set
- **THEN** the native host rejects it with no platform side effect

### Requirement: User-mediated privileged action

Any operation that injects input or accesses a protected platform capability MUST follow the mode's explicit consent and visibility policy and SHALL be cancelable.

#### Scenario: Required consent is absent

- **WHEN** a privileged operation arrives without the active consent state
- **THEN** the operation fails closed and the local user receives a non-secret indication

### Requirement: Responses are bounded

Leash request and response payloads SHALL have per-operation size/time limits and MUST propagate terminal failure without unbounded retry or buffering.

#### Scenario: Platform call does not return

- **WHEN** the operation exceeds its accepted deadline
- **THEN** it is canceled and the peer receives a bounded failure without starting a hidden retry loop

### Requirement: Session authority is ephemeral

Leash capability grants MUST end with the session and MUST NOT be persisted as implicit authorization for later invitations or peers.

#### Scenario: A new peer connects later

- **WHEN** a prior leash session has ended and another session starts
- **THEN** the new peer has no inherited capability grant
