package config

import (
	"errors"
	"io"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/BurntSushi/toml"
)

// The documented schema has fewer than thirty scalar settings. This cap rejects
// accidental logs or unbounded input before the TOML parser allocates a tree.
const maxConfigBytes = 64 << 10

type fileConfig struct {
	Version int `toml:"version"`
	Web     struct {
		BaseURL string `toml:"base_url"`
	} `toml:"web"`
	DERP struct {
		Mode       string   `toml:"mode"`
		Hosts      []string `toml:"hosts"`
		MapURL     string   `toml:"map_url"`
		DERPPort   int      `toml:"derp_port"`
		STUNPort   int      `toml:"stun_port"`
		RegionID   int      `toml:"region_id"`
		RegionCode string   `toml:"region_code"`
		RegionName string   `toml:"region_name"`
	} `toml:"derp"`
	Session struct {
		LeashTTL       string `toml:"leash_ttl"`
		ReconnectGrace string `toml:"reconnect_grace"`
	} `toml:"session"`
	Leash struct {
		ScrollbackBytes int    `toml:"scrollback_bytes"`
		PostExitTTL     string `toml:"post_exit_ttl"`
		StartOn         string `toml:"start_on"`
		LocalInput      bool   `toml:"local_input"`
	} `toml:"leash"`
}

func applyFile(options *Options, path string, required bool) error {
	// Inspect before opening so an accidental FIFO cannot block initialization.
	info, err := os.Stat(path)
	if errors.Is(err, os.ErrNotExist) && !required {
		return nil
	}
	if err != nil {
		return &Error{"config path (unreadable)", File}
	}
	if !info.Mode().IsRegular() || info.Size() > maxConfigBytes {
		return &Error{"config file size or type", File}
	}
	file, err := os.Open(path)
	if err != nil {
		return &Error{"config path (unreadable)", File}
	}
	defer file.Close()
	info, err = file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() > maxConfigBytes {
		return &Error{"config file size or type", File}
	}
	contents, err := io.ReadAll(io.LimitReader(file, maxConfigBytes+1))
	if err != nil || len(contents) > maxConfigBytes {
		return &Error{"config file size or read", File}
	}

	var input fileConfig
	input.Session.LeashTTL = "0"
	input.Web.BaseURL = options.WebBaseURL
	input.DERP.Mode = "official"
	input.DERP.DERPPort, input.DERP.STUNPort = options.Relay.DERPPort, options.Relay.STUNPort
	input.DERP.RegionID, input.DERP.RegionCode, input.DERP.RegionName = options.Relay.RegionID, options.Relay.RegionCode, options.Relay.RegionName
	input.Leash.ScrollbackBytes, input.Leash.PostExitTTL = 1<<20, "host"
	input.Leash.StartOn, input.Leash.LocalInput = "connect-or-enter", true
	metadata, err := toml.Decode(string(contents), &input)
	if err != nil {
		return &Error{"TOML syntax or field type", File}
	}
	if len(metadata.Undecoded()) != 0 {
		return &Error{"unknown TOML field", File}
	}
	if input.Version != 1 {
		return &Error{"version (expected 1)", File}
	}
	if len(input.DERP.Hosts) > 0 && input.DERP.MapURL != "" {
		return &Error{"derp.hosts / derp.map_url combination", File}
	}
	if !metadata.IsDefined("derp", "mode") {
		if len(input.DERP.Hosts) > 0 {
			input.DERP.Mode = "custom-host"
		}
		if input.DERP.MapURL != "" {
			input.DERP.Mode = "custom-map"
		}
	}
	switch input.DERP.Mode {
	case "official":
		if len(input.DERP.Hosts) != 0 || input.DERP.MapURL != "" {
			return &Error{"derp.mode", File}
		}
	case "custom-host":
		if len(input.DERP.Hosts) == 0 || input.DERP.MapURL != "" {
			return &Error{"derp.hosts", File}
		}
	case "custom-map":
		if input.DERP.MapURL == "" || len(input.DERP.Hosts) != 0 {
			return &Error{"derp.map_url", File}
		}
	default:
		return &Error{"derp.mode", File}
	}
	options.WebBaseURL = input.Web.BaseURL
	options.Relay = Relay{Hosts: input.DERP.Hosts, MapURL: input.DERP.MapURL,
		DERPPort: input.DERP.DERPPort, STUNPort: input.DERP.STUNPort, RegionID: input.DERP.RegionID,
		RegionCode: input.DERP.RegionCode, RegionName: input.DERP.RegionName}
	durations := []struct {
		field, value string
		target       *time.Duration
	}{
		{"session.leash_ttl", input.Session.LeashTTL, nil},
	}
	for _, duration := range durations {
		value, err := time.ParseDuration(duration.value)
		if err != nil || value < 0 {
			return &Error{duration.field, File}
		}
		if duration.target != nil {
			*duration.target = value
		}
		if duration.field == "session."+options.Command+"_ttl" {
			options.TTL = value
		}
	}
	if input.Session.ReconnectGrace != "" {
		value, err := time.ParseDuration(input.Session.ReconnectGrace)
		if err != nil || value < 0 {
			return &Error{"session.reconnect_grace", File}
		}
		options.Leash.ReconnectGrace = value
	}
	postExitTTL, postExitHost, err := parsePostExitTTL(input.Leash.PostExitTTL)
	if err != nil {
		return &Error{"leash.post_exit_ttl", File}
	}
	options.Leash.PostExitTTL = postExitTTL
	options.Leash.PostExitHost = postExitHost
	options.Leash.ScrollbackBytes = input.Leash.ScrollbackBytes
	options.Leash.StartOn, options.Leash.LocalInput = input.Leash.StartOn, input.Leash.LocalInput
	for _, key := range metadata.Keys() {
		field := key.String()
		if field == "session.reconnect_grace" && input.Session.ReconnectGrace == "" {
			continue
		}
		aliases := map[string]string{"web.base_url": "web-base-url", "derp.hosts": "derp-host", "derp.map_url": "derp-map-url",
			"session." + options.Command + "_ttl": "ttl", "session.reconnect_grace": "reconnect-grace",
			"leash.post_exit_ttl": "post-exit-ttl", "leash.scrollback_bytes": "scrollback-bytes", "leash.start_on": "start-on", "leash.local_input": "local-input"}
		if alias, exists := aliases[field]; exists {
			field = alias
		}
		options.Sources[field] = File
	}
	if err := validate(*options); err != nil {
		return err
	}
	return nil
}

func applyEnvironment(options *Options, lookup func(string) (string, bool)) error {
	if hosts, present := lookup("TAILMOUSE_DERP_HOST"); present && hosts != "" {
		if mapURL, present := lookup("TAILMOUSE_DERP_MAP_URL"); present && mapURL != "" {
			return &Error{"TAILMOUSE_DERP_HOST / TAILMOUSE_DERP_MAP_URL combination", Environment}
		}
	}
	for _, setting := range []struct{ name, field string }{
		{"TAILMOUSE_WEB_BASE_URL", "web-base-url"}, {"TAILMOUSE_DERP_HOST", "derp-host"},
		{"TAILMOUSE_DERP_MAP_URL", "derp-map-url"}, {"TAILMOUSE_TTL", "ttl"},
		{"TAILMOUSE_NO_QR", "no-qr"}, {"TAILMOUSE_RECONNECT_GRACE", "reconnect-grace"},
	} {
		value, exists := lookup(setting.name)
		if !exists {
			continue
		}
		options.Sources[setting.field] = Environment
		switch setting.name {
		case "TAILMOUSE_WEB_BASE_URL":
			if !validURL(value, true) {
				return &Error{setting.name, Environment}
			}
			options.WebBaseURL = value
		case "TAILMOUSE_DERP_HOST":
			options.Relay.Hosts = nil
			if value != "" {
				options.Relay.Hosts = strings.Split(value, ",")
				for _, host := range options.Relay.Hosts {
					if !validHostname(host) {
						return &Error{setting.name, Environment}
					}
				}
			}
		case "TAILMOUSE_DERP_MAP_URL":
			if value != "" && !validURL(value, false) {
				return &Error{setting.name, Environment}
			}
			options.Relay.MapURL = value
		case "TAILMOUSE_TTL":
			parsed, err := time.ParseDuration(value)
			if err != nil || parsed < 0 {
				return &Error{setting.name, Environment}
			}
			options.TTL = parsed
		case "TAILMOUSE_NO_QR":
			parsed, err := strconv.ParseBool(value)
			if err != nil {
				return &Error{setting.name, Environment}
			}
			options.NoQR = parsed
		case "TAILMOUSE_RECONNECT_GRACE":
			if options.Command == "leash" {
				continue
			}
			parsed, err := time.ParseDuration(value)
			if err != nil || parsed < 0 {
				return &Error{setting.name, Environment}
			}
			options.Leash.ReconnectGrace = parsed
		}
	}
	// Cross-source relay conflicts are checked after flags have had the chance
	// to explicitly clear a lower-precedence field.
	return nil
}

func applyLoggingEnvironment(options *Options, lookup func(string) (string, bool)) error {
	value, exists := lookup("TAILMOUSE_LOG")
	if !exists {
		return nil
	}
	options.Sources["logging"] = Environment
	switch value {
	case "info":
	case "quiet":
		options.Quiet = true
	case "verbose", "debug":
		options.Verbose = true
	case "json":
		options.JSON = true
	default:
		return &Error{"TAILMOUSE_LOG", Environment}
	}
	return nil
}
