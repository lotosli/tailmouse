## MODIFIED Requirements

### Requirement: Documented global configuration

TailMouse SHALL support `--config`, `--web-base-url`, `--derp-host`, `--derp-map-url`, `--ttl`, `--once`, `--no-qr`, `--json`, `--quiet`, `--verbose`, and `--squeak`, plus the corresponding documented environment variables. `--squeak` MUST behave as an alias for verbose diagnostics without replacing `--verbose`. Leash SHALL additionally support the per-launch command-line flag `--no-password`, which MUST NOT have an environment-variable or configuration-file equivalent.

#### Scenario: Conflicting output flags are supplied

- **WHEN** quiet, verbose, or JSON options form an ambiguous combination
- **THEN** validation rejects the combination before initialization with an actionable exit-code-2 error

#### Scenario: No-password appears outside its command-line boundary

- **WHEN** an environment variable, configuration field, Escape invocation, or browser input attempts to select no-password mode
- **THEN** validation rejects or ignores the unsupported source according to its existing unknown-setting rule and never disables protected Leash access

### Requirement: Mode-specific arguments are bounded

Escape and Leash flags SHALL use their specified defaults and ranges, reject invalid durations, sizes, modes, URLs, maps, and controls before side effects, and MUST preserve an immutable Leash argv/cwd/environment snapshot for restart. Phase-two Leash SHALL default to Host-lived total TTL, `host` post-exit retention, 1 MiB scrollback, password-protected access, and `https://link.tailmouse.com/`; it SHALL accept explicit nonnegative total TTLs and post-exit values of `host`, `0`, or a positive finite duration accepted by the documented duration syntax without overflow. Escape defaults remain unchanged.

#### Scenario: Scrollback exceeds the supported range

- **WHEN** `--scrollback-bytes` is below 64 KiB or above 16 MiB
- **THEN** TailMouse exits with code 2 before starting Tailcat or a child process

#### Scenario: Immediate post-exit completion is selected

- **WHEN** the user explicitly sets `--post-exit-ttl=0`
- **THEN** the Leash share ends immediately after publishing the final child result locally and does not retain a remotely reconnectable result

#### Scenario: An explicit Web origin is configured

- **WHEN** `--web-base-url`, its documented environment variable, or the version-1 TOML field supplies a valid self-hosted HTTPS origin
- **THEN** that origin follows normal precedence over `https://link.tailmouse.com/` without changing transport, authentication, or protocol policy

## ADDED Requirements

### Requirement: Reconnect-grace migration is explicit

Phase-two Leash SHALL NOT use browser absence as a share deadline. An explicitly supplied Leash `--reconnect-grace`, corresponding environment variable, or nonempty configuration field MUST fail validation before network or process side effects with guidance to remove the setting; Escape's reconnect policy remains unchanged.

#### Scenario: A legacy Leash configuration is loaded

- **WHEN** a user has explicitly configured reconnect grace for Leash
- **THEN** TailMouse exits with code 2, names the obsolete setting and explains that Leash now returns to listening after disconnection rather than silently changing the requested duration

### Requirement: Protected launch requires local credential delivery

A protected Leash launch MUST have a controlling terminal capable of privately presenting the generated access code. The code SHALL be displayed separately from the invitation and MUST NOT enter stdout, stderr capture, JSON fields, command arguments, environment, or configuration. If no controlling terminal is available, TailMouse SHALL fail before network and process side effects with guidance to use an interactive terminal or explicitly choose `--no-password`.

#### Scenario: Automation starts protected Leash without a terminal

- **WHEN** stdin, stdout, and stderr are redirected and no controlling terminal can present the code
- **THEN** TailMouse exits with code 2 before generating an invitation, opening Tailcat, or starting the command

#### Scenario: JSON mode has a controlling terminal

- **WHEN** protected Leash runs with `--json` from a controlling terminal
- **THEN** the code appears only in the local terminal presentation while the JSON stream emits a redacted event indicating that a code was presented
