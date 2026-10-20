package config

import (
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestModeDefaults(t *testing.T) {
	for _, command := range []string{"leash"} {
		t.Run(command, func(t *testing.T) {
			args := []string{command}
			if command == "leash" {
				args = append(args, "--", "echo")
			}
			options, help, err := Resolve(args, nil, t.TempDir())
			if err != nil || help {
				t.Fatalf("resolve: %v", err)
			}
			if options.WebBaseURL != DefaultWebBaseURL || options.SourceOf("web-base-url") != Default {
				t.Fatal("incorrect Web default or source")
			}
			if options.Relay.DERPPort != 443 || options.Relay.STUNPort != 3478 || options.Relay.RegionID != 900 || len(options.Relay.Hosts) != 0 {
				t.Fatal("incorrect relay defaults")
			}
			{
				if options.TTL != 0 || options.Once || options.Leash.PostExitTTL != 0 || !options.Leash.PostExitHost || options.Leash.NoPassword || options.Leash.ReconnectGrace != 30*time.Second || options.Leash.ScrollbackBytes != 1<<20 || options.Leash.StartOn != "connect-or-enter" || !options.Leash.LocalInput || options.Leash.KillOnExpire || options.Leash.KillOnDisconnect {
					t.Fatal("incorrect Leash defaults")
				}
			}
		})
	}
}

func TestPerFieldPrecedence(t *testing.T) {
	dir := t.TempDir()
	path := writeConfig(t, dir, "version=1\n[web]\nbase_url='https://file.example/'\n[session]\nleash_ttl='7m'\n")
	for _, test := range []struct {
		name       string
		env, flags []string
		wantURL    string
		source     Source
		ttl        time.Duration
	}{
		{"file", nil, nil, "https://file.example/", File, 7 * time.Minute},
		{"environment", []string{"TAILMOUSE_WEB_BASE_URL=https://env.example/", "TAILMOUSE_TTL=6m"}, nil, "https://env.example/", Environment, 6 * time.Minute},
		{"flag", []string{"TAILMOUSE_WEB_BASE_URL=https://env.example/", "TAILMOUSE_TTL=6m"}, []string{"--web-base-url", "https://flag.example/", "--ttl", "5m"}, "https://flag.example/", Flag, 5 * time.Minute},
		{"independent fields", []string{"TAILMOUSE_TTL=6m"}, []string{"--web-base-url", "https://flag.example/"}, "https://flag.example/", Flag, 6 * time.Minute},
	} {
		t.Run(test.name, func(t *testing.T) {
			args := append([]string{"--config", path, "leash"}, test.flags...)
			options, _, err := Resolve(append(args, "--", "example-command"), test.env, dir)
			if err != nil {
				t.Fatal(err)
			}
			if options.WebBaseURL != test.wantURL || options.SourceOf("web-base-url") != test.source || options.TTL != test.ttl {
				t.Fatal("precedence did not apply per field")
			}
		})
	}
	options, _, err := Resolve([]string{"leash", "--no-qr=false", "--once=false", "--", "example-command"}, []string{"TAILMOUSE_NO_QR=true"}, t.TempDir())
	if err != nil || options.NoQR || options.Once || options.SourceOf("no-qr") != Flag {
		t.Fatalf("explicit false did not override: %v", err)
	}
}

func TestLeashFlagsPreserveLiteralArgv(t *testing.T) {
	args := []string{"--no-qr", "leash", "--title", "A terminal", "--readonly", "--no-restart", "--no-terminate", "--cwd", "/tmp",
		"--env", "A=one", "--env", "A=two=three", "--post-exit-ttl", "0", "--no-password", "--scrollback-bytes", "65536",
		"--start-on", "now", "--kill-on-expire", "--kill-on-disconnect", "--local-input=false", "--", "echo", "$HOME", "*", "|", ">", "--ttl"}
	options, _, err := Resolve(args, nil, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(options.Leash.Argv, []string{"echo", "$HOME", "*", "|", ">", "--ttl"}) {
		t.Fatal("argv was expanded or reparsed")
	}
	if !reflect.DeepEqual(options.Leash.Env, []string{"A=one", "A=two=three"}) {
		t.Fatal("repeated environment overrides changed order")
	}
	args[len(args)-1] = "mutated"
	if options.Leash.Argv[len(options.Leash.Argv)-1] != "--ttl" {
		t.Fatal("argv aliases caller memory")
	}
	if !options.Leash.Readonly || !options.Leash.NoPassword || !options.Leash.NoRestart || !options.Leash.NoTerminate || !options.Leash.KillOnExpire || !options.Leash.KillOnDisconnect || options.Leash.LocalInput || options.Leash.PostExitTTL != 0 || options.Leash.PostExitHost || options.Leash.Title != "A terminal" || options.Leash.Cwd != "/tmp" {
		t.Fatal("Leash flags were lost")
	}
}

func TestPhaseTwoLeashLifetimeAndAccessConfiguration(t *testing.T) {
	maximum := "2562047h47m16.854775807s"
	for _, test := range []struct {
		value    string
		host     bool
		duration time.Duration
	}{
		{"host", true, 0},
		{"0", false, 0},
		{"1ns", false, time.Nanosecond},
		{maximum, false, time.Duration(1<<63 - 1)},
	} {
		options, _, err := Resolve([]string{"leash", "--post-exit-ttl", test.value, "--", "echo"}, nil, t.TempDir())
		if err != nil || options.Leash.PostExitHost != test.host || options.Leash.PostExitTTL != test.duration || options.SourceOf("post-exit-ttl") != Flag {
			t.Fatalf("post-exit retention %q: options=%+v error=%v", test.value, options.Leash, err)
		}
	}
	for _, value := range []string{"", "0s", "0.1ns", "-1ns", "2562047h47m16.854775808s", "forever"} {
		if _, _, err := Resolve([]string{"leash", "--post-exit-ttl", value, "--", "echo"}, nil, t.TempDir()); ExitCode(err) != ExitConfig {
			t.Fatalf("invalid post-exit retention %q was accepted", value)
		}
	}

	dir := t.TempDir()
	path := writeConfig(t, dir, "version=1\n[leash]\npost_exit_ttl='5m'\n")
	options, _, err := Resolve([]string{"leash", "--config", path, "--post-exit-ttl=host", "--no-password", "--", "echo"}, []string{"TAILMOUSE_NO_PASSWORD=false"}, dir)
	if err != nil || !options.Leash.PostExitHost || options.Leash.PostExitTTL != 0 || !options.Leash.NoPassword || options.SourceOf("post-exit-ttl") != Flag || options.SourceOf("no-password") != Flag {
		t.Fatalf("Leash flag precedence or CLI-only access mode failed: %v", err)
	}
	options, _, err = Resolve([]string{"leash", "--config", path, "--", "echo"}, []string{"TAILMOUSE_NO_PASSWORD=true"}, dir)
	if err != nil || options.Leash.PostExitHost || options.Leash.PostExitTTL != 5*time.Minute || options.Leash.NoPassword {
		t.Fatalf("file retention or ignored unknown environment input failed: %v", err)
	}
	unknownNoPassword := writeConfig(t, t.TempDir(), "version=1\n[leash]\nno_password=true\n")
	if _, _, err := Resolve([]string{"leash", "--config", unknownNoPassword, "--", "echo"}, nil, dir); ExitCode(err) != ExitConfig {
		t.Fatal("configuration-file no-password setting was accepted")
	}
	if _, _, err := Resolve([]string{"removed-mode", "--no-password"}, nil, dir); ExitCode(err) != ExitConfig {
		t.Fatal("Unknown mode accepted terminal flags")
	}
}

func TestLeashReconnectGraceMigration(t *testing.T) {
	dir := t.TempDir()
	path := writeConfig(t, dir, "version=1\n[session]\nreconnect_grace='15s'\n")
	for _, test := range []struct {
		name string
		args []string
		env  []string
	}{
		{"flag", []string{"leash", "--reconnect-grace=15s", "--", "echo"}, nil},
		{"environment", []string{"leash", "--", "echo"}, []string{"TAILMOUSE_RECONNECT_GRACE=15s"}},
		{"empty environment", []string{"leash", "--", "echo"}, []string{"TAILMOUSE_RECONNECT_GRACE="}},
		{"file", []string{"leash", "--config", path, "--", "echo"}, nil},
	} {
		t.Run(test.name, func(t *testing.T) {
			_, _, err := Resolve(test.args, test.env, dir)
			if ExitCode(err) != ExitConfig || !strings.Contains(err.Error(), "reconnect-grace") || !strings.Contains(err.Error(), "returns to listening") {
				t.Fatalf("legacy setting did not produce migration guidance: %v", err)
			}
		})
	}

	emptyPath := writeConfig(t, t.TempDir(), "version=1\n[session]\nreconnect_grace=''\n")
	if _, _, err := Resolve([]string{"leash", "--config", emptyPath, "--", "echo"}, nil, dir); err != nil {
		t.Fatalf("empty legacy file field should not configure a deadline: %v", err)
	}
}

func TestLeashSeparatorDoesNotConsumeFlagValues(t *testing.T) {
	for _, test := range []struct {
		name, title, cwd string
		flags            []string
	}{
		{"separate title", "--", "", []string{"--title", "--"}},
		{"single dash spelling", "--", "", []string{"-title", "--"}},
		{"inline title", "--", "", []string{"--title=--"}},
		{"separate directory", "", "--", []string{"--cwd", "--"}},
		{"consecutive flag values", "--", "--title", []string{"--cwd", "--title", "--title", "--"}},
		{"boolean before title", "--", "", []string{"--readonly", "--title", "--"}},
		{"boolean after title", "--", "", []string{"--title", "--", "--readonly=false"}},
	} {
		t.Run(test.name, func(t *testing.T) {
			argv := []string{"echo", "--title", "--", "$HOME", "|"}
			args := append([]string{"leash"}, test.flags...)
			args = append(args, "--")
			args = append(args, argv...)
			options, help, err := Resolve(args, nil, t.TempDir())
			if err != nil || help {
				t.Fatalf("literal flag value rejected: %v", err)
			}
			if options.Leash.Title != test.title || options.Leash.Cwd != test.cwd || !reflect.DeepEqual(options.Leash.Argv, argv) {
				t.Fatal("flag value or literal child argv changed at the separator")
			}
		})
	}
	for _, args := range [][]string{
		{"leash", "--title", "--", "echo"},
		{"leash", "--cwd", "--", "echo"},
		{"leash", "echo", "--", "argument"},
		{"leash", "--title", "--"},
		{"leash", "--title", "--", "--"},
		{"leash", "--ttl", "--", "--", "echo"},
	} {
		if _, _, err := Resolve(args, nil, t.TempDir()); ExitCode(err) != ExitConfig {
			t.Fatal("missing command separator, empty command or invalid flag value was accepted")
		}
	}
}

func TestHelpVersionAndConfigPathDoNotReadConfigOrStartCommands(t *testing.T) {
	for _, args := range [][]string{{"--help"}, {"leash", "--help"}, {"leash", "-h"}} {
		_, help, err := Resolve(args, []string{"TAILMOUSE_CONFIG=/nonexistent/config.toml"}, "")
		if err != nil || !help {
			t.Fatalf("help failed: %v", err)
		}
	}
	options, help, err := Resolve([]string{"version"}, []string{"TAILMOUSE_CONFIG=/nonexistent/config.toml"}, "")
	if err != nil || help || options.Command != "version" {
		t.Fatalf("version failed: %v", err)
	}
	dir := t.TempDir()
	options, _, err = Resolve([]string{"config", "path"}, nil, dir)
	if err != nil || options.ConfigPath != filepath.Join(dir, "tailmouse", "config.toml") {
		t.Fatalf("default config path: %v", err)
	}
	options, _, err = Resolve([]string{"--config", "/explicit/config.toml", "config", "path"}, []string{"TAILMOUSE_CONFIG=/env/config.toml"}, dir)
	if err != nil || options.ConfigPath != "/explicit/config.toml" || options.SourceOf("config") != Flag {
		t.Fatalf("flag config path: %v", err)
	}
	options, _, err = Resolve([]string{"config", "path"}, []string{"TAILMOUSE_CONFIG=/env/config.toml"}, dir)
	if err != nil || options.ConfigPath != "/env/config.toml" || options.SourceOf("config") != Environment {
		t.Fatalf("environment config path: %v", err)
	}
	_, _, err = Resolve([]string{"leash", "--", "touch", filepath.Join(dir, "must-not-exist")}, nil, dir)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, "must-not-exist")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("parser ran a child command")
	}
}

func TestRejectsInvalidFlagsWithoutEchoingValues(t *testing.T) {
	secret := "tcSyntheticNeverInDiagnostics"
	for _, args := range [][]string{
		nil, {"unknown"}, {"--unknown"}, {"escape", "extra"}, {"config"}, {"config", "other"}, {"version", "extra"},
		{"escape", "--unknown", secret}, {"escape", "--ttl", secret}, {"escape", "--ttl", "-1s"}, {"escape", "--config="},
		{"escape", "--quiet", "--verbose"}, {"escape", "--quiet", "--json"}, {"escape", "--seed", "9223372036854775808"},
		{"escape", "--round", "29s"}, {"escape", "--round", "46s"}, {"escape", "--map", secret}, {"escape", "--control", "voice"},
		{"escape", "--web-base-url", "https://user:password@example.com"}, {"escape", "--web-base-url", "https://example.com/#"},
		{"escape", "--web-base-url", "https://example.com/?a=b"}, {"escape", "--web-base-url", "http://example.com/"},
		{"escape", "--web-base-url", "%"}, {"escape", "--web-base-url", "https:///"}, {"escape", "--derp-map-url", "http://map.example/"},
		{"escape", "--web-base-url", "https://host:99999/"}, {"escape", "--web-base-url", "https://host:0/"}, {"escape", "--web-base-url", "https://bad_.example/"},
		{"escape", "--derp-host", "derp.example", "--derp-map-url", "https://map.example/"},
		{"escape", "--derp-host", "192.0.2.1"},
		{"leash"}, {"leash", "echo"}, {"leash", "--unknown"}, {"leash", "--"}, {"leash", "--", ""},
		{"leash", "--", "echo", "bad\x00value"}, {"leash", "--title", "bad\ntext", "--", "echo"},
		{"leash", "--cwd", "bad\x00path", "--", "echo"}, {"leash", "--env", "=value", "--", "echo"},
		{"leash", "--env", "noequals", "--", "echo"}, {"leash", "--env", "A=bad\x00value", "--", "echo"},
		{"leash", "--post-exit-ttl", "-1s", "--", "echo"}, {"leash", "--reconnect-grace", "-1s", "--", "echo"},
		{"leash", "--scrollback-bytes", "65535", "--", "echo"}, {"leash", "--scrollback-bytes", "16777217", "--", "echo"},
		{"leash", "--start-on", secret, "--", "echo"},
	} {
		_, _, err := Resolve(args, nil, t.TempDir())
		if ExitCode(err) != ExitConfig {
			t.Fatalf("invalid flags returned %v", err)
		}
		if strings.Contains(err.Error(), secret) {
			t.Fatal("diagnostic contains rejected input")
		}
	}
	for _, host := range []string{"https://example.com", "", "bad..example", "-bad.example", "bad-.example", "bad_.example", " bad.example", strings.Repeat("a", 254), strings.Repeat("a", 64) + ".example"} {
		if validHostname(host) {
			t.Fatal("invalid DNS host accepted")
		}
	}
	for _, host := range []string{"a.example", "EXAMPLE.com.", "localhost", "a1.example"} {
		if !validHostname(host) {
			t.Fatal("valid DNS host rejected")
		}
	}
}

func TestEnvironmentValidationAndRelayPrecedence(t *testing.T) {
	for _, env := range [][]string{
		{"TAILMOUSE_TTL=bad"}, {"TAILMOUSE_TTL=-1s"}, {"TAILMOUSE_NO_QR=maybe"}, {"TAILMOUSE_LOG=secret"},
		{"TAILMOUSE_CONFIG="}, {"TAILMOUSE_CONFIG=bad\x00path"}, {"TAILMOUSE_WEB_BASE_URL=bad"},
		{"TAILMOUSE_DERP_MAP_URL=http://bad.example/"},
		{"TAILMOUSE_DERP_HOST=a.example", "TAILMOUSE_DERP_MAP_URL=https://map.example/"}, {"TAILMOUSE_DERP_HOST=a.example,"},
	} {
		_, _, err := Resolve([]string{"leash", "--", "example-command"}, env, t.TempDir())
		if ExitCode(err) != ExitConfig {
			t.Fatalf("invalid environment error: %v", err)
		}
	}
	options, _, err := Resolve([]string{"leash", "--derp-host", "flag.example", "--", "example-command"}, []string{"TAILMOUSE_DERP_HOST=env.example", "OTHER=ignored"}, t.TempDir())
	if err != nil || !reflect.DeepEqual(options.Relay.Hosts, []string{"flag.example"}) || options.SourceOf("derp-host") != Flag {
		t.Fatalf("host precedence: %v", err)
	}
	options, _, err = Resolve([]string{"leash", "--", "example-command"}, []string{"TAILMOUSE_DERP_MAP_URL=https://map.example/derp.json"}, t.TempDir())
	if err != nil || options.Relay.MapURL != "https://map.example/derp.json" {
		t.Fatalf("map environment: %v", err)
	}
	_, _, err = Resolve([]string{"leash", "--", "example-command"}, nil, "")
	if ExitCode(err) != ExitConfig {
		t.Fatal("missing platform config directory accepted")
	}
}

func TestFlagsCanResolveCrossSourceRelayConflictByClearingOneField(t *testing.T) {
	dir := t.TempDir()
	path := writeConfig(t, dir, "version=1\n[derp]\nmap_url='https://map.example/'")
	options, _, err := Resolve([]string{"leash", "--config", path, "--derp-map-url=", "--", "example-command"}, []string{"TAILMOUSE_DERP_HOST=host.example"}, dir)
	if err != nil || len(options.Relay.Hosts) != 1 || options.Relay.MapURL != "" {
		t.Fatalf("explicit clearing failed: %v", err)
	}
	_, _, err = Resolve([]string{"leash", "--config", path, "--", "example-command"}, []string{"TAILMOUSE_DERP_HOST=host.example"}, dir)
	if ExitCode(err) != ExitConfig {
		t.Fatal("effective cross-source relay conflict was accepted")
	}
	for _, url := range []string{"http://localhost:4173/", "http://127.0.0.1:4173/", "http://[::1]:4173/", "https://[2001:db8::1]/"} {
		options, _, err := Resolve([]string{"leash", "--web-base-url", url, "--", "example-command"}, nil, t.TempDir())
		if err != nil || options.WebBaseURL != url {
			t.Fatalf("valid loopback/HTTPS URL: %v", err)
		}
	}
}

func TestTOMLCompleteSchemaAndBounds(t *testing.T) {
	dir := t.TempDir()
	path := writeConfig(t, dir, `version=1
[web]
base_url="https://file.example/"
[derp]
mode="custom-host"
hosts=["first.example", "second.example"]
derp_port=4443
stun_port=3479
region_id=901
region_code="local"
region_name="Local relay"
[session]
leash_ttl="3h"
[leash]
scrollback_bytes=16777216
post_exit_ttl="5m"
start_on="connect"
local_input=false
`)
	options, _, err := Resolve([]string{"leash", "--config", path, "--", "echo"}, nil, dir)
	if err != nil {
		t.Fatal(err)
	}
	if options.TTL != 3*time.Hour || options.Leash.ScrollbackBytes != 16<<20 || options.Leash.PostExitTTL != 5*time.Minute || options.Leash.PostExitHost || options.Leash.ReconnectGrace != 30*time.Second || options.Leash.LocalInput || options.Leash.StartOn != "connect" || options.Relay.DERPPort != 4443 || options.Relay.STUNPort != 3479 || options.Relay.RegionID != 901 || options.Relay.RegionCode != "local" || options.Relay.RegionName != "Local relay" || len(options.Relay.Hosts) != 2 {
		t.Fatal("TOML values were lost")
	}
	if options.SourceOf("local-input") != File || options.SourceOf("ttl") != File {
		t.Fatal("TOML source metadata missing")
	}
	for _, contents := range []string{
		"", "version=2", "version='one'", "version=1\nunknown=42", "version=1\nversion=1", "version=1\n[web]\nbase_url='bad'",
		"version=1\n[derp]\nmode='invalid'", "version=1\n[derp]\nmode='custom-host'", "version=1\n[derp]\nmode='custom-map'",
		"version=1\n[derp]\nmode='official'\nhosts=['derp.example']", "version=1\n[derp]\nhosts=['derp.example']\nmap_url='https://map.example/'",
		"version=1\n[derp]\nderp_port=0", "version=1\n[derp]\nstun_port=65536", "version=1\n[derp]\nregion_id=899",
		"version=1\n[derp]\nregion_code=''", "version=1\n[derp]\nregion_name='bad\tlabel'", "version=1\n[session]\nleash_ttl='-1s'",
		"version=1\n[session]\nleash_ttl='bad'", "version=1\n[leash]\nscrollback_bytes=1", "version=1\n[leash]\nstart_on='bad'",
	} {
		path := writeConfig(t, t.TempDir(), contents)
		_, _, err := Resolve([]string{"leash", "--config", path, "--", "example-command"}, nil, dir)
		if ExitCode(err) != ExitConfig {
			t.Fatalf("invalid file returned %v", err)
		}
	}
	for _, derp := range []string{"hosts=['derp.example']", "map_url='https://map.example/'", "mode='custom-map'\nmap_url='https://map.example/'"} {
		path := writeConfig(t, t.TempDir(), "version=1\n[derp]\n"+derp)
		if _, _, err := Resolve([]string{"leash", "--config", path, "--", "example-command"}, nil, dir); err != nil {
			t.Fatalf("valid relay TOML: %v", err)
		}
	}
}

func TestFileFailuresAndExitClassification(t *testing.T) {
	dir := t.TempDir()
	oversized := writeConfig(t, dir, strings.Repeat("a", maxConfigBytes+1))
	for _, path := range []string{oversized, dir, filepath.Join(dir, "missing.toml"), "bad\x00path"} {
		_, _, err := Resolve([]string{"leash", "--config", path, "--", "example-command"}, nil, dir)
		if ExitCode(err) != ExitConfig {
			t.Fatalf("file failure: %v", err)
		}
	}
	if ExitCode(nil) != ExitOK || ExitCode(errors.New("internal")) != ExitInternal {
		t.Fatal("exit classification changed")
	}
	want := []int{0, 2, 3, 4, 5, 6, 7, 8, 125, 126, 127}
	got := []int{ExitOK, ExitConfig, ExitInvitation, ExitTransport, ExitProtocol, ExitPTY, ExitChildStart, ExitExpired, ExitInternal, ExitNotExecutable, ExitNotFound}
	if !reflect.DeepEqual(got, want) {
		t.Fatal("PRD exit codes changed")
	}
}

func writeConfig(t *testing.T, dir, contents string) string {
	t.Helper()
	path := filepath.Join(dir, "config.toml")
	if err := os.WriteFile(path, []byte(contents), 0600); err != nil {
		t.Fatal(err)
	}
	return path
}
