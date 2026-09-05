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

### Requirement: Escape command configuration

`tailmouse escape` SHALL support control `touch|tilt`, TTL default 10 minutes, once default true, deterministic seed, one of five map names or random, round duration default 45 seconds within the accepted 30-45 second range, and independent phone, terminal, and network-HUD toggles.

#### Scenario: Seed and map are repeated

- **WHEN** two rounds use the same explicit seed and map selection
- **THEN** initial map, mouse, cat, cheese, exit, and deterministic simulation state are identical

### Requirement: Fixed movement and dash tuning

The P0 simulation SHALL use mouse speed 6.0 cells/s, cat base speed 5.3 cells/s, cat maximum speed 6.2 cells/s, dash multiplier 2.2, dash duration 350 ms, dash cooldown 5 seconds, and countdown 3 seconds as centralized product constants rather than user-facing extensibility.

#### Scenario: Dash is requested during cooldown

- **WHEN** a valid player requests another dash before the five-second cooldown expires
- **THEN** the host rejects or ignores that event deterministically and the browser displays the authoritative remaining cooldown

### Requirement: Prebuilt solvable map set

Exactly five named 48 by 18 prebuilt maps SHALL define bounded walls, traversable spawn points, two cheeses, and one exit, and MUST be proven solvable without adding a random maze generator.

#### Scenario: Map validation runs

- **WHEN** each checked-in map is evaluated from the mouse spawn
- **THEN** both cheese cells and the exit are reachable and all entities occupy legal distinct positions

### Requirement: RTT-shaped cat behavior

Every host simulation tick SHALL append a bounded timestamped mouse scent point, interpolate the cat target at current time minus RTT EWMA clamped to 40-250 ms, and compute cat speed as `min(6.2, 5.3 + rtt_ms * 0.003)`.

#### Scenario: Requested scent time falls between samples

- **WHEN** the delayed target timestamp lies between two retained scent points
- **THEN** the host linearly interpolates a legal target without reading future or discarded points

### Requirement: Bounded RTT-shaped scent presentation

Both Escape views SHALL show scent dots on their existing mouse-position history, with a visible age window of twice RTT EWMA clamped to 40-250 ms. Display sampling SHALL alternate gaps of `50 ms +/- min(jitter / 2, 25 ms)` without random displacement, future points or changes to cat pursuit. Dots MAY be quantized or overlap at the available sample/cell resolution. The browser SHALL retain at most 16 rendered positions at no more than 30 Hz; these are visual prediction history, not authoritative game state. No additional protocol payload is required.

#### Scenario: Latency and jitter change during movement

- **WHEN** the same sufficiently sampled moving path is rendered with a higher RTT within the clamp
- **THEN** the selected history extends farther back without exceeding 500 ms or 16 points
- **AND** nonzero jitter produces alternating longer/shorter sample gaps rather than changing any recorded position

#### Scenario: Display history is no longer continuous

- **WHEN** a new round starts, gameplay stops/pauses/counts down, rendering resumes after more than 100 ms, or the displayed mouse jumps more than one cell
- **THEN** browser scent history clears before recording the new displayed path
- **AND** teardown cannot retain history for another connection

### Requirement: Touch and tilt input details

Touch input SHALL use a gesture-centered joystick, dead zone 0.08, maximum radius 18% of the viewport short side, normalized magnitude from zero through one, and zero movement on touch end or cancellation. Tilt SHALL require a user gesture, permission, one-second calibration, beta/gamma filtering, and automatic touch fallback.

#### Scenario: Touch is canceled by the browser

- **WHEN** an active joystick receives cancellation or loses its pointer
- **THEN** the client immediately produces zero intent and leaves no stuck movement

### Requirement: Escape presentation

The browser SHALL render the full map, mouse, cat, cheeses, exit state, joystick, dash cooldown, RTT, connection state, control toggle, mute, exit, and correction feedback at a target 60 FPS. The terminal SHALL render a spectator map and network HUD at a target 20 FPS with quit, post-round restart, and debug toggles.

#### Scenario: Phone rendering is disabled

- **WHEN** the host configuration disables phone rendering
- **THEN** the session retains control and accessible state feedback without claiming the standard visual game experience

#### Scenario: Host presentation policy reaches the browser

- **WHEN** a game initializes with the PRD control, phone-render and network-HUD flags
- **THEN** its strict initialization payload carries those three settings and the browser applies them without treating them as capability grants
- **AND** selecting tilt still requires a user gesture, with touch available before permission or after refusal

#### Scenario: Retained round restarts from the local terminal

- **WHEN** the local user presses `r` after a result in an unexpired `--once=false` session
- **THEN** exactly one new round uses the same selected configuration and original session expiry
- **AND** old connection input cannot cross the restart boundary, initialization precedes the new snapshots, and both views leave the previous result

#### Scenario: Terminal rendering or output is unavailable

- **WHEN** terminal rendering is disabled or stdout is redirected
- **THEN** the CLI does not emit an ANSI animation stream, still reports the authoritative result, and retains local session revocation

### Requirement: Local mouse prediction and correction

The browser SHALL predict mouse movement immediately from local intent without waiting for a network round trip. Every fresh authoritative snapshot SHALL reconcile error below 0.25 cell within 100 ms, error from 0.25 through 1.0 cell within 200 ms, and larger error by immediate snap with visible dust feedback. Snapshots whose sequence is not newer MUST NOT affect prediction. Prediction MUST NOT collect cheese, unlock the exit, move the cat or decide an outcome.

#### Scenario: An authoritative correction arrives during local movement

- **WHEN** a fresh snapshot differs from the predicted mouse position
- **THEN** the browser applies the matching correction band while continuing immediate current-intent feedback
- **AND** all game outcomes and non-mouse state remain the host's unchanged state

#### Scenario: Rendering resumes after suspension

- **WHEN** the animation loop resumes after a gap above 100 ms
- **THEN** elapsed movement is discarded instead of replayed in a burst
- **AND** a new round or connection starts from its own authoritative state

### Requirement: Result summary

Every completed round SHALL produce exactly one authoritative result showing outcome, elapsed time, relay, RTT p50/p95, jitter when available, and the PRD result message without leaking invitation data.

#### Scenario: Round times out

- **WHEN** authoritative time reaches the configured duration without escape or capture
- **THEN** the host closes gameplay with one timeout result and both views converge on that outcome

### Requirement: Escape impairment acceptance

At simulated 150 ms RTT and 30 ms jitter, browser movement SHALL remain immediately responsive through local prediction. A 300 ms network pause MUST NOT replay a stale input backlog, and disconnection MUST stop then pause the mouse according to the accepted timing rules.

#### Scenario: Impairment profile is applied

- **WHEN** the standard latency/jitter profile runs against an active round
- **THEN** prediction, latest-only input, host authority, RTT display, and bounded payload measurements all remain within their specified behavior

#### Scenario: Reliable transport delivers a stale input backlog

- **WHEN** an active input stream resumes after a gap longer than 150 ms
- **THEN** the host drains old movement through a validated post-gap PING/PONG boundary before accepting fresh input
- **AND** old dash requests are explicitly rejected, and neither stale input nor the barrier PONG resets the stop, pause or grace deadlines
