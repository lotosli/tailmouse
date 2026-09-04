package config

import "io"

// WriteHelp is static so help works even when config, network or user-directory
// discovery is unavailable. Values from untrusted input are never interpolated.
func WriteHelp(output io.Writer, command string) error {
	const common = `tailmouse — tiny browser sessions over Tailcat

Usage:
  tailmouse escape [flags]
  tailmouse leash [flags] -- <command> [args...]
  tailmouse version
  tailmouse config path

Global flags (before the command or after escape/leash):
  --config <path>               Version 1 TOML; default: OS user config directory
  --web-base-url <https-url>    Static Web base URL (default: https://tailmouse.dev/)
  --derp-host <host[,host...]>   Custom DERP hostnames
  --derp-map-url <https-url>    Custom DERP map; mutually exclusive with hosts
  --ttl <duration>              Escape: 10m; leash: 4h; 0: until host exit
  --once                       Close after mode completion (escape: true)
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

Treat invitation links like passwords. Anyone with the link can access the
session until expiry. A zero TTL increases public-sharing risk.
Browser transport is DERP-only. TailMouse is an unofficial Tailcat application.
`
	const escape = `
Escape flags:
  --control touch|tilt          Default: touch
  --seed <int64>                Deterministic round seed
  --map <name|random>           Default: random
    Maps: courtyard, pantry, corridors, switchbacks, crossroads
  --round <duration>            30s to 45s (default: 45s)
  --phone-render=true           Render the phone map
  --terminal-render=true        Render the terminal spectator map
  --show-net=true               Show network HUD
`
	const leash = `
Leash flags:
  --title <text>                Default: command basename
  --readonly                    View only; disallow browser input and controls
  --no-restart                  Disallow browser restart
  --no-terminate                Disallow browser terminate
  --cwd <path>                  Default: current directory
  --env KEY=VALUE               Repeatable override of inherited environment
  --post-exit-ttl <duration>     Default: 10m; 0 ends retention immediately
  --reconnect-grace <duration>   Default: 30s
  --scrollback-bytes <integer>   65536 to 16777216 (default: 1048576)
  --start-on <policy>            connect-or-enter (default), now, or connect
  --kill-on-expire=false         Terminate the process tree on expiry
  --kill-on-disconnect=false     Terminate the process tree on disconnect
  --local-input=true            Forward local input to the child

Arguments after -- are literal: no shell expansion. For pipes or redirects,
explicitly launch a shell: tailmouse leash -- sh -lc 'make test | tee test.log'
Browser input has the selected process's authority; use --readonly to view only.
Leash streams terminal applications and TUIs, not native GUI windows or desktops.
`
	text := common
	if command == "escape" || command == "" {
		text += escape
	}
	if command == "leash" || command == "" {
		text += leash
	}
	_, err := io.WriteString(output, text)
	return err
}
