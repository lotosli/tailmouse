# CLI configuration specification

## Purpose

Define the complete native command, configuration, validation, and exit behavior that makes TailMouse predictable across supported host platforms.

## Requirements

### Requirement: Single executable command surface

TailMouse SHALL ship one `tailmouse` executable exposing `escape`, `leash -- <command> [args...]`, `version`, and `config path`, and MUST reject unknown commands or missing leash commands with usage and exit code 2.

#### Scenario: User requests command help

- **WHEN** the user invokes help at the root or supported mode
- **THEN** output documents the PRD command, global flags, mode flags, security warning, and terminal-only leash boundary without listing P1 commands as available

#### Scenario: Leash receives shell metacharacters

- **WHEN** arguments after `--` contain pipes, redirects, variables, or globs without an explicit shell executable
- **THEN** TailMouse passes them as literal argv values and performs no shell expansion

### Requirement: Deterministic configuration precedence

Effective configuration MUST resolve each documented setting in the order command flag, environment variable, TOML file, then built-in default. The config file SHALL use schema version 1 and the platform path returned by the operating-system user configuration directory unless explicitly overridden.

#### Scenario: All four sources set the Web base URL

- **WHEN** a flag, environment variable, config file, and default each provide a different Web base URL
- **THEN** the flag value is selected and diagnostics identify its source without revealing invitation material

#### Scenario: Configuration version is unsupported

- **WHEN** a TOML file declares an unsupported version or an invalid value
- **THEN** TailMouse reports the field and file safely, performs no network or process action, and exits with code 2

### Requirement: Documented global configuration

TailMouse SHALL support `--config`, `--web-base-url`, `--derp-host`, `--derp-map-url`, `--ttl`, `--once`, `--no-qr`, `--json`, `--quiet`, `--verbose`, and `--squeak`, plus the corresponding PRD environment variables. `--squeak` MUST behave as an alias for verbose diagnostics without replacing `--verbose`.

#### Scenario: Conflicting output flags are supplied

- **WHEN** quiet, verbose, or JSON options form an ambiguous combination
- **THEN** validation rejects the combination before initialization with an actionable exit-code-2 error

### Requirement: Stable process exit classification

TailMouse MUST preserve the PRD exit classifications: 0 for normal completion, 2 configuration, 3 invitation construction, 4 Tailcat/DERP initialization, 5 protocol, 6 PTY/ConPTY initialization, 7 child start, 8 expiry/revocation, 125 internal failure, 126 non-executable command, and 127 missing command. A leash completion SHALL otherwise return the last child exit code.

#### Scenario: TailMouse fails after a child exits

- **WHEN** an internal session failure rather than the child result causes leash to terminate
- **THEN** TailMouse returns its classified failure code and does not disguise it as the child's exit code

### Requirement: Mode-specific arguments are bounded

Escape and leash flags SHALL use the PRD defaults and ranges, reject invalid durations, sizes, modes, URLs, maps, and controls before side effects, and MUST preserve an immutable leash argv/cwd/environment snapshot for restart.

#### Scenario: Scrollback exceeds the supported range

- **WHEN** `--scrollback-bytes` is below 64 KiB or above 16 MiB
- **THEN** TailMouse exits with code 2 before starting Tailcat or a child process
