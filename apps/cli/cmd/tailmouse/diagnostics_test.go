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
	"tailmouse/apps/cli/internal/invitation"
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
				OutputRingUsed: 65536, OutputDroppedBytes: 23, ProcessGeneration: 4, EscapeInputRate: 20, EscapeSnapshotRate: 10}
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
				if strings.Contains(output.String(), "mode       ring 65536 bytes; dropped 23 bytes; generation 4; Escape input/snapshots 20.0/10.0 per second") != options.Verbose {
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
		{args: []string{"--json", "escape", "--ttl=-1s"}},
		{args: []string{"escape", "--json", "--config", "/synthetic-private-path/missing.toml"}},
		{args: []string{"--json", "--unknown=tcSyntheticSecret"}},
		{args: []string{"escape", "--json", "--quiet"}},
		{args: []string{"escape"}, env: []string{"TAILMOUSE_LOG=json", "TAILMOUSE_TTL=tcSyntheticSecret"}},
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
	for _, args := range [][]string{{"escape"}, {"escape", "--quiet"}, {"escape", "--verbose"}, {"escape", "--squeak"}, {"escape", "--json", "--squeak"}} {
		var output bytes.Buffer
		code := run(context.Background(), nil, args, []string{"TAILMOUSE_WEB_BASE_URL=https://private.example.com/"}, t.TempDir(), io.Discard, &output,
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

func TestRunJSONLifecycleKeepsInvitationOutOfDiagnostics(t *testing.T) {
	fake := newFakeTransport()
	output := &cardCapture{card: make(chan invitation.MouseCard, 1)}
	peerDone := make(chan error, 1)
	go func() { peerDone <- exerciseCLIConnection(output.card, fake, false) }()
	var stderr bytes.Buffer
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	code := run(ctx, nil, []string{"escape", "--json", "--squeak", "--no-qr"}, nil, t.TempDir(), output, &stderr, fake.start)
	if code != exitOK || <-peerDone != nil {
		t.Fatal("JSON CLI session did not finish successfully")
	}
	events := decodeDiagnostics(t, stderr.String())
	connected, selected := false, false
	for _, event := range events {
		connected = connected || event.Event == "browser_connected"
		selected = selected || event.Event == "relay_selected"
	}
	if !connected || !selected || events[len(events)-1].Event != "session_closed" {
		t.Fatal("short CLI session lost a state transition")
	}
	assertSafeDiagnostics(t, stderr.String())
	// The one Open line is the authorized bearer surface, not a diagnostic.
	for _, line := range strings.Split(output.String(), "\n") {
		if !strings.HasPrefix(line, "Open: ") {
			assertSafeDiagnostics(t, line)
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

func TestSpectatorDiagnosticsRemainSafeAndRestoreLineEndings(t *testing.T) {
	for _, mode := range []string{"human", "verbose", "json"} {
		var output bytes.Buffer
		options := config.Options{JSON: mode == "json", Verbose: mode == "verbose"}
		log := newDiagnostics(options, &output)
		log.terminal(true, true)
		for _, kind := range []session.EventKind{session.BrowserConnected, session.RTTMeasured, session.BrowserDisconnected} {
			if err := log.observe(session.Event{Kind: kind}); err != nil {
				t.Fatal(err)
			}
		}
		if mode == "human" {
			if output.Len() != 0 {
				t.Fatal("live HUD duplicated human connection diagnostics")
			}
		} else if !strings.Contains(output.String(), "\r\n") || strings.Contains(strings.ReplaceAll(output.String(), "\r\n", ""), "\n") {
			t.Fatal("raw terminal diagnostics contain unpaired newlines")
		}
		if mode == "json" && len(decodeDiagnostics(t, output.String())) != 3 {
			t.Fatal("spectator suppressed structured state events")
		}
		output.Reset()
		result := spectatorResult("caught")
		result.Message = "tcSyntheticPrivateResult"
		if log.gameResult(result) == nil || output.Len() != 0 {
			t.Fatal("invalid result crossed the diagnostic boundary")
		}
		log.terminal(false, false)
		if err := log.closed(exitOK, "mode_complete"); err != nil || strings.Contains(output.String(), "\r") || !strings.HasSuffix(output.String(), "\n") {
			t.Fatal("normal diagnostic line endings were not restored")
		}
		assertSafeDiagnostics(t, output.String(), "tcSyntheticPrivateResult")
	}
}

func TestDiagnosticFailureStopsStartupAndClosesOwnedTransport(t *testing.T) {
	for _, failAt := range []int{1, 2, 3, 4, 5} {
		fake := newFakeTransport()
		writer := &failDiagnosticAt{at: failAt}
		started := false
		code := run(context.Background(), nil, []string{"escape", "--json", "--no-qr"}, nil, t.TempDir(), io.Discard, writer,
			func(ctx context.Context, options tailcattransport.Config) (transportServer, error) {
				started = true
				return fake.start(ctx, options)
			})
		if code != exitInternal || (failAt == 1 && started) || (started && fake.closeCalls != 1) || writer.calls != failAt {
			t.Fatal("sink failure did not stop immediately and clean owned resources")
		}
	}
	for _, failAt := range []int{6, 7} {
		fake := newFakeTransport()
		output := &cardCapture{card: make(chan invitation.MouseCard, 1)}
		peerDone := make(chan error, 1)
		go func() { peerDone <- exerciseCLIConnection(output.card, fake, false) }()
		writer := &failDiagnosticAt{at: failAt}
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		code := run(ctx, nil, []string{"escape", "--json", "--no-qr"}, nil, t.TempDir(), output, writer, fake.start)
		select {
		case err := <-peerDone:
			if failAt == 7 && err != nil {
				t.Fatal("session did not finish before the final sink failure")
			}
		case <-ctx.Done():
			t.Fatal("failed diagnostic left a browser worker running")
		}
		cancel()
		if code != exitInternal || fake.closeCalls != 1 || writer.calls != failAt {
			t.Fatal("connected/final diagnostic failure lost its outcome or leaked transport")
		}
	}
	if code := run(context.Background(), nil, []string{"--json", "unknown"}, nil, t.TempDir(), io.Discard, failingWriter{}, startTailcat); code != exitConfig {
		t.Fatal("sink failure replaced an earlier configuration failure")
	}
}

type shortDiagnosticWriter struct{}

func (shortDiagnosticWriter) Write(value []byte) (int, error) { return len(value) - 1, nil }

type failDiagnosticAt struct{ at, calls int }

func (writer *failDiagnosticAt) Write(value []byte) (int, error) {
	writer.calls++
	if writer.calls == writer.at {
		return 0, errors.New("tcSyntheticSinkSecret")
	}
	return len(value), nil
}

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
