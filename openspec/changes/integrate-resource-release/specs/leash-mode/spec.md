# Windows terminal release acceptance

## MODIFIED Requirements

### Requirement: Cross-platform terminal process boundary

macOS and Linux SHALL use a Unix PTY with an independent process group, raw local terminal, SIGWINCH handling, and whole-group signals. Windows 11 SHALL use ConPTY and a Job Object for the full child tree, preferring Ctrl+C/Ctrl+Break for interrupt. Both paths MUST use UTF-8, `TERM=xterm-256color`, initial 80 by 24 size, merged PTY output, and no application-specific screen parsing. Windows child standard streams MUST belong to its ConPTY even when the parent's streams are redirected. Starting a batch script without an explicitly named interpreter MUST fail before process allocation, preserving the literal-command boundary.

#### Scenario: Full-screen TUI starts

- **WHEN** a supported alternate-screen terminal application runs
- **THEN** local and browser terminals render its ANSI, cursor, resize, and Unicode behavior without OCR, screenshots, or program-specific adapters

#### Scenario: Windows parent output is redirected

- **WHEN** a Windows host starts its captured command while its own standard streams are files or pipes
- **THEN** all three child standard streams attach to the owned ConPTY
- **AND** terminal bytes, Unicode, input, resize, interrupt and whole-job cleanup retain the same behavior

#### Scenario: Windows executable lookup finds a batch script

- **WHEN** an explicit path or captured PATH/PATHEXT resolves a `.bat` or `.cmd` script
- **THEN** preflight and startup fail with exit code 126 without running a command interpreter or creating the child
- **AND** a user who intends shell evaluation must explicitly name the interpreter in the captured command
