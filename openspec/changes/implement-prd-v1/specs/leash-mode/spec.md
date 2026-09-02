## ADDED Requirements

### Requirement: Leash command snapshot and start policy

`tailmouse leash -- <command> [args...]` SHALL snapshot exact argv, cwd, and inherited environment with explicit overrides, title, readonly/control flags, TTL default four hours, post-exit TTL default ten minutes, reconnect grace default 30 seconds, scrollback default 1 MiB, local-input policy, and start policy `connect-or-enter|now|connect`. It MUST start no other command.

#### Scenario: Default leash waits for access

- **WHEN** start policy is `connect-or-enter`
- **THEN** TailMouse displays the invitation before allocating a PTY and starts exactly once after either a valid browser HELLO or local Enter

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

### Requirement: Browser terminal controls

The browser SHALL provide xterm ANSI-256 rendering, fit/resize, cursor and alternate screen, touch scrolling, explicit copy/paste, mobile Esc/Tab/arrows, one-shot and lockable Ctrl/Alt, process/elapsed/RTT/connection status, and confirmed interrupt/restart/terminate controls. Readonly mode MUST hide and reject all input and process controls at the host.

#### Scenario: User pastes more than 32 KiB

- **WHEN** an explicit paste exceeds one terminal input frame
- **THEN** the browser splits it into ordered chunks no larger than 32 KiB and stops with visible backpressure before the host queue exceeds 256 KiB

### Requirement: Scrollback reconnection sequence

The raw-byte scrollback ring SHALL be configurable from 64 KiB through 16 MiB. A newly accepted browser MUST receive `TERM_RESET`, one consistent scrollback snapshot, any dropped-byte indication, then live output without gaps or reordering at the snapshot boundary.

#### Scenario: Earlier output was discarded

- **WHEN** a reconnect snapshot follows ring overwrite
- **THEN** the browser displays the exact accumulated dropped-byte count before or with the retained output

### Requirement: Process control semantics

Interrupt SHALL signal the active process group using platform-native terminal semantics. Terminate SHALL attempt graceful whole-tree termination, wait at most five seconds, then force the Unix process group or Windows Job Object. Restart SHALL terminate any running generation, await tree exit, clear pending input, add a marker, recreate a PTY from the immutable snapshot, increment generation, and broadcast running state.

#### Scenario: Restart request changes command data

- **WHEN** a browser payload includes or implies new argv, cwd, or environment
- **THEN** the host rejects it and may restart only the stored original snapshot

### Requirement: Local interrupt behavior

While waiting, local Ctrl+C SHALL close TailMouse. While a child runs, the first Ctrl+C SHALL reach the child; a second within two seconds SHALL request confirmed TailMouse and process-tree shutdown. TailMouse MUST NOT intercept ordinary `q` input in PTY mode and MUST restore local terminal state on every exit.

#### Scenario: Child handles the first Ctrl+C

- **WHEN** the child remains running after the first local interrupt
- **THEN** TailMouse keeps the session active and treats the signal as child input rather than host revocation

### Requirement: Child lifecycle and exit result

The host SHALL expose waiting, starting, running, interrupting, terminating, exited, restarting, failed, and closing states with generation, safe PID, start time, exit code, and signal. Browser disconnect MUST leave the child running by default; expiry MUST also leave it running unless the corresponding explicit kill flag is set. Final leash exit SHALL preserve the last child code.

#### Scenario: Child exits while browser is disconnected

- **WHEN** the process exits during reconnect grace
- **THEN** local state records the result, reconnect receives the final state and scrollback during post-exit TTL, and no process is silently restarted

### Requirement: Native GUI limitation is explicit

Leash SHALL allow an explicitly named GUI-launching command but MUST expose only its PTY bytes and process state. Help and README SHALL state that terminal applications and TUIs are supported and native GUI windows or the desktop are not streamed.

#### Scenario: GUI application opens a native window

- **WHEN** the child produces no terminal UI but creates a platform window
- **THEN** the browser shows only available process state and terminal output without claiming or attempting screen access
