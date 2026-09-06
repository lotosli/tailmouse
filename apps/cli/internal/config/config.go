// Package config resolves the documented CLI, environment and TOML inputs before
// network or child-process initialization. Diagnostics never echo input values.
package config

import (
	"errors"
	"fmt"
	"net/netip"
	"net/url"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"tailmouse/apps/cli/internal/escape"
)

const DefaultWebBaseURL = "https://link.tailmouse.com/"

const (
	ExitOK            = 0
	ExitConfig        = 2
	ExitInvitation    = 3
	ExitTransport     = 4
	ExitProtocol      = 5
	ExitPTY           = 6
	ExitChildStart    = 7
	ExitExpired       = 8
	ExitInternal      = 125
	ExitNotExecutable = 126
	ExitNotFound      = 127
)

type Source string

const (
	Default     Source = "default"
	File        Source = "config file"
	Environment Source = "environment"
	Flag        Source = "flag"
)

type Error struct {
	Field  string
	Source Source
}

func (err *Error) Error() string {
	if err.Field == "reconnect-grace" {
		return fmt.Sprintf("invalid reconnect-grace in %s; remove this obsolete setting because Leash now returns to listening after a browser disconnect", err.Source)
	}
	if err.Field == "protected credential terminal" {
		return "protected Leash requires a controlling terminal for the access code; run interactively or explicitly use --no-password"
	}
	return fmt.Sprintf("invalid %s in %s; see tailmouse --help", err.Field, err.Source)
}

type Relay struct {
	Hosts      []string
	MapURL     string
	DERPPort   int
	STUNPort   int
	RegionID   int
	RegionCode string
	RegionName string
}

type Escape struct {
	Control        string
	Seed           int64
	SeedSet        bool
	Map            string
	Round          time.Duration
	PhoneRender    bool
	TerminalRender bool
	ShowNet        bool
}

type Leash struct {
	Argv             []string
	Title            string
	Readonly         bool
	NoPassword       bool
	NoRestart        bool
	NoTerminate      bool
	Cwd              string
	Env              []string
	PostExitTTL      time.Duration
	PostExitHost     bool
	ReconnectGrace   time.Duration
	ScrollbackBytes  int
	StartOn          string
	KillOnExpire     bool
	KillOnDisconnect bool
	LocalInput       bool
}

type Options struct {
	Command    string
	ConfigPath string
	WebBaseURL string
	Relay      Relay
	TTL        time.Duration
	Once       bool
	NoQR       bool
	JSON       bool
	Quiet      bool
	Verbose    bool
	Escape     Escape
	Leash      Leash
	Sources    map[string]Source
}

func defaults(command string) Options {
	ttl := 10 * time.Minute
	if command == "leash" {
		ttl = 0
	}
	return Options{
		Command: command, WebBaseURL: DefaultWebBaseURL, TTL: ttl, Once: command == "escape",
		Relay:   Relay{DERPPort: 443, STUNPort: 3478, RegionID: 900, RegionCode: "mouse", RegionName: "TailMouse Custom DERP"},
		Escape:  Escape{Control: "touch", Map: "random", Round: escape.DefaultRound, PhoneRender: true, TerminalRender: true, ShowNet: true},
		Leash:   Leash{PostExitHost: true, ReconnectGrace: 30 * time.Second, ScrollbackBytes: 1 << 20, StartOn: "connect-or-enter", LocalInput: true},
		Sources: make(map[string]Source),
	}
}

// Resolve parses flags twice so the final parse overlays concrete fields on
// file/environment values. It does not use reflection or a config framework.
// configDir is the value returned by os.UserConfigDir in the composition root.
func Resolve(args, environ []string, configDir string) (Options, bool, error) {
	probe := defaults("")
	help, supplied, err := parseFlags(args, &probe)
	lookup := envLookup(environ)
	logging := defaults(probe.Command)
	logErr := applyLoggingEnvironment(&logging, lookup)
	if probe.SourceOf("logging") != Flag {
		probe.JSON, probe.Quiet, probe.Verbose = logging.JSON, logging.Quiet, logging.Verbose
		probe.Sources["logging"] = logging.SourceOf("logging")
	}
	if err != nil || help {
		return probe, help, err
	}
	options := defaults(probe.Command)
	if probe.Command == "version" {
		return options, false, nil
	}
	options.JSON, options.Quiet, options.Verbose = probe.JSON, probe.Quiet, probe.Verbose
	options.Sources["logging"] = probe.SourceOf("logging")
	path, pathSource, err := selectPath(probe.ConfigPath, lookup, configDir)
	if err != nil {
		return options, false, err
	}
	options.ConfigPath = path
	options.Sources["config"] = pathSource
	if probe.Command == "config path" {
		return options, false, nil
	}
	if logErr != nil {
		return options, false, logErr
	}
	if err := applyFile(&options, path, pathSource != Default); err != nil {
		return options, false, err
	}
	if err := applyEnvironment(&options, lookup); err != nil {
		return options, false, err
	}
	// Logging selectors represent one environment setting, not sticky switches.
	if slices.ContainsFunc(supplied, func(name string) bool {
		return name == "json" || name == "quiet" || name == "verbose" || name == "squeak"
	}) {
		options.JSON, options.Quiet, options.Verbose = false, false, false
	}
	help, supplied, err = parseFlags(args, &options)
	if err != nil {
		return options, help, err
	}
	for _, name := range supplied {
		if name == "squeak" {
			name = "verbose"
		}
		options.Sources[name] = Flag
	}
	if err := validate(options); err != nil {
		return options, false, err
	}
	if err := validateCommand(options); err != nil {
		return options, false, err
	}
	return options, false, nil
}

func (options Options) SourceOf(field string) Source {
	if source, exists := options.Sources[field]; exists {
		return source
	}
	if field == "json" || field == "quiet" || field == "verbose" {
		return options.SourceOf("logging")
	}
	return Default
}

func selectPath(flagPath string, lookup func(string) (string, bool), configDir string) (string, Source, error) {
	if flagPath != "" {
		if strings.ContainsRune(flagPath, 0) {
			return "", Flag, &Error{"config", Flag}
		}
		return flagPath, Flag, nil
	}
	if path, exists := lookup("TAILMOUSE_CONFIG"); exists {
		if path == "" || strings.ContainsRune(path, 0) {
			return "", Environment, &Error{"config", Environment}
		}
		return path, Environment, nil
	}
	if configDir == "" {
		return "", Default, &Error{"user configuration directory", Default}
	}
	return filepath.Join(configDir, "tailmouse", "config.toml"), Default, nil
}

func envLookup(environ []string) func(string) (string, bool) {
	values := make(map[string]string)
	for _, pair := range environ {
		key, value, valid := strings.Cut(pair, "=")
		if valid {
			values[key] = value
		}
	}
	return func(key string) (string, bool) { value, ok := values[key]; return value, ok }
}

func validate(options Options) error {
	bad := func(field string) error { return &Error{field, options.SourceOf(field)} }
	if !validURL(options.WebBaseURL, true) {
		return bad("web-base-url")
	}
	if options.TTL < 0 {
		return bad("ttl")
	}
	if options.Quiet && (options.Verbose || options.JSON) {
		return bad("logging combination")
	}
	if len(options.Relay.Hosts) != 0 && options.Relay.MapURL != "" {
		return bad("derp-host / derp-map-url combination")
	}
	for _, host := range options.Relay.Hosts {
		if !validHostname(host) {
			return bad("derp-host")
		}
	}
	if options.Relay.MapURL != "" && !validURL(options.Relay.MapURL, false) {
		return bad("derp-map-url")
	}
	if options.Relay.DERPPort < 1 || options.Relay.DERPPort > 65535 {
		return bad("derp.derp_port")
	}
	if options.Relay.STUNPort < 1 || options.Relay.STUNPort > 65535 {
		return bad("derp.stun_port")
	}
	if options.Relay.RegionID < 900 || options.Relay.RegionID > 999 {
		return bad("derp.region_id")
	}
	if !safeText(options.Relay.RegionCode, 32) || !safeText(options.Relay.RegionName, 128) {
		return bad("derp region labels")
	}
	if options.Command == "escape" {
		if options.Escape.Control != "touch" && options.Escape.Control != "tilt" {
			return bad("control")
		}
		maps := escape.MapNames()
		if options.Escape.Map != "random" && !slices.Contains(maps[:], options.Escape.Map) {
			return bad("map")
		}
		if options.Escape.Round < escape.MinRound || options.Escape.Round > escape.MaxRound {
			return bad("round")
		}
	}
	if options.Command == "leash" {
		if options.SourceOf("reconnect-grace") != Default {
			return bad("reconnect-grace")
		}
		if options.Leash.PostExitTTL < 0 || (options.Leash.PostExitHost && options.Leash.PostExitTTL != 0) {
			return bad("post-exit-ttl")
		}
		if options.Leash.ScrollbackBytes < 64<<10 || options.Leash.ScrollbackBytes > 16<<20 {
			return bad("scrollback-bytes")
		}
		if !slices.Contains([]string{"connect-or-enter", "now", "connect"}, options.Leash.StartOn) {
			return bad("start-on")
		}
	}
	if options.Command != "leash" && options.Leash.NoPassword {
		return bad("no-password")
	}
	return nil
}

func parsePostExitTTL(value string) (time.Duration, bool, error) {
	if value == "host" {
		return 0, true, nil
	}
	if value == "0" {
		return 0, false, nil
	}
	duration, err := time.ParseDuration(value)
	if err != nil || duration <= 0 {
		return 0, false, errors.New("invalid post-exit retention")
	}
	return duration, false, nil
}

func validateCommand(options Options) error {
	bad := func(field string) error { return &Error{field, Flag} }
	if options.Command != "leash" {
		return nil
	}
	if len(options.Leash.Argv) == 0 || options.Leash.Argv[0] == "" {
		return bad("leash command after --")
	}
	for _, arg := range options.Leash.Argv {
		if strings.ContainsRune(arg, 0) {
			return bad("leash argv")
		}
	}
	if strings.ContainsRune(options.Leash.Cwd, 0) {
		return bad("cwd")
	}
	if options.Leash.Title != "" && !safeText(options.Leash.Title, 256) {
		return bad("title")
	}
	for _, pair := range options.Leash.Env {
		key, _, ok := strings.Cut(pair, "=")
		if !ok || key == "" || strings.ContainsRune(pair, 0) {
			return bad("env")
		}
	}
	return nil
}

func validURL(value string, web bool) bool {
	parsed, err := url.Parse(value)
	if err != nil || parsed.Hostname() == "" || parsed.User != nil || parsed.Fragment != "" || strings.Contains(value, "#") {
		return false
	}
	if parsed.Scheme != "https" && !(web && parsed.Scheme == "http" && (parsed.Hostname() == "localhost" || parsed.Hostname() == "127.0.0.1" || parsed.Hostname() == "::1")) {
		return false
	}
	if _, err := netip.ParseAddr(parsed.Hostname()); err != nil && !validHostname(parsed.Hostname()) {
		return false
	}
	if parsed.Port() != "" {
		port, err := strconv.Atoi(parsed.Port())
		if err != nil || port < 1 || port > 65535 {
			return false
		}
	}
	return !web || (parsed.RawQuery == "" && !parsed.ForceQuery)
}

func validHostname(host string) bool {
	if len(host) == 0 || len(host) > 253 || strings.TrimSpace(host) != host {
		return false
	}
	host = strings.TrimSuffix(host, ".")
	if _, err := netip.ParseAddr(host); err == nil {
		return false
	}
	for _, label := range strings.Split(host, ".") {
		if len(label) == 0 || len(label) > 63 || label[0] == '-' || label[len(label)-1] == '-' {
			return false
		}
		for _, character := range label {
			if !(character >= 'a' && character <= 'z' || character >= 'A' && character <= 'Z' || character >= '0' && character <= '9' || character == '-') {
				return false
			}
		}
	}
	return true
}

func safeText(value string, maximum int) bool {
	return value != "" && len(value) <= maximum && utf8.ValidString(value) && !strings.ContainsFunc(value, unicode.IsControl)
}

// ExitCode keeps application failures distinct from child exit statuses.
func ExitCode(err error) int {
	if err == nil {
		return ExitOK
	}
	var invalid *Error
	if errors.As(err, &invalid) {
		return ExitConfig
	}
	return ExitInternal
}
