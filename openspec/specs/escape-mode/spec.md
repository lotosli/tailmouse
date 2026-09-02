# Escape mode specification

## Purpose

Define the v0.1 `tailmouse escape` game: a short host-authoritative cat-and-mouse session in which real application-level latency shapes the chase while the browser remains immediately responsive.

## Requirements

### Requirement: Fixed P0 game rules

An escape round SHALL use a 48 by 18 logical grid selected by seed from five prebuilt solvable maps, one mouse, one cat, two cheeses, and an exit that unlocks only after both cheeses are collected. The host SHALL declare victory when the mouse enters the unlocked exit, defeat when cat and mouse centers are less than 0.55 cell apart, and timeout after the configured round duration, which defaults to 45 seconds.

#### Scenario: Mouse reaches the exit too early

- **WHEN** the mouse enters the exit before collecting both cheeses
- **THEN** the host keeps the exit locked and does not declare victory

#### Scenario: Host detects capture

- **WHEN** the host-authoritative cat and mouse centers become less than 0.55 cell apart
- **THEN** the host ends the round as a cat victory exactly once

### Requirement: Host-authoritative simulation

The host SHALL be the only authority for collision, collectibles, exit state, timer, and final outcome. It SHALL simulate at 30 Hz, send world snapshots at 10 Hz, and accept browser movement intent at no more than 20 Hz rather than accepting client-authored positions.

#### Scenario: Browser reports a conflicting predicted position

- **WHEN** browser prediction disagrees with the next host snapshot
- **THEN** the browser reconciles to host state and cannot alter the authoritative outcome

### Requirement: Latency participates in the chase

The cat SHALL pursue the mouse's latency-delayed scent position using application-level RTT clamped from 40 ms through 250 ms, while bounded speed compensation prevents latency from making the cat indefinitely weaker. Both browser and terminal views SHALL display the measured application-level RTT and connection state.

#### Scenario: RTT increases during a round

- **WHEN** measured RTT increases within the supported range
- **THEN** the visible scent trail lengthens and the cat targets an older mouse position without exceeding its maximum speed

### Requirement: Continuous and discrete input are bounded

Only one continuous movement write SHALL be in flight; a newer unsent movement intent MUST replace the older unsent movement intent. Discrete actions such as dash MUST retain order and MUST NOT be discarded by movement coalescing.

#### Scenario: Movement arrives faster than transport can send it

- **WHEN** several movement intents arrive while one movement write is blocked
- **THEN** at most the newest unsent movement remains queued and stale movement is not replayed later

### Requirement: Browser prediction reconciles explicitly

The browser SHALL render local movement immediately. On an authoritative snapshot, an error below 0.25 cell SHALL reconcile within 100 ms, an error from 0.25 through 1.0 cell SHALL reconcile within 200 ms, and an error above 1.0 cell SHALL snap immediately with visible correction feedback. A snapshot whose server sequence is not newer than the last applied snapshot MUST be ignored.

#### Scenario: A stale snapshot arrives after a newer snapshot

- **WHEN** its server sequence is less than or equal to the last applied sequence
- **THEN** the browser discards it without moving the predicted mouse backward

### Requirement: Connection loss has a bounded game outcome

After 150 ms without input the host SHALL begin slowing the mouse, after 500 ms it SHALL stop the mouse, after 3 seconds it SHALL pause the round and show connection loss, and reconnection within 30 seconds SHALL resume the round. When that grace expires, the host SHALL end the round visibly and release session resources.

#### Scenario: Network pauses for 300 milliseconds

- **WHEN** connectivity resumes after a 300 ms pause
- **THEN** the mouse has begun slowing, no stale movement queue is replayed, and the round can continue

#### Scenario: Reconnect grace expires

- **WHEN** the browser remains disconnected for more than 30 seconds
- **THEN** the host ends the round and does not keep an active player slot

### Requirement: Controls degrade without blocking play

Touch SHALL be the default control and require no browser permission. Tilt SHALL be enabled only by an explicit user gesture, SHALL perform calibration after permission is granted, and MUST fall back to touch when permission is denied or the capability is unavailable.

#### Scenario: Tilt permission is denied

- **WHEN** the player requests tilt and the browser denies permission
- **THEN** the game remains playable with touch and reports the fallback without exposing invitation material

### Requirement: One active player per session

An escape session SHALL permit only one active browser player, SHALL reject additional players without changing the running round, and MUST keep ConnBlob and invitation material out of diagnostics and persisted state.

#### Scenario: A second browser attempts to join

- **WHEN** one authenticated player is already active
- **THEN** the host rejects the second player with a bounded non-secret response
