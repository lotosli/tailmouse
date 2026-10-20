package main

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	"tailmouse/apps/cli/internal/config"
	"tailmouse/apps/cli/internal/protocol"
	"tailmouse/apps/cli/internal/session"
	tailcattransport "tailmouse/apps/cli/internal/transport/tailcat"
)

func TestDiagnosticsHumanJSONQuietAndVerbose(t *testing.T) {
	for _, mode := range []string{"human", "json", "quiet", "verbose", "json-verbose"} {
		t.Run(mode, func(t *testing.T) {
			options := config.Options{Command: "leash", JSON: strings.Contains(mode, "json"), Quiet: mode == "quiet", Verbose: strings.Contains(mode, "verbose"), Sources: map[string]config.Source{"ttl": config.Flag}}
			var output bytes.Buffer
			log := newDiagnostics(options, &output)
			id := [16]byte{1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16}
			if err := log.begin(options, id, time.Unix(1234567890, 0)); err != nil {
				t.Fatal(err)
			}
			if err := log.accessState("link", false, false); err != nil {
				t.Fatal(err)
			}
			if err := log.listening(tailcattransport.Relay{Mode: tailcattransport.RelayOfficial, Host: "relay.example.com"}, true); err != nil {
				t.Fatal(err)
			}
			if err := log.invitationPresented(); err != nil {
				t.Fatal(err)
			}
			metrics := session.Metrics{LatencySnapshot: session.LatencySnapshot{Samples: 2, RTTMS: 42, JitterMS: 3, P50MS: 40, P95MS: 50}, BytesTX: 100, FramesTX: 2,
				OutputRingUsed: 65536, OutputDroppedBytes: 23, ProcessGeneration: 4}
			for _, kind := range []session.EventKind{session.BrowserConnected, session.RTTMeasured, session.TerminalOutputDropped, session.BrowserDisconnected} {
				if err := log.observe(session.Event{Kind: kind, Metrics: metrics, Dropped: protocol.OutputDropped{Generation: 4, Bytes: 23}}); err != nil {
					t.Fatal(err)
				}
			}
			if err := log.closed(exitOK, "mode_complete"); err != nil {
				t.Fatal(err)
			}
			assertSafeDiagnostics(t, output.String(), hex.EncodeToString(id[:]))
			if mode == "quiet" {
				if strings.Count(output.String(), "\n") != 2 || !strings.Contains(output.String(), "Password protection is disabled") || !strings.Contains(output.String(), "No TTL") {
					t.Fatal("quiet did not retain exactly the two mandatory warnings")
				}
			} else if options.JSON {
				events := decodeDiagnostics(t, output.String())
				foundRTT, foundDetails, foundAccess := false, false, false
				for _, event := range events {
					if event.Event == "rtt" {
						foundRTT = true
						if event.RTTMS != 42 || event.P95MS != 50 || (event.Metrics != nil) != options.Verbose {
							t.Fatal("RTT JSON fields do not match measurements or verbosity")
						}
						if options.Verbose && *event.Metrics != metrics {
							t.Fatal("verbose JSON changed or omitted mode metrics")
						}
					}
					if event.Event == "diagnostic_details" {
						foundDetails = true
						if event.Sources["ttl"] != config.Flag || event.Version != buildVersion || event.Tailcat != tailcatRevision {
							t.Fatal("verbose identity/source detail missing")
						}
					}
					if event.Event == "access_state" {
						foundAccess = event.AccessMode == "link" && event.Authentication == "waiting" && event.AccessCodePresented != nil && !*event.AccessCodePresented
					}
					if !regexp.MustCompile(`^[0-9a-f]{8}$`).MatchString(event.Session) {
						t.Fatal("session identifier is not a bounded hash prefix")
					}
				}
				if !foundRTT || !foundAccess || foundDetails != options.Verbose || events[len(events)-1].Event != "session_closed" {
					t.Fatal("JSON event sequence incomplete")
				}
			} else {
				for _, expected := range []string{"mode       leash", "expires    2009-02-13T23:31:30Z", "access     link-only; authentication not required", "relay      official / relay.example.com", "browser    waiting", "browser    active", "RTT        42.0 ms; jitter 3.0 ms; p50 40.0 ms; p95 50.0 ms", "output     23 bytes dropped in generation 4 (cumulative)", "browser    disconnected", "mode_complete"} {
					if !strings.Contains(output.String(), expected) {
						t.Fatal("human session diagnostics incomplete")
					}
				}
				if strings.Contains(output.String(), "network    bytes") != options.Verbose || strings.Contains(output.String(), "sources    ") != options.Verbose {
					t.Fatal("human verbosity not applied")
				}
				if strings.Contains(output.String(), "mode       ring 65536 bytes; dropped 23 bytes; generation 4") != options.Verbose {
					t.Fatal("human mode metrics do not match values or verbosity")
				}
			}
		})
	}
}

func TestJSONConfigurationErrorsStayJSONAndPreserveOutputSelection(t *testing.T) {
	for _, test := range []struct {
		args []string
		env  []string
	}{
		{args: []string{"--json", "leash", "--ttl=-1s"}},
		{args: []string{"leash", "--json", "--config", "/synthetic-private-path/missing.toml"}},
		{args: []string{"--json", "--unknown=tcSyntheticSecret"}},
		{args: []string{"leash", "--json", "--quiet"}},
		{args: []string{"leash"}, env: []string{"TAILMOUSE_LOG=json", "TAILMOUSE_TTL=tcSyntheticSecret"}},
		{args: []string{"leash", "--json", "--", "not-started"}, env: []string{"TAILMOUSE_WEB_BASE_URL=tcSyntheticSecret"}},
	} {
		var output bytes.Buffer
		called := false
		code := run(context.Background(), nil, test.args, test.env, t.TempDir(), io.Discard, &output,
			func(context.Context, tailcattransport.Config) (transportServer, error) {
				called = true
				return nil, nil
			})
		if code != exitConfig || called {
			t.Fatal("invalid configuration reached transport or lost its exit code")
		}
		events := decodeDiagnostics(t, output.String())
		if len(events) != 1 || events[0].Event != "terminal_failure" || events[0].Code != exitConfig || events[0].Reason != "configuration" {
			t.Fatal("configuration failure did not produce one typed event")
		}
		assertSafeDiagnostics(t, output.String(), "tcSyntheticSecret", "synthetic-private-path")
	}
}

func TestDiagnosticSqueakAliasAndStartupFailureRedaction(t *testing.T) {
	for _, args := range [][]string{{"leash"}, {"leash", "--quiet"}, {"leash", "--verbose"}, {"leash", "--squeak"}, {"leash", "--json", "--squeak"}} {
		var output bytes.Buffer
		code := run(context.Background(), nil, append(args, "--no-password", "--", "unused"), []string{"TAILMOUSE_WEB_BASE_URL=https://private.example.com/"}, t.TempDir(), io.Discard, &output,
			func(context.Context, tailcattransport.Config) (transportServer, error) {
				return nil, errors.New("upstream tcSyntheticSecret https://private.example.com/#/v1/SYNTHETIC")
			})
		if code != exitTransport || !strings.Contains(output.String(), "transport_start") {
			t.Fatal("transport root failure lost its safe classification")
		}
		assertSafeDiagnostics(t, output.String(), "tcSyntheticSecret", "private.example.com")
		verbose := strings.Contains(strings.Join(args, " "), "--verbose") || strings.Contains(strings.Join(args, " "), "--squeak")
		if strings.Contains(output.String(), "unrecorded") != verbose {
			t.Fatal("squeak/verbose did not control build detail")
		}
		if strings.Contains(strings.Join(args, " "), "--json") {
			decodeDiagnostics(t, output.String())
		}
	}
}

func TestDiagnosticSinkFirstFailureAndConcurrentJSON(t *testing.T) {
	for _, writer := range []io.Writer{failingWriter{}, shortDiagnosticWriter{}} {
		log := newDiagnostics(config.Options{JSON: true}, writer)
		first := log.closed(exitTransport, "transport_start")
		if first == nil || log.closed(exitOK, "mode_complete") != first {
			t.Fatal("diagnostic sink failure was ignored or replaced")
		}
	}
	var output bytes.Buffer
	log := newDiagnostics(config.Options{JSON: true}, &output)
	var workers sync.WaitGroup
	for range 8 {
		workers.Go(func() {
			if err := log.observe(session.Event{Kind: session.BrowserConnected}); err != nil {
				t.Error("concurrent diagnostic write failed")
			}
		})
	}
	workers.Wait()
	if len(decodeDiagnostics(t, output.String())) != 8 {
		t.Fatal("concurrent events interleaved or were dropped")
	}
	if log.observe(session.Event{}) == nil {
		t.Fatal("unknown diagnostic event accepted")
	}
}

type shortDiagnosticWriter struct{}

func (shortDiagnosticWriter) Write(value []byte) (int, error) { return len(value) - 1, nil }

func decodeDiagnostics(t *testing.T, output string) []diagnosticRecord {
	t.Helper()
	var events []diagnosticRecord
	for _, line := range strings.Split(strings.TrimSpace(output), "\n") {
		var event diagnosticRecord
		if json.Unmarshal([]byte(line), &event) != nil || event.Event == "" {
			t.Fatal("diagnostic line is not a JSON event (content redacted)")
		}
		if _, err := time.Parse(time.RFC3339Nano, event.TS); err != nil {
			t.Fatal("diagnostic timestamp missing or malformed")
		}
		events = append(events, event)
	}
	return events
}

func assertSafeDiagnostics(t *testing.T, output string, private ...string) {
	t.Helper()
	for _, value := range append(private, "://", "#/v1/", syntheticAddress) {
		if strings.Contains(output, value) {
			t.Fatal("diagnostic disclosed a private value (content redacted)")
		}
	}
}
