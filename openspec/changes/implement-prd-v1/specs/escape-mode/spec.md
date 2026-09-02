## ADDED Requirements

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
