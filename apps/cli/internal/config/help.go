package config

import "io"

// WriteHelp is static so help works even when config, network or user-directory
// discovery is unavailable. Values from untrusted input are never interpolated.
func WriteHelp(output io.Writer, command string) error {
	const common = `tailmouse — tiny browser sessions over Tailcat

Usage:
  tailmouse leash [flags] -- <command> [args...]
  tailmouse version
  tailmouse config path

Global flags (before the command or after leash):
  --config <path>               Version 1 TOML; default: OS user config directory
  --web-base-url <https-url>    Static Web base URL (default: https://link.tailmouse.com/)
  --derp-host <host[,host...]>   Custom DERP hostnames
  --derp-map-url <https-url>    Custom DERP map; mutually exclusive with hosts
  --ttl <duration>              0 (until Host exit)
  --once                       Close after mode completion (default: false)
  --no-qr                      Hide the terminal QR code, retain the Open: line
  --json                       JSON events on stderr
  --quiet                      Essential diagnostics only; conflicts with JSON/verbose
  --verbose                    Additional safe diagnostics; compatible with JSON
  --squeak                     Alias for --verbose
  --help, -h                   Show help without initialization

Precedence: flags > environment > config.toml > defaults.
Environment: TAILMOUSE_CONFIG, TAILMOUSE_WEB_BASE_URL, TAILMOUSE_DERP_HOST,
  TAILMOUSE_DERP_MAP_URL, TAILMOUSE_TTL, TAILMOUSE_NO_QR, TAILMOUSE_LOG.
TAILMOUSE_LOG: info, quiet, verbose, debug (verbose alias), or json.
Set a boolean explicitly with --flag=false. Plain HTTP Web is loopback-only.

Treat invitations and access codes as separate passwords. With --no-password,
the complete invitation alone grants the configured Leash permissions.
Browser transport is DERP-only. TailMouse is an unofficial Tailcat application.
TMOUSE Leash uses identifier 2. Older Leash peers
fail closed before terminal disclosure or child startup; there is no downgrade.
`
	const leash = `
Leash flags:
  --title <text>                Default: command basename
  --readonly                    View only; disallow browser input and controls
  --no-password                 This launch only; the invitation alone grants access
  --no-restart                  Disallow browser restart
  --no-terminate                Disallow browser terminate
  --cwd <path>                  Default: current directory
  --env KEY=VALUE               Repeatable override of inherited environment
  --post-exit-ttl <retention>    host (default), 0, or a positive duration
  --reconnect-grace <duration>   Obsolete for Leash; remove this legacy setting
  --scrollback-bytes <integer>   65536 to 16777216 (default: 1048576)
  --start-on <policy>            connect-or-enter (default), now, or connect
  --kill-on-expire=false         Terminate the process tree on expiry
  --kill-on-disconnect=false     Terminate the process tree on disconnect
  --local-input=true            Forward local input to the child

Protected Leash is the default and requires a controlling terminal. Its access
code is written only to that terminal, separately from stdout, stderr, JSON,
the invitation URL and the QR code. Noninteractive automation must either
provide a controlling terminal or explicitly choose --no-password; that choice
always prints a warning, including with --quiet.

Arguments after -- are literal: no shell expansion. For pipes or redirects,
explicitly launch a shell: tailmouse leash -- sh -lc 'make test | tee test.log'
Examples: tailmouse leash -- vim; tailmouse leash -- codex (an installed AI CLI).
Browser input has the selected process's authority; use --readonly to view only.
Leash streams terminal applications and TUIs, not native GUI windows or desktops.
`
	text := common

	if command == "leash" || command == "" {
		text += leash
	}
	_, err := io.WriteString(output, text)
	return err
}
