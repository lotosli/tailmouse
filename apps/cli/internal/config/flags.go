package config

import (
	"errors"
	"flag"
	"io"
	"strings"
)

func parseFlags(args []string, options *Options) (bool, []string, error) {
	flags := flag.NewFlagSet("tailmouse", flag.ContinueOnError)
	flags.SetOutput(io.Discard) // flag's own errors can include secret input values.
	flags.StringVar(&options.ConfigPath, "config", options.ConfigPath, "configuration path")
	flags.StringVar(&options.WebBaseURL, "web-base-url", options.WebBaseURL, "static Web URL")
	flags.Func("derp-host", "comma-separated DERP hosts", func(value string) error {
		options.Relay.Hosts = nil
		if value != "" {
			options.Relay.Hosts = strings.Split(value, ",")
		}
		return nil
	})
	flags.StringVar(&options.Relay.MapURL, "derp-map-url", options.Relay.MapURL, "HTTPS DERP map URL")
	flags.DurationVar(&options.TTL, "ttl", options.TTL, "session lifetime")
	flags.BoolVar(&options.Once, "once", options.Once, "close after mode completion")
	flags.BoolVar(&options.NoQR, "no-qr", options.NoQR, "hide QR")
	flags.BoolVar(&options.JSON, "json", options.JSON, "JSON stderr events")
	flags.BoolVar(&options.Quiet, "quiet", options.Quiet, "essential diagnostics only")
	flags.BoolVar(&options.Verbose, "verbose", options.Verbose, "verbose diagnostics")
	flags.BoolVar(&options.Verbose, "squeak", options.Verbose, "alias for verbose")
	defer func() {
		flags.Visit(func(current *flag.Flag) {
			switch current.Name {
			case "json", "quiet", "verbose", "squeak":
				options.Sources["logging"] = Flag
			}
		})
	}()
	parse := func(values []string) (bool, error) {
		err := flags.Parse(values)
		if errors.Is(err, flag.ErrHelp) {
			return true, nil
		}
		if err != nil {
			return false, &Error{"command flags", Flag}
		}
		return false, nil
	}
	help, err := parse(args)
	if err != nil || help {
		return help, nil, err
	}
	remaining := flags.Args()
	if len(remaining) == 0 {
		return false, nil, &Error{"command", Flag}
	}
	options.Command = remaining[0]
	remaining = remaining[1:]
	switch options.Command {
	case "escape":
		flags.StringVar(&options.Escape.Control, "control", options.Escape.Control, "touch or tilt")
		flags.Int64Var(&options.Escape.Seed, "seed", options.Escape.Seed, "deterministic seed")
		flags.StringVar(&options.Escape.Map, "map", options.Escape.Map, "map name or random")
		flags.DurationVar(&options.Escape.Round, "round", options.Escape.Round, "round duration (30s to 45s)")
		flags.BoolVar(&options.Escape.PhoneRender, "phone-render", options.Escape.PhoneRender, "render phone map")
		flags.BoolVar(&options.Escape.TerminalRender, "terminal-render", options.Escape.TerminalRender, "render terminal map")
		flags.BoolVar(&options.Escape.ShowNet, "show-net", options.Escape.ShowNet, "show network HUD")
	case "leash":
		flags.StringVar(&options.Leash.Title, "title", options.Leash.Title, "session title")
		flags.BoolVar(&options.Leash.Readonly, "readonly", options.Leash.Readonly, "view-only browser")
		flags.BoolVar(&options.Leash.NoPassword, "no-password", options.Leash.NoPassword, "disable the separate access code for this launch")
		flags.BoolVar(&options.Leash.NoRestart, "no-restart", options.Leash.NoRestart, "disable browser restart")
		flags.BoolVar(&options.Leash.NoTerminate, "no-terminate", options.Leash.NoTerminate, "disable browser terminate")
		flags.StringVar(&options.Leash.Cwd, "cwd", options.Leash.Cwd, "child working directory")
		flags.Func("env", "KEY=VALUE override (repeatable)", func(value string) error {
			options.Leash.Env = append(options.Leash.Env, value)
			return nil
		})
		flags.Func("post-exit-ttl", "post-exit retention: host, 0, or a positive duration", func(value string) error {
			duration, host, err := parsePostExitTTL(value)
			if err != nil {
				return err
			}
			options.Leash.PostExitTTL = duration
			options.Leash.PostExitHost = host
			return nil
		})
		flags.DurationVar(&options.Leash.ReconnectGrace, "reconnect-grace", options.Leash.ReconnectGrace, "reconnect grace")
		flags.IntVar(&options.Leash.ScrollbackBytes, "scrollback-bytes", options.Leash.ScrollbackBytes, "scrollback size")
		flags.StringVar(&options.Leash.StartOn, "start-on", options.Leash.StartOn, "connect-or-enter, now, or connect")
		flags.BoolVar(&options.Leash.KillOnExpire, "kill-on-expire", options.Leash.KillOnExpire, "terminate on expiry")
		flags.BoolVar(&options.Leash.KillOnDisconnect, "kill-on-disconnect", options.Leash.KillOnDisconnect, "terminate on disconnect")
		flags.BoolVar(&options.Leash.LocalInput, "local-input", options.Leash.LocalInput, "allow local input")
	case "version":
	case "config":
		if len(remaining) == 0 || remaining[0] != "path" {
			if len(remaining) == 1 && (remaining[0] == "--help" || remaining[0] == "-h") {
				return true, nil, nil
			}
			return false, nil, &Error{"config path command", Flag}
		}
		options.Command = "config path"
		remaining = remaining[1:]
	default:
		return false, nil, &Error{"command", Flag}
	}
	if options.Command == "leash" {
		separator := -1
		for index := 0; index < len(remaining); index++ {
			value := remaining[index]
			if value == "--" {
				separator = index
				break
			}
			if len(value) < 2 || value[0] != '-' {
				break
			}
			name, _, inline := strings.Cut(strings.TrimPrefix(strings.TrimPrefix(value, "-"), "-"), "=")
			current := flags.Lookup(name)
			if current == nil {
				break // Leave unknown flags and help to the standard parser.
			}
			boolean, isBoolean := current.Value.(interface{ IsBoolFlag() bool })
			if !inline && (!isBoolean || !boolean.IsBoolFlag()) {
				index++ // A separate flag value may itself be "--".
			}
		}
		if separator < 0 {
			help, err := parse(remaining)
			if help || err != nil {
				return help, nil, err
			}
			return false, nil, &Error{"leash command after --", Flag}
		}
		options.Leash.Argv = append([]string(nil), remaining[separator+1:]...)
		remaining = remaining[:separator]
	}
	help, err = parse(remaining)
	if err != nil || help {
		return help, nil, err
	}
	if flags.NArg() != 0 {
		return false, nil, &Error{"unexpected positional arguments", Flag}
	}
	var supplied []string
	flags.Visit(func(current *flag.Flag) { supplied = append(supplied, current.Name) })
	for _, name := range supplied {
		if name == "seed" {
			options.Escape.SeedSet = true
		}
		if name == "config" && options.ConfigPath == "" {
			return false, nil, &Error{"config", Flag}
		}
	}
	return false, supplied, nil
}
