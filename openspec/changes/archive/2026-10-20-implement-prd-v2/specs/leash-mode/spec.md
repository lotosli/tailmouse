## MODIFIED Requirements

### Requirement: Leash command snapshot and start policy

`tailmouse leash -- <command> [args...]` SHALL snapshot exact argv, cwd, and inherited environment with explicit overrides, title, readonly/control flags, optional total TTL, post-exit retention, scrollback default 1 MiB, local-input policy, start policy `connect-or-enter|now|connect`, and protected or explicit link-only access mode. It MUST start no other command. The default `connect-or-enter` policy SHALL start exactly once after either local Enter or an identifier-2 browser completes authentication when required and active-slot admission; preliminary HELLO or a failed proof MUST NOT trigger startup.

#### Scenario: Default leash waits for access

- **WHEN** start policy is `connect-or-enter`
- **THEN** TailMouse presents the separate invitation and access code before allocating a PTY and starts exactly once after local Enter or successful browser admission

#### Scenario: Link-only Leash waits for access

- **WHEN** start policy is `connect-or-enter` and `--no-password` selected link-only access
- **THEN** a valid identifier-2 HELLO may acquire the active slot and trigger startup only after ordinary invitation, session, mode, protocol, and capability validation

#### Scenario: Browser displays the original command title

- **WHEN** an admitted browser receives a waiting, running, restarted, or exited process state
- **THEN** its display-only title is the command basename or explicit `--title`, rendered as plain text from the immutable snapshot without exposing argv, cwd, or environment

### Requirement: Scrollback reconnection sequence

The raw-byte scrollback ring SHALL be configurable from 64 KiB through 16 MiB and SHALL continue collecting while no browser is connected without retaining more than its configured capacity. A newly authenticated and admitted browser MUST receive `TERM_RESET`, one consistent scrollback snapshot, any dropped-byte indication, then live output without gaps or reordering at the snapshot boundary.

#### Scenario: Earlier output was discarded

- **WHEN** a later connection's snapshot follows ring overwrite
- **THEN** the browser displays the exact accumulated dropped-byte count before or with the retained output

#### Scenario: An unauthenticated peer requests history

- **WHEN** any peer sends or implies a history request before successful admission
- **THEN** the Host reveals no reset, snapshot, byte count, or drop count and closes or rejects the stream according to the authentication state

### Requirement: Child lifecycle and exit result

The Host SHALL expose waiting, starting, running, interrupting, terminating, exited, restarting, failed, and closing states with generation, safe PID, start time, exit code, and signal only to admitted browsers. Browser disconnect MUST leave the child running by default. An explicit total TTL SHALL leave it running unless the corresponding kill flag is set. After child exit, the Host MUST immediately release PTY/ConPTY, process, input, resize, signal, and pump resources while retaining only the bounded scrollback and safe final result until Host shutdown, local revoke, an explicit post-exit duration, or immediate `--post-exit-ttl=0`. Final Leash exit SHALL preserve the last child code unless TailMouse itself fails, in which case the applicable stable Host error classification takes precedence.

#### Scenario: Windows returns a full-width exit status

- **WHEN** a terminated native process returns an unsigned 32-bit status, including a value above 255
- **THEN** native state and browser presentation preserve that exact value without truncation or treating the status as malformed
- **AND** the wire rejects negative, fractional, and greater-than-32-bit exit values

#### Scenario: Required cleanup fails after a nonzero child result

- **WHEN** a child exits nonzero and required process, terminal, transport, or final diagnostic cleanup fails
- **THEN** the Host reports its own stable failure code instead of misrepresenting the failure as only the child's outcome
- **AND** cleanup or diagnostic failures do not replace an earlier protocol, transport, or internal root failure

#### Scenario: Child exits while browser is disconnected

- **WHEN** the process exits during browser absence under default Host retention
- **THEN** local state records the result, process resources are released, and a later authenticated browser receives the final state and bounded scrollback without silently restarting the child

#### Scenario: Child exits with immediate retention disabled

- **WHEN** the process exits while `--post-exit-ttl=0` is effective
- **THEN** the Host publishes the result locally, closes the share, erases credentials and history, and does not accept another browser

## ADDED Requirements

### Requirement: Browser absence does not own the task lifetime

Closing, reloading, suspending, losing, or timing out a browser stream SHALL cancel only that connection's work and release its active slot. Unless `--once`, an explicit deadline, local revocation, or another declared terminal policy applies, the Host MUST keep the command and bounded output processing independent of browser presence and return to listening for a newly authenticated connection.

#### Scenario: A long-running CLI continues unattended

- **WHEN** an admitted browser leaves while the child continues producing output for longer than the former reconnect grace
- **THEN** the child and local terminal continue, memory remains bounded by configured buffers, and the same invitation and code can admit a later browser

#### Scenario: Stale connection work completes late

- **WHEN** input, resize, control, proof, or startup work from a closed stream becomes runnable after another stream has connected or the generation has changed
- **THEN** the Host rejects it against stream identity, lease, and generation without replay or side effect
