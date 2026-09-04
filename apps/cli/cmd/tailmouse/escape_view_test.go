package main

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net"
	"slices"
	"strings"
	"sync"
	"testing"
	"testing/synctest"
	"time"

	"tailmouse/apps/cli/internal/config"
	"tailmouse/apps/cli/internal/escape"
	"tailmouse/apps/cli/internal/protocol"
	"tailmouse/apps/cli/internal/session"
)

func spectatorResult(outcome string) protocol.GameResult {
	jitter := float64(6)
	return protocol.GameResult{Outcome: outcome, ElapsedMS: 34200, Relay: "relay.example.test", RTTP50MS: 48, RTTP95MS: 63, JitterMS: &jitter, Message: protocol.GameResultMessage(outcome, 48)}
}

func TestDisplayScentUsesBoundedRTTAndUnevenJitterWithoutMovingPoints(t *testing.T) {
	view := session.EscapeView{ScentCount: escape.ScentCapacity}
	view.State.Elapsed = time.Second
	for index := range view.Scent {
		view.Scent[index] = escape.ScentPoint{At: time.Second - time.Duration(escape.ScentCapacity-1-index)*30*time.Millisecond, Position: escape.Point{X: float32(index), Y: 3}}
	}
	selectPoints := func(rtt, jitter float64) []escape.ScentPoint {
		points, count := displayScent(view, session.Metrics{LatencySnapshot: session.LatencySnapshot{RTTMS: rtt, JitterMS: jitter}})
		return points[:count]
	}
	short, long := selectPoints(40, 0), selectPoints(250, 0)
	if len(short) != 1 || len(long) != 7 || short[0] != long[0] || long[len(long)-1].At != 580*time.Millisecond {
		t.Fatal("RTT did not select the expected bounded history window")
	}
	for _, pair := range [][2]float64{{0, 40}, {10000, 250}} {
		if !slices.Equal(selectPoints(pair[0], 0), selectPoints(pair[1], 0)) {
			t.Fatal("RTT presentation clamp changed")
		}
	}
	jittered := selectPoints(250, 50)
	if len(jittered) < 3 || jittered[0].At-jittered[1].At == jittered[1].At-jittered[2].At {
		t.Fatal("jitter did not create unequal sample gaps")
	}
	if !slices.Equal(jittered, selectPoints(250, 1000)) || !slices.Equal(long, selectPoints(250, -1)) {
		t.Fatal("jitter presentation clamp changed")
	}
	for _, point := range jittered {
		if !slices.Contains(view.Scent[:], point) || point.At > view.State.Elapsed || point.At < view.State.Elapsed-500*time.Millisecond {
			t.Fatal("display invented or retained an invalid scent point")
		}
	}
	view.Scent[escape.ScentCapacity-1].At = 2 * time.Second
	points, count := displayScent(view, session.Metrics{})
	for _, point := range points[:count] {
		if point.At > view.State.Elapsed {
			t.Fatal("display selected a future scent point")
		}
	}
}

func TestEscapeTerminalMapAndSummary(t *testing.T) {
	engine, err := escape.New("courtyard", 42, escape.DefaultRound)
	if err != nil {
		t.Fatal(err)
	}
	view := session.EscapeView{Started: true, Round: 1, State: escape.RoundState{State: engine.Inspect()}, Map: engine.Map(), Relay: "relay.example.test", Queue: 2}
	view.State.Elapsed = 100 * time.Millisecond
	view.Scent[0] = escape.ScentPoint{At: 40 * time.Millisecond, Position: escape.Point{X: 5.5, Y: 3.5}}
	view.ScentCount = 1
	display := escapeDisplay{width: 100, height: 24, showNet: true, interactive: true}
	metrics := session.Metrics{LatencySnapshot: session.LatencySnapshot{Samples: 1, RTTMS: 48, JitterMS: 6}, BytesTX: 100, BytesRX: 200, EscapeInputRate: 20, EscapeSnapshotRate: 10}
	screen, err := escapeScreen(view, metrics, display)
	if err != nil {
		t.Fatal(err)
	}
	for _, expected := range []string{"TAILMOUSE ESCAPE", "DERP: relay.example.test", "RTT 48ms  Jitter 6ms", "Time 00:45", "Get ready: 3", "Cheese 0/2  Dash READY  Queue 2  Squeaks 20/s", "q/Ctrl+C exit | d debug", "M mouse | C cat"} {
		if !strings.Contains(screen, expected) {
			t.Fatalf("missing spectator field %q", expected)
		}
	}
	lines := strings.Split(screen, "\r\n")
	if len(lines) != 24 {
		t.Fatalf("spectator rows = %d", len(lines))
	}
	for _, row := range lines[3:21] {
		if len(row) != 48 {
			t.Fatal("map width changed")
		}
	}
	if !strings.Contains(lines[6], "M .") || !strings.Contains(screen, "*") || !strings.Contains(screen, "x") {
		t.Fatal("map entities or scent absent")
	}
	view.State.Cheese = [2]bool{true, true}
	view.State.DashCooldown = 4200 * time.Millisecond
	view.State.Paused = true
	display.debug = true
	screen, _ = escapeScreen(view, metrics, display)
	for _, expected := range []string{"connection lost; paused", "Cheese 2/2  Dash 4.2s", "Scent 1", "Snap/s 10.0", "TX/RX 100/200"} {
		if !strings.Contains(screen, expected) {
			t.Fatalf("missing live state %q", expected)
		}
	}
	if !strings.Contains(screen, "O") {
		t.Fatal("open exit absent")
	}
	display.showNet = false
	display.interactive = false
	screen, _ = escapeScreen(view, metrics, display)
	for _, forbidden := range []string{"DERP:", "RTT", "Jitter", "Squeaks", "TX/RX", "Queue"} {
		if strings.Contains(screen, forbidden) {
			t.Fatal("network toggle ignored")
		}
	}
	if !strings.Contains(screen, "interactive keys unavailable") {
		t.Fatal("input degradation omitted")
	}
	display.width, display.height, display.debug, display.notice = 48, 8, false, "Restart needs a finished round and --once=false."
	screen, _ = escapeScreen(view, metrics, display)
	if !strings.Contains(screen, "Map needs a 48x24 terminal") || !strings.Contains(screen, "Restart needs") {
		t.Fatal("small terminal or invalid restart is silent")
	}
	display.width, display.height = 4, 1
	screen, _ = escapeScreen(view, metrics, display)
	if strings.Count(screen, "\r\n") != 0 || !strings.Contains(screen, "TAI>") {
		t.Fatal("viewport clipping failed")
	}
	for _, outcome := range []string{"caught", "escaped", "timeout", "connection_lost"} {
		result := spectatorResult(outcome)
		text, err := escapeResultText(result)
		if err != nil {
			t.Fatal(err)
		}
		for _, expected := range []string{"34.2s", "48ms", "63ms", "6ms", result.Relay, result.Message} {
			if !strings.Contains(text, expected) {
				t.Fatal("result field missing")
			}
		}
		view.Result, view.CanRestart, view.RestartPending = result, true, true
		screen, err = escapeScreen(view, metrics, escapeDisplay{width: 80, height: 24, interactive: true})
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(screen, "r restart") || !strings.Contains(screen, "Restart requested") {
			t.Fatal("retained round controls missing")
		}
		result.JitterMS = nil
		text, _ = escapeResultText(result)
		if strings.Contains(text, "Jitter") {
			t.Fatal("unknown jitter invented")
		}
		result.Message = "tcSyntheticPrivateDetail"
		if text, err := escapeResultText(result); err == nil || text != "" {
			t.Fatal("unvalidated result text escaped")
		}
		view.Result = result
		if screen, err := escapeScreen(view, metrics, display); err == nil || screen != "" {
			t.Fatal("unvalidated result screen escaped")
		}
	}
}

type testConsole struct {
	mu                                   sync.Mutex
	keys                                 chan byte
	frames                               []string
	closed                               int
	width, height                        int
	writeErr, sizeErr, readErr, closeErr error
	panicWrite, panicRead, panicSize     bool
}

func newTestConsole() *testConsole {
	return &testConsole{keys: make(chan byte, 32), width: 100, height: 24}
}
func (console *testConsole) ReadKey(ctx context.Context) (byte, error) {
	if console.panicRead {
		panic("synthetic input failure")
	}
	if console.readErr != nil {
		return 0, console.readErr
	}
	select {
	case <-ctx.Done():
		return 0, ctx.Err()
	case key, ok := <-console.keys:
		if !ok {
			return 0, io.EOF
		}
		return key, nil
	}
}
func (console *testConsole) Write(_ context.Context, text string) error {
	if console.panicWrite {
		panic("synthetic renderer failure")
	}
	console.mu.Lock()
	defer console.mu.Unlock()
	if console.writeErr != nil {
		return console.writeErr
	}
	if len(console.frames) >= 2048 {
		return errors.New("test frame capture is full")
	}
	console.frames = append(console.frames, text)
	return nil
}
func (console *testConsole) Size() (int, int, error) {
	if console.panicSize {
		panic("synthetic size failure")
	}
	return console.width, console.height, console.sizeErr
}
func (console *testConsole) Close() error {
	console.mu.Lock()
	defer console.mu.Unlock()
	console.closed++
	return console.closeErr
}
func (console *testConsole) output() string {
	console.mu.Lock()
	defer console.mu.Unlock()
	return strings.Join(console.frames, "")
}

type spectatorPeer struct {
	conn    net.Conn
	mu      sync.Mutex
	done    chan struct{}
	results chan struct{}
}

func (peer *spectatorPeer) send(frame protocol.Frame) error {
	peer.mu.Lock()
	defer peer.mu.Unlock()
	return protocol.WriteFrame(context.Background(), peer.conn, protocol.PeerBrowser, protocol.StateActiveEscape, frame)
}
func spectatorHost(t *testing.T, once bool) (*session.Host, *spectatorPeer) {
	t.Helper()
	id := [16]byte{1}
	ctx, cancel := context.WithCancel(context.Background())
	host, err := session.NewHost(ctx, session.Config{Mode: "escape", SessionID: id, TTL: time.Minute, ReconnectGrace: 30 * time.Second}, time.Now(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := host.ConfigureEscape(session.EscapeConfig{Map: "courtyard", Seed: 42, Round: escape.DefaultRound, Once: once, Control: "touch", PhoneRender: true, ShowNet: true}); err != nil {
		t.Fatal(err)
	}
	if err := host.Listen("custom-host", "relay.example.test", time.Now()); err != nil {
		t.Fatal(err)
	}
	server, browser := net.Pipe()
	host.Accept(server)
	hello, _ := json.Marshal(map[string]any{"protocol_min": 1, "protocol_max": 1, "session_id": hex.EncodeToString(id[:]), "mode": "escape", "client": map[string]string{"name": "test", "version": "1", "platform": "test", "user_agent": ""}})
	if err := protocol.WriteFrame(ctx, browser, protocol.PeerBrowser, protocol.StateAwaitClientHello, protocol.Frame{Type: protocol.TypeClientHello, Payload: hello}); err != nil {
		t.Fatal(err)
	}
	if _, err := protocol.ReadFrame(ctx, browser, protocol.PeerBrowser, protocol.StateAwaitServerWelcome); err != nil {
		t.Fatal(err)
	}
	peer := &spectatorPeer{conn: browser, done: make(chan struct{}), results: make(chan struct{}, 4)}
	go func() {
		defer close(peer.done)
		defer browser.Close()
		for {
			frame, err := protocol.ReadFrame(ctx, browser, protocol.PeerBrowser, protocol.StateActiveEscape)
			if err != nil {
				return
			}
			switch frame.Type {
			case protocol.TypePing:
				if peer.send(protocol.Frame{Type: protocol.TypePong, Payload: frame.Payload}) != nil {
					return
				}
			case protocol.TypeGameResult:
				peer.results <- struct{}{}
			case protocol.TypeClose:
				ack, _ := protocol.CloseFrame("normal")
				_ = peer.send(ack)
				return
			}
		}
	}()
	t.Cleanup(func() { cancel(); _ = host.Close("local_revoke"); <-peer.done })
	synctest.Wait()
	return host, peer
}
func spectatorInputs(peer *spectatorPeer) func() {
	stop, done := make(chan struct{}), make(chan struct{})
	go func() {
		defer close(done)
		ticker := time.NewTicker(50 * time.Millisecond)
		defer ticker.Stop()
		var sequence uint32
		for {
			select {
			case <-stop:
				return
			case <-peer.done:
				return
			case <-ticker.C:
				sequence++
				frame, _ := protocol.GameInputFrame(protocol.GameInput{Sequence: sequence})
				if peer.send(frame) != nil {
					return
				}
			}
		}
	}()
	return func() { close(stop); <-done }
}
func spectatorOptions() config.Options {
	return config.Options{Command: "escape", Escape: config.Escape{TerminalRender: true, ShowNet: true}}
}

// These view tests own Host cleanup separately. Native composition tests assert
// the application/mode/transport/console ordering of the production callback.
func spectatorCleanup(_ session.Outcome, cleanup func() session.Outcome) { cleanup() }

func TestSpectatorCadenceKeysRestartAndCleanup(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		host, peer := spectatorHost(t, false)
		stop := spectatorInputs(peer)
		defer stop()
		console := newTestConsole()
		var output, diagnostics bytes.Buffer
		log := newDiagnostics(spectatorOptions(), &diagnostics)
		done := make(chan session.Outcome, 1)
		go func() {
			outcome, err := watchEscape(context.Background(), host, spectatorOptions(), &output, log, console, true, spectatorCleanup)
			if err != nil {
				t.Error(err)
			}
			done <- outcome
		}()
		time.Sleep(time.Second)
		synctest.Wait()
		if count := strings.Count(console.output(), "\x1b[H"); count != 20 {
			t.Fatalf("20 Hz rendering count = %d", count)
		}
		console.keys <- 'r'
		console.keys <- 'd'
		time.Sleep(50 * time.Millisecond)
		synctest.Wait()
		if !strings.Contains(console.output(), "Tick ") {
			t.Fatal("debug key omitted debug HUD")
		}
		<-peer.results
		time.Sleep(50 * time.Millisecond)
		synctest.Wait()
		if !strings.Contains(console.output(), "THE CAT WON") {
			t.Fatal("terminal omitted authoritative result")
		}
		console.keys <- 'r'
		time.Sleep(1100 * time.Millisecond)
		synctest.Wait()
		if host.InspectEscapeView().Round != 2 {
			t.Fatal("local restart key did not reach host")
		}
		console.keys <- 'q'
		if outcome := <-done; outcome != session.LocalRevoke {
			t.Fatal(outcome)
		}
		if console.closed != 1 || !strings.HasSuffix(console.output(), "\x1b[?25h\x1b[?1049l") || output.Len() != 0 {
			t.Fatal("terminal cleanup or old-result clearing failed")
		}
		for _, secret := range []string{"tcSynthetic", "/#/v1/", "Open:"} {
			if strings.Contains(console.output(), secret) {
				t.Fatal("spectator retained invitation material")
			}
		}
	})
}

func TestSpectatorHeadlessResultsAndJSON(t *testing.T) {
	for _, terminalRender := range []bool{false, true} {
		synctest.Test(t, func(t *testing.T) {
			host, peer := spectatorHost(t, true)
			stop := spectatorInputs(peer)
			defer stop()
			options := spectatorOptions()
			options.JSON = true
			options.Escape.TerminalRender = terminalRender
			var stdout, stderr bytes.Buffer
			outcome, err := watchEscape(context.Background(), host, options, &stdout, newDiagnostics(options, &stderr), nil, false, spectatorCleanup)
			if err != nil || outcome != session.ModeComplete {
				t.Fatalf("headless outcome %s: %v", outcome, err)
			}
			if strings.Count(stdout.String(), "THE CAT WON") != 1 || strings.Contains(stdout.String(), "\x1b[") {
				t.Fatal("redirected output is animated or repeated")
			}
			var event diagnosticRecord
			if json.Unmarshal(bytes.TrimSpace(stderr.Bytes()), &event) != nil || event.Event != "mode_result" || event.Result == nil {
				t.Fatal("mode-result JSON missing")
			}
		})
	}
}

func TestSpectatorClearsResultWhileRestartWaitsForReconnect(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		host, peer := spectatorHost(t, false)
		stop := spectatorInputs(peer)
		defer stop()
		console := newTestConsole()
		done := make(chan error, 1)
		go func() {
			_, err := watchEscape(context.Background(), host, spectatorOptions(), io.Discard, newDiagnostics(spectatorOptions(), io.Discard), console, true, spectatorCleanup)
			done <- err
		}()
		<-peer.results
		if err := peer.conn.Close(); err != nil {
			t.Fatal(err)
		}
		<-peer.done
		synctest.Wait()
		console.keys <- 'r'
		time.Sleep(spectatorInterval)
		synctest.Wait()
		text := console.output()
		frame := text[strings.LastIndex(text, "\x1b[H"):]
		if !strings.Contains(frame, "Waiting for browser") || strings.Contains(frame, "THE CAT WON") {
			t.Fatal("disconnected restart retained the previous result on screen")
		}
		console.keys <- 'q'
		if err := <-done; err != nil {
			t.Fatal(err)
		}
	})
}

func TestSpectatorResultPresentationAndSinkFailures(t *testing.T) {
	for _, kind := range []string{"animated", "disabled", "input-only", "short-output", "failed-output", "failed-json"} {
		synctest.Test(t, func(t *testing.T) {
			host, peer := spectatorHost(t, true)
			stop := spectatorInputs(peer)
			defer stop()
			options := spectatorOptions()
			console := newTestConsole()
			var output bytes.Buffer
			var stdout io.Writer = &output
			var stderr io.Writer = io.Discard
			switch kind {
			case "disabled":
				options.Escape.TerminalRender = false
			case "input-only":
				console.width = 0
			case "short-output":
				console.width, stdout = 0, shortDiagnosticWriter{}
			case "failed-output":
				console.width, stdout = 0, failingWriter{}
			case "failed-json":
				options.JSON, stderr = true, failingWriter{}
			}
			log := newDiagnostics(options, stderr)
			outcome, err := watchEscape(context.Background(), host, options, stdout, log, console, true, spectatorCleanup)
			if strings.Contains(kind, "output") || kind == "failed-json" {
				if err == nil || outcome != session.InternalFailure {
					t.Fatalf("%s did not report result sink failure: %s %v", kind, outcome, err)
				}
			} else {
				if err != nil || outcome != session.ModeComplete {
					t.Fatalf("%s result failed: %s %v", kind, outcome, err)
				}
				text := console.output()
				if kind == "animated" {
					end := strings.LastIndex(text, "\x1b[?25h\x1b[?1049l")
					if end < 0 || strings.Count(text[end:], "THE CAT WON") != 1 || output.Len() != 0 {
						t.Fatal("safe result was not retained after leaving the alternate screen")
					}
				} else if strings.Contains(text, "\x1b[") || strings.Count(text+output.String(), "THE CAT WON") != 1 {
					t.Fatal("non-rendering output was animated or repeated")
				}
				assertSafeDiagnostics(t, text+output.String())
			}
			if console.closed != 1 || log.rawTerminal || log.spectator {
				t.Fatal("result cleanup retained terminal mode")
			}
		})
	}
}

func TestSpectatorRestoresAfterErrorsCancellationAndPanic(t *testing.T) {
	for _, kind := range []string{"write", "size", "read", "close", "panic", "panic-read", "panic-size", "interrupt", "eof"} {
		synctest.Test(t, func(t *testing.T) {
			host, _ := spectatorHost(t, false)
			console := newTestConsole()
			injected := errors.New("synthetic terminal failure")
			switch kind {
			case "write":
				console.writeErr = injected
			case "size":
				console.sizeErr = injected
			case "read":
				console.readErr = injected
			case "close":
				console.closeErr = injected
			case "panic":
				console.panicWrite = true
			case "panic-read":
				console.panicRead = true
			case "panic-size":
				console.panicSize = true
			case "interrupt":
				console.keys <- 3
			case "eof":
				close(console.keys)
			}
			ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
			defer cancel()
			outcome, err := watchEscape(ctx, host, spectatorOptions(), io.Discard, newDiagnostics(spectatorOptions(), io.Discard), console, true, spectatorCleanup)
			if console.closed != 1 {
				t.Fatalf("%s omitted terminal restoration", kind)
			}
			if kind == "interrupt" || kind == "eof" {
				if outcome != session.LocalRevoke || err != nil {
					t.Fatalf("%s changed local revoke: %s %v", kind, outcome, err)
				}
			} else if err == nil {
				t.Fatalf("%s swallowed a terminal failure", kind)
			}
		})
	}
}
