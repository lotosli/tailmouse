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

### Requirement: Leash command snapshot and start policy

`tailmouse leash -- <command> [args...]` SHALL snapshot exact argv, cwd, and inherited environment with explicit overrides, title, readonly/control flags, TTL default four hours, post-exit TTL default ten minutes, reconnect grace default 30 seconds, scrollback default 1 MiB, local-input policy, and start policy `connect-or-enter|now|connect`. It MUST start no other command.

#### Scenario: Default leash waits for access

- **WHEN** start policy is `connect-or-enter`
- **THEN** TailMouse displays the invitation before allocating a PTY and starts exactly once after either a valid browser HELLO or local Enter

#### Scenario: Browser displays the original command title

- **WHEN** the host publishes a waiting, running, restarted or exited process
- **THEN** its display-only title is the command basename or explicit `--title`, rendered as plain text from the immutable snapshot without exposing argv, cwd or environment

### Requirement: Cross-platform terminal process boundary

macOS and Linux SHALL use a Unix PTY with an independent process group, raw local terminal, SIGWINCH handling, and whole-group signals. Windows 11 SHALL use ConPTY and a Job Object for the full child tree, preferring Ctrl+C/Ctrl+Break for interrupt. Both paths MUST use UTF-8, `TERM=xterm-256color`, initial 80 by 24 size, merged PTY output, and no application-specific screen parsing.

#### Scenario: Full-screen TUI starts

- **WHEN** a supported alternate-screen terminal application runs
- **THEN** local and browser terminals render its ANSI, cursor, resize, and Unicode behavior without OCR, screenshots, or program-specific adapters

### Requirement: Single-reader output fanout

Exactly one native reader SHALL consume the PTY master and fan each byte sequence to local stdout, the bounded raw-byte scrollback ring, and the active browser subscriber. A blocked or absent browser MUST NOT block PTY consumption or the child.

#### Scenario: Browser output buffer fills

- **WHEN** the active browser cannot accept more bounded output
- **THEN** host delivery drops oldest eligible buffered output, increments dropped bytes, informs the browser, and continues local and child operation

### Requirement: Serialized input and resize

Local stdin and authorized browser input SHALL enter one serialized PTY writer preserving accepted order. The most recent local or browser size SHALL apply after 50 ms debounce within 20 by 5 and 500 by 200; invalid sizes MUST be rejected.

#### Scenario: Local and browser input arrive concurrently

- **WHEN** both inputs are accepted during the same scheduling interval
- **THEN** each accepted byte sequence is written atomically in one deterministic queue order without concurrent PTY writes

#### Scenario: Windows local console input and redirected streams

- **WHEN** Windows Leash reads local keyboard or buffer-size events
- **THEN** native key values, Unicode units, modifiers and repeats reach the owned ConPTY without application-specific translation, while local Ctrl+C and Enter retain the existing owner policy
- **AND** resize uses the current viewport and existing debounce, not an independent polling worker
- **WHEN** local input or output is redirected to a file or pipe
- **THEN** bytes are preserved, cancellation joins the local I/O operation, and cleanup leaves the caller's original handles usable
- **AND** cleanup restores changed console modes and releases private handles without allowing a late cancellation callback to affect another operation

### Requirement: Browser terminal controls

The browser SHALL provide xterm ANSI-256 rendering, fit/resize, cursor and alternate screen, touch scrolling, explicit copy/paste, mobile Esc/Tab/arrows, one-shot and lockable Ctrl/Alt, process/elapsed/RTT/connection status, and confirmed interrupt/restart/terminate controls. Readonly mode MUST hide and reject all input and process controls at the host.

#### Scenario: User scrolls terminal history by touch

- **WHEN** a single-finger vertical gesture moves over the normal terminal buffer
- **THEN** the visible history scrolls locally without emitting terminal input or moving the page, including for readonly viewers
- **AND** cancellation, a second finger, reset or disposal discards the gesture, pinch zoom remains available, and alternate-screen input is not synthesized from a history gesture

#### Scenario: Terminal replies while a virtual modifier is armed

- **WHEN** xterm emits a device/cursor response, focus report, paste, or composed text while virtual Ctrl or Alt is armed
- **THEN** that data is sent unchanged without consuming the modifier, which applies only to key sequences, non-composing text input, and explicit shortcut buttons

#### Scenario: User pastes more than 32 KiB

- **WHEN** an explicit paste exceeds one terminal input frame
- **THEN** the browser splits it into ordered chunks no larger than 32 KiB and stops with visible backpressure before the host queue exceeds 256 KiB

### Requirement: Scrollback reconnection sequence

The raw-byte scrollback ring SHALL be configurable from 64 KiB through 16 MiB. A newly accepted browser MUST receive `TERM_RESET`, one consistent scrollback snapshot, any dropped-byte indication, then live output without gaps or reordering at the snapshot boundary.

#### Scenario: Earlier output was discarded

- **WHEN** a reconnect snapshot follows ring overwrite
- **THEN** the browser displays the exact accumulated dropped-byte count before or with the retained output

### Requirement: Process control semantics

Interrupt SHALL signal the active process group using platform-native terminal semantics. Terminate SHALL attempt graceful whole-tree termination, wait at most five seconds, then force the owned Unix job-control groups or Windows Job Object. Restart SHALL terminate any running generation, await tree exit, clear pending input, add a marker, recreate a PTY from the immutable snapshot, increment generation, and broadcast running state.

#### Scenario: Interactive shell has a foreground job

- **WHEN** a shell gives its PTY foreground to a separate job group
- **THEN** Interrupt signals that foreground group, allowing the shell to collect the job's outcome without receiving an unintended shutdown
- **AND** the operating system resolves the signal target through the owned PTY, without a userspace lookup-then-signal race against a reusable numeric process-group identifier

#### Scenario: Unix termination includes a separate foreground job

- **WHEN** an interactive Unix shell has transferred its controlling PTY to a separate foreground job group when Terminate or final cleanup begins
- **THEN** the owner validates that group against the generation's session, retains it with any previously observed foreground groups, and signals those groups before the original session-leader group
- **AND** graceful completion requires every retained group to disappear within five seconds; otherwise final cleanup sends SIGKILL and observes both the original child outcome and all retained groups before releasing the PTY
- **AND** a retained group that outlives its leader remains owned, while a reused numeric identifier belonging to another session is never signaled
- **AND** a descendant that deliberately creates an unrelated session is outside this portable PTY/process-group ownership boundary

#### Scenario: Explicit interrupt leaves the process running

- **WHEN** an authorized explicit interrupt is delivered successfully and the child continues running
- **THEN** the browser receives the interrupting acknowledgment before the subsequent running state, even if the owner publishes both before the sender drains its next state
- **AND** the browser may accept input again without mistaking a pre-request running frame for the acknowledgment
- **AND** a reconnect or new generation receives only its current snapshot, not an old stream's retained acknowledgment

#### Scenario: Child exits after a control was queued

- **WHEN** a control is accepted while running but the generation exits before the process owner consumes it
- **THEN** the owner rechecks process state, lease and generation and performs no stale Interrupt or Terminate effect
- **AND** an explicitly authorized Restart remains valid from exited, while failed or waiting states do not accept delayed process controls

#### Scenario: Windows explicit interrupt reaches a raw-mode child

- **WHEN** the user confirms Interrupt for a Windows ConPTY whose child disables processed input
- **THEN** the host delivers native Ctrl+Break semantics through that owned console without changing the host's own console attachment or selecting a reusable PID
- **AND** the fixed control sequence cannot interleave with an accepted input chunk, cancellation releases queued writers, and delivery failure is reported within two seconds without automatic termination or retry
- **AND** ordinary local Ctrl+C remains child input, and a child that handles and ignores the explicit event may continue running

#### Scenario: Windows graceful termination retains whole-job ownership

- **WHEN** Terminate requests console closure for a running Windows generation
- **THEN** attached clients receive the native close event while terminal output continues draining independently
- **AND** a still-running job member, including a descendant that detached from the console or outlived the root, is forcibly terminated after at most five seconds
- **AND** cancellation shortens the grace period without skipping bounded cleanup, repeated or concurrent cleanup joins the same owned workers, and the original root exit status is preserved

#### Scenario: Restart request changes command data

- **WHEN** a browser payload includes or implies new argv, cwd, or environment
- **THEN** the host rejects it and may restart only the stored original snapshot

#### Scenario: Starting and running each publish a reset

- **WHEN** a connection receives another terminal reset, including a second snapshot in the same restarted generation
- **THEN** the browser discards old queued input and waits for the new process state and an ordered post-state PONG before accepting input or controls again
- **AND** a heartbeat preceding that reset cannot authorize the new snapshot

### Requirement: Local interrupt behavior

While waiting, local Ctrl+C SHALL close TailMouse. While a child runs, the first Ctrl+C SHALL reach the child; a second within two seconds SHALL request confirmed TailMouse and process-tree shutdown. TailMouse MUST NOT intercept ordinary `q` input in PTY mode and MUST restore local terminal state on every exit.

#### Scenario: Child handles the first Ctrl+C

- **WHEN** the child remains running after the first local interrupt
- **THEN** TailMouse keeps the session active and treats the signal as child input rather than host revocation

### Requirement: Child lifecycle and exit result

The host SHALL expose waiting, starting, running, interrupting, terminating, exited, restarting, failed, and closing states with generation, safe PID, start time, exit code, and signal. Browser disconnect MUST leave the child running by default; expiry MUST also leave it running unless the corresponding explicit kill flag is set. Final leash exit SHALL preserve the last child code unless TailMouse itself fails, in which case the applicable stable host error classification takes precedence.

#### Scenario: Windows returns a full-width exit status

- **WHEN** a terminated native process returns an unsigned 32-bit status, including a value above 255
- **THEN** native state and browser presentation preserve that exact value without truncation or treating the status as malformed
- **AND** the wire rejects negative, fractional and greater-than-32-bit exit values

#### Scenario: Required cleanup fails after a nonzero child result

- **WHEN** a child exits nonzero and required process, terminal, transport or final diagnostic cleanup fails
- **THEN** the host reports its own stable failure code instead of misrepresenting the failure as only the child's outcome
- **AND** cleanup or diagnostic failures do not replace an earlier protocol, transport or internal root failure

#### Scenario: Child exits while browser is disconnected

- **WHEN** the process exits during reconnect grace
- **THEN** local state records the result, reconnect receives the final state and scrollback during post-exit TTL, and no process is silently restarted

### Requirement: Native GUI limitation is explicit

Leash SHALL allow an explicitly named GUI-launching command but MUST expose only its PTY bytes and process state. Help and README SHALL state that terminal applications and TUIs are supported and native GUI windows or the desktop are not streamed.

#### Scenario: GUI application opens a native window

- **WHEN** the child produces no terminal UI but creates a platform window
- **THEN** the browser shows only available process state and terminal output without claiming or attempting screen access
