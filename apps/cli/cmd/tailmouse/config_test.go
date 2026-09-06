package main

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"tailmouse/apps/cli/internal/config"
	tailcattransport "tailmouse/apps/cli/internal/transport/tailcat"
)

func TestRunConfigurationPrecedenceReachesTransport(t *testing.T) {
	directory := t.TempDir()
	path := filepath.Join(directory, "settings.toml")
	contents := `version = 1
[derp]
hosts = ["file.example.com"]
derp_port = 8443
stun_port = 5349
region_id = 999
region_code = "private"
region_name = "Private DERP"
`
	if err := os.WriteFile(path, []byte(contents), 0o600); err != nil {
		t.Fatal(err)
	}
	var actual tailcattransport.Config
	starter := func(_ context.Context, value tailcattransport.Config) (transportServer, error) {
		actual = value
		return nil, tailcattransport.ErrStart
	}
	code := run(context.Background(), nil, []string{"escape", "--derp-host", "flag.example.com"},
		[]string{"TAILMOUSE_CONFIG=" + path, "TAILMOUSE_DERP_HOST=env.example.com"}, directory, io.Discard, io.Discard, starter)
	if code != exitTransport || len(actual.DERPHosts) != 1 || actual.DERPHosts[0] != "flag.example.com" ||
		actual.DERPPort != 8443 || actual.STUNPort != 5349 || actual.DERPRegion != 999 ||
		actual.RegionCode != "private" || actual.RegionName != "Private DERP" || actual.OnConnection == nil {
		t.Fatal("effective configuration did not reach transport")
	}
	for _, value := range []config.Relay{
		{DERPPort: 443, STUNPort: 3478, RegionID: 900, RegionCode: "mouse"},
		{MapURL: "https://map.example.com/derp.json", RegionID: 900},
	} {
		actual := relayConfig(value)
		if actual.DERPRegion != 0 || actual.RegionCode != "" || actual.DERPPort != 0 || actual.STUNPort != 0 || actual.DERPMapURL != value.MapURL {
			t.Fatal("host defaults contaminated official or map mode")
		}
	}
}

func TestRunZeroTTLAndCanceledStartup(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	code := run(ctx, nil, []string{"escape", "--ttl", "0"}, nil, t.TempDir(), io.Discard, io.Discard,
		func(ctx context.Context, _ tailcattransport.Config) (transportServer, error) {
			if _, exists := ctx.Deadline(); exists {
				t.Fatal("zero TTL installed a deadline")
			}
			cancel()
			return nil, context.Canceled
		})
	if code != exitExpired {
		t.Fatalf("canceled initialization code = %d", code)
	}
}

func TestRunInformationalCommandsHaveNoSideEffects(t *testing.T) {
	for _, args := range [][]string{{"--help"}, {"escape", "--help"}, {"leash", "--help"}, {"version"}, {"config", "path"}} {
		var stdout, stderr bytes.Buffer
		called := false
		code := run(context.Background(), nil, args, []string{"TAILMOUSE_TTL=invalid"}, t.TempDir(), &stdout, &stderr,
			func(context.Context, tailcattransport.Config) (transportServer, error) {
				called = true
				return nil, errors.New("must not start")
			})
		if code != exitOK || called || stdout.Len() == 0 || stderr.Len() != 0 {
			t.Fatalf("informational command %v: code %d, initialized %v", args, code, called)
		}
	}
	for _, args := range [][]string{{"--help"}, {"version"}, {"config", "path"}} {
		code := run(context.Background(), nil, args, nil, t.TempDir(), failingWriter{}, io.Discard, startTailcat)
		if code != exitInternal {
			t.Fatalf("output failure for %v was not classified", args)
		}
	}
}

func TestRunRejectsLeashReconnectGraceBeforeSideEffects(t *testing.T) {
	directory := t.TempDir()
	path := filepath.Join(directory, "legacy.toml")
	if err := os.WriteFile(path, []byte("version=1\n[session]\nreconnect_grace='15s'\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		name string
		args []string
		env  []string
	}{
		{"flag", []string{"leash", "--reconnect-grace=15s", "--", "must-not-run"}, nil},
		{"environment", []string{"leash", "--", "must-not-run"}, []string{"TAILMOUSE_RECONNECT_GRACE=15s"}},
		{"file", []string{"leash", "--config", path, "--", "must-not-run"}, nil},
	} {
		t.Run(test.name, func(t *testing.T) {
			called := false
			var stderr bytes.Buffer
			code := run(context.Background(), nil, test.args, test.env, directory, io.Discard, &stderr,
				func(context.Context, tailcattransport.Config) (transportServer, error) {
					called = true
					return nil, errors.New("must not start")
				})
			if code != exitConfig || called || !strings.Contains(stderr.String(), "reconnect-grace") || !strings.Contains(stderr.String(), "returns to listening") {
				t.Fatalf("legacy reconnect setting crossed the configuration boundary: code=%d called=%v", code, called)
			}
		})
	}
}

type failingWriter struct{}

func (failingWriter) Write([]byte) (int, error) { return 0, errors.New("output unavailable") }

// These tests execute the real composition root, not a test-only CLI parser.
// A private environment keeps the operator's actual configuration out of them.
func TestCLIProcessConfigurationBoundary(t *testing.T) {
	directory := t.TempDir()
	executable := filepath.Join(directory, "tailmouse")
	if runtime.GOOS == "windows" {
		executable += ".exe"
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	build := exec.CommandContext(ctx, "go", "build", "-o", executable, ".")
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build CLI: %v: %s", err, output)
	}
	path := filepath.Join(directory, "settings.toml")
	if err := os.WriteFile(path, []byte("version = 99\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	missing := filepath.Join(directory, "missing.toml")
	env := []string{"TAILMOUSE_CONFIG=" + path, "TAILMOUSE_TTL=secret-test-value"}
	for _, pair := range os.Environ() {
		if !strings.HasPrefix(pair, "TAILMOUSE_") {
			env = append(env, pair)
		}
	}
	for _, test := range []struct {
		name           string
		args           []string
		code           int
		stdout, stderr string
	}{
		{"root help bypasses invalid config", []string{"--help"}, 0, "Global flags", ""},
		{"leash help", []string{"leash", "--help"}, 0, "not native GUI windows", ""},
		{"leash help after delimiter-shaped title", []string{"leash", "--title", "--", "--help"}, 0, "Leash flags", ""},
		{"leash help after delimiter-shaped config path", []string{"leash", "--config", "--", "--help"}, 0, "Leash flags", ""},
		{"title value does not replace child separator", []string{"leash", "--title", "--", "must-not-run"}, 2, "", "leash command after --"},
		{"version bypasses invalid config", []string{"version"}, 0, "TMOUSE Escape protocol 1\nTMOUSE Leash protocol 2", ""},
		{"path environment", []string{"config", "path"}, 0, path, ""},
		{"path flag precedence", []string{"config", "path", "--config", missing}, 0, missing, ""},
		{"invalid file before transport", []string{"escape"}, 2, "", "version (expected 1)"},
		{"JSON invalid file before transport", []string{"--json", "escape"}, 2, "", "terminal_failure"},
		{"JSON invalid flags", []string{"--json", "escape", "--unknown=secret-test-value"}, 2, "", "terminal_failure"},
		{"missing explicit config", []string{"escape", "--config", missing}, 2, "", "unreadable"},
		{"invalid leash before process", []string{"leash", "--scrollback-bytes", "65535", "--", "must-not-run"}, 2, "", "invalid"},
		{"unknown command", []string{"unknown"}, 2, "", "Usage:"},
		{"missing leash command", []string{"leash", "--"}, 2, "", "invalid"},
	} {
		t.Run(test.name, func(t *testing.T) {
			// A newly linked image can spend seconds in platform startup before
			// Go initialization. This is a bounded correctness test, not a cold
			// startup benchmark; do not warm it up or retry a failed invocation.
			ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
			defer cancel()
			command := exec.CommandContext(ctx, executable, test.args...)
			command.Env, command.Dir = env, directory
			command.WaitDelay = time.Second
			var stdout, stderr bytes.Buffer
			command.Stdout, command.Stderr = &stdout, &stderr
			started := time.Now()
			err := command.Run()
			code := 0
			if err != nil {
				var exit *exec.ExitError
				if !errors.As(err, &exit) {
					t.Fatalf("execute CLI: %v", err)
				}
				code = exit.ExitCode()
			}
			if ctx.Err() != nil || code != test.code || !strings.Contains(stdout.String(), test.stdout) || !strings.Contains(stderr.String(), test.stderr) {
				t.Fatalf("CLI result mismatch: elapsed=%s context=%v code=%d stdout bytes=%d stderr bytes=%d (content redacted)", time.Since(started), ctx.Err(), code, stdout.Len(), stderr.Len())
			}
			if strings.Contains(stdout.String()+stderr.String(), "secret-test-value") || (test.code == 2 && stdout.Len() != 0) || (test.code == 0 && stderr.Len() != 0) {
				t.Fatal("CLI disclosed an invalid environment value or used the wrong output stream")
			}
			if strings.Contains(strings.Join(test.args, " "), "--json") {
				if len(decodeDiagnostics(t, stderr.String())) != 1 {
					t.Fatal("JSON CLI process mixed help text or duplicate failures into stderr")
				}
			}
		})
	}
}
