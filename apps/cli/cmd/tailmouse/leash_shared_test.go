//go:build darwin || linux || windows

package main

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"golang.org/x/term"
	"tailmouse/apps/cli/internal/invitation"
	"tailmouse/apps/cli/internal/protocol"
	"tailmouse/apps/cli/internal/session"
)

const leashEcho = "q\x03\x1b[A🐈"

// The network child must live through the owning browser fixture's bounded
// reconnect, outage, history replay, retention and cleanup sequence.
const leashNetworkFixtureTimeout = 2 * time.Minute

func TestLeashCLIChild(t *testing.T) {
	mode := os.Getenv("TAILMOUSE_LEASH_CLI_CHILD")
	if mode == "" {
		return
	}
	deadline := 12 * time.Second
	if mode == "performance" {
		// Idle-memory measurement includes a 35-second natural worker settle.
		deadline = 90 * time.Second
	} else if mode == "crash" {
		// A new browser must reload Wasm and reconnect after an abrupt loss.
		deadline = 60 * time.Second
	} else if mode == "network" {
		deadline = leashNetworkFixtureTimeout
	}
	time.AfterFunc(deadline, func() { os.Exit(124) })
	if mode == "short-exit" {
		fmt.Fprintln(os.Stdout, "short-test-child-started")
		os.Exit(7)
	}
	if mode == "exit" {
		fmt.Fprintln(os.Stdout, "child-finished")
		os.Exit(37)
	}
	if mode == "bulk" || mode == "bulk-raw" {
		if mode == "bulk-raw" {
			if _, err := term.MakeRaw(int(os.Stdin.Fd())); err != nil {
				os.Exit(125)
			}
		}
		os.Stdout.Write(bytes.Repeat([]byte("Z"), 4<<20))
		if mode == "bulk-raw" {
			fmt.Fprint(os.Stdout, "bulk-finished\r\n")
		} else {
			fmt.Fprintln(os.Stdout, "bulk-finished")
		}
		os.Exit(37)
	}
	if mode == "ignore" {
		signal.Ignore(os.Interrupt, syscall.SIGTERM)
	}
	if mode == "ignore-interrupt" {
		signal.Ignore(os.Interrupt)
	}
	if _, err := term.MakeRaw(int(os.Stdin.Fd())); err != nil {
		os.Exit(125)
	}
	fmt.Fprint(os.Stdout, "child-ready\n")
	if mode == "network" {
		var expected bytes.Buffer
		for index := range 4096 {
			fmt.Fprintf(&expected, "%04d:🐈;", index)
		}
		data := make([]byte, expected.Len())
		if _, err := io.ReadFull(os.Stdin, data); err != nil || !bytes.Equal(data, expected.Bytes()) {
			os.Exit(123)
		}
		fmt.Fprint(os.Stdout, "ordered-input-ok\r\n")
		keys := make([]byte, 2)
		if _, err := io.ReadFull(os.Stdin, keys); err != nil || string(keys) != "az" {
			os.Exit(123)
		}
		fmt.Fprint(os.Stdout, "fresh-keys-ok\r\n")
	}
	if mode == "records" {
		data := make([]byte, 1700)
		if _, err := io.ReadFull(os.Stdin, data); err != nil {
			os.Exit(123)
		}
		os.Stdout.Write(data)
		os.Exit(37)
	}
	if mode == "echo" {
		data := make([]byte, len(leashEcho))
		if _, err := io.ReadFull(os.Stdin, data); err != nil || string(data) != leashEcho {
			os.Exit(123)
		}
		os.Stdout.Write(data)
		os.Exit(37)
	}
	var data [1]byte
	sizeSample := 0
	for {
		if _, err := os.Stdin.Read(data[:]); err != nil {
			os.Exit(122)
		}
		if data[0] == 'x' {
			os.Exit(37)
		}
		if mode == "network" && data[0] == 'B' {
			if _, err := os.Stdout.Write(bytes.Repeat([]byte{'Z'}, 4<<20)); err != nil {
				os.Exit(121)
			}
			fmt.Fprint(os.Stdout, "\r\nbulk-finished\r\n")
			continue
		}
		if (mode == "size" || mode == "crash") && data[0] == 's' {
			cols, rows, err := term.GetSize(int(os.Stdout.Fd()))
			if err != nil {
				os.Exit(123)
			}
			sizeSample++
			fmt.Fprintf(os.Stdout, "size %dx%d sample %d\r\n", cols, rows, sizeSample)
			continue
		}
		if _, err := os.Stdout.Write(data[:]); err != nil {
			os.Exit(121)
		}
	}
}

type lockedLeashCapture struct {
	mu      sync.Mutex
	capture cardCapture
}

func (output *lockedLeashCapture) Write(data []byte) (int, error) {
	output.mu.Lock()
	defer output.mu.Unlock()
	return output.capture.Write(data)
}
func (output *lockedLeashCapture) text() string {
	output.mu.Lock()
	defer output.mu.Unlock()
	return output.capture.String()
}

type leashCLIFixture struct {
	ctx              context.Context
	input            *os.File
	output           *lockedLeashCapture
	transport        *fakeTransport
	signals          chan os.Signal
	done, outputDone chan struct{}
	code             int
	card             invitation.MouseCard
}

func startLeashCLI(t *testing.T, mode string, flags ...string) *leashCLIFixture {
	t.Helper()
	input, writeInput, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	return startLeashCLIWithInput(t, mode, input, writeInput, io.Discard, flags...)
}

func startLeashCLIWithInput(t *testing.T, mode string, input, writeInput *os.File, diagnostics io.Writer, flags ...string) *leashCLIFixture {
	t.Helper()
	return startLeashCLIWithInputAccess(t, mode, input, writeInput, diagnostics, true, flags...)
}

func startLeashCLIWithInputAccess(t *testing.T, mode string, input, writeInput *os.File, diagnostics io.Writer, linkOnly bool, flags ...string) *leashCLIFixture {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	readOutput, output, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	fixture := &leashCLIFixture{ctx: ctx, input: writeInput, output: &lockedLeashCapture{capture: cardCapture{card: make(chan invitation.MouseCard, 1)}}, transport: newFakeTransport(), signals: make(chan os.Signal, 8), done: make(chan struct{}), outputDone: make(chan struct{})}
	binary, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	if mode == "missing" {
		binary = filepath.Join(t.TempDir(), "missing-command")
	}
	if mode == "not-executable" {
		binary = filepath.Join(t.TempDir(), "not-executable")
		if err := os.WriteFile(binary, []byte("not executable"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	args := []string{"leash", "--web-base-url=https://mouse.example/", "--no-qr", "--post-exit-ttl=30ms"}
	if linkOnly {
		args = append(args, "--no-password")
	}
	args = append(args, flags...)
	args = append(args, "--", binary, "-test.run=^TestLeashCLIChild$")
	go func() { defer close(fixture.outputDone); _, _ = io.Copy(fixture.output, readOutput) }()
	configDir := t.TempDir()
	// The fixture executes this test binary under a real PTY. Instrumented
	// binaries must retain Go's coverage destination, otherwise the runtime
	// injects its own diagnostic into the exact-byte terminal stream at exit.
	environment := []string{"TAILMOUSE_LEASH_CLI_CHILD=" + mode}
	if directory := os.Getenv("GOCOVERDIR"); directory != "" {
		environment = append(environment, "GOCOVERDIR="+directory)
	}
	go func() {
		fixture.code = runWithSignals(ctx, input, args, environment, configDir, output, diagnostics, fixture.transport.start, fixture.signals)
		output.Close()
		input.Close()
		close(fixture.done)
	}()
	t.Cleanup(func() {
		cancel()
		writeInput.Close()
		select {
		case <-fixture.done:
		case <-time.After(8 * time.Second):
			t.Error("CLI process owner did not join")
		}
		readOutput.Close()
		<-fixture.outputDone
	})
	select {
	case fixture.card = <-fixture.output.capture.card:
	case <-ctx.Done():
		t.Fatal("Leash invitation was not displayed")
	}
	return fixture
}

func (fixture *leashCLIFixture) awaitText(t *testing.T, value string) {
	t.Helper()
	fixture.output.awaitText(t, fixture.ctx, value)
}

func (output *lockedLeashCapture) awaitText(t *testing.T, ctx context.Context, value string) {
	t.Helper()
	ticker := time.NewTicker(5 * time.Millisecond)
	defer ticker.Stop()
	for !strings.Contains(output.text(), value) {
		select {
		case <-ticker.C:
		case <-ctx.Done():
			t.Fatal("required fixture output missing (content redacted)")
		}
	}
}

func (fixture *leashCLIFixture) result(t *testing.T, want int) {
	t.Helper()
	select {
	case <-fixture.done:
	case <-fixture.ctx.Done():
		t.Fatal("Leash owner did not finish")
	}
	<-fixture.outputDone
	if fixture.code != want {
		t.Fatalf("Leash exit = %d, want %d", fixture.code, want)
	}
	if fixture.transport.closeCalls != 1 {
		t.Fatal("Leash transport closure was not exactly once")
	}
}

func (fixture *leashCLIFixture) connect(t *testing.T) net.Conn {
	t.Helper()
	server, browser := net.Pipe()
	t.Cleanup(func() { browser.Close() })
	browser.SetDeadline(time.Now().Add(8 * time.Second))
	fixture.transport.config.OnConnection(server)
	payload, _ := json.Marshal(map[string]any{"protocol_min": 2, "protocol_max": 2, "session_id": hex.EncodeToString(fixture.card.SessionID[:]), "mode": "leash", "client": map[string]string{"name": "test-browser", "version": "1", "platform": "test", "user_agent": ""}})
	if err := protocol.WriteFrame(fixture.ctx, browser, protocol.PeerBrowser, protocol.StateAwaitClientHello, protocol.Frame{Type: protocol.TypeClientHello, Payload: payload}); err != nil {
		t.Fatal(err)
	}
	clear(payload)
	frame, err := protocol.ReadFrame(fixture.ctx, browser, protocol.PeerBrowser, protocol.StateAwaitServerWelcome)
	if err != nil || frame.Type != protocol.TypeServerWelcome {
		t.Fatal("Leash handshake failed", err)
	}
	return browser
}

func terminalFrame(t *testing.T, fixture *leashCLIFixture, browser net.Conn) protocol.Frame {
	t.Helper()
	for {
		frame, err := protocol.ReadFrame(fixture.ctx, browser, protocol.PeerBrowser, protocol.StateActiveLeash)
		if err != nil {
			t.Fatal("terminal stream failed", err)
		}
		if frame.Type == protocol.TypePing {
			if err := protocol.WriteFrame(fixture.ctx, browser, protocol.PeerBrowser, protocol.StateActiveLeash, protocol.Frame{Type: protocol.TypePong, Payload: frame.Payload}); err != nil {
				t.Fatal(err)
			}
			continue
		}
		return frame
	}
}

func closeLeashBrowser(t *testing.T, fixture *leashCLIFixture, browser net.Conn) {
	t.Helper()
	for {
		frame := terminalFrame(t, fixture, browser)
		if frame.Type != protocol.TypeClose {
			continue
		}
		ack, _ := protocol.CloseFrame("normal")
		if err := protocol.WriteFrame(fixture.ctx, browser, protocol.PeerBrowser, protocol.StateClosing, ack); err != nil {
			t.Fatal(err)
		}
		browser.Close()
		return
	}
}

func TestLeashCLIStartPoliciesAndInvitationOrdering(t *testing.T) {
	for _, policy := range []string{"now", "connect-or-enter", "connect"} {
		t.Run(policy, func(t *testing.T) {
			fixture := startLeashCLI(t, "exit", "--start-on="+policy, "--local-input=false")
			if policy != "now" {
				if strings.Contains(fixture.output.text(), "child-finished") {
					t.Fatal("process started before a trigger")
				}
				if _, err := fixture.input.Write([]byte("\r")); err != nil {
					t.Fatal(err)
				}
			}
			if policy == "connect" {
				time.Sleep(40 * time.Millisecond)
				if strings.Contains(fixture.output.text(), "child-finished") {
					t.Fatal("connect policy started on local Enter")
				}
				browser := fixture.connect(t)
				closeLeashBrowser(t, fixture, browser)
			}
			fixture.result(t, 37)
			text := fixture.output.text()
			if strings.Count(text, "child-finished") != 1 || strings.Index(text, "Open: ") > strings.Index(text, "child-finished") {
				t.Fatal("invitation/start ordering or exactly-once command violated")
			}
		})
	}
}

func TestLeashCLIOnceOverridesHostLivedResultRetention(t *testing.T) {
	fixture := startLeashCLI(t, "exit", "--start-on=now", "--once", "--post-exit-ttl=host", "--local-input=false")
	fixture.result(t, 37)
	if strings.Count(fixture.output.text(), "child-finished") != 1 {
		t.Fatal("--once did not close after publishing the one child result")
	}
}

func TestLeashCLIImmediateAndHostRetainedExitPolicies(t *testing.T) {
	t.Run("literal zero", func(t *testing.T) {
		fixture := startLeashCLI(t, "exit", "--start-on=now", "--post-exit-ttl=0", "--local-input=false")
		fixture.result(t, 37)
		if strings.Count(fixture.output.text(), "child-finished") != 1 {
			t.Fatal("literal zero did not publish exactly one local result")
		}
	})

	t.Run("restart retained result", func(t *testing.T) {
		input, writer, err := os.Pipe()
		if err != nil {
			t.Fatal(err)
		}
		var diagnostics bytes.Buffer
		fixture := startLeashCLIWithInput(t, "exit", input, writer, &diagnostics, "--json", "--start-on=now", "--post-exit-ttl=host", "--local-input=false")
		fixture.awaitText(t, "child-finished")
		browser := fixture.connect(t)
		for {
			frame := terminalFrame(t, fixture, browser)
			if frame.Type != protocol.TypeProcessState {
				continue
			}
			state, err := protocol.DecodeProcessState(frame)
			if err != nil {
				t.Fatal(err)
			}
			if state.State == "exited" && state.Generation == 1 && state.ExitCode != nil && *state.ExitCode == 37 {
				break
			}
		}
		sendLeashControl(t, fixture, browser, "restart", 1)
		for {
			frame := terminalFrame(t, fixture, browser)
			if frame.Type != protocol.TypeProcessState {
				continue
			}
			state, err := protocol.DecodeProcessState(frame)
			if err != nil {
				t.Fatal(err)
			}
			if state.State == "exited" && state.Generation == 2 && state.ExitCode != nil && *state.ExitCode == 37 {
				break
			}
		}
		fixture.signals <- syscall.SIGTERM
		closeLeashBrowser(t, fixture, browser)
		select {
		case <-fixture.done:
		case <-fixture.ctx.Done():
			t.Fatal("Leash owner did not finish")
		}
		<-fixture.outputDone
		if fixture.code != 37 {
			t.Fatalf("retained-result restart exit = %d; safe diagnostics: %s", fixture.code, diagnostics.String())
		}
		if fixture.transport.closeCalls != 1 {
			t.Fatal("Leash transport closure was not exactly once")
		}
		if strings.Count(fixture.output.text(), "child-finished") != 2 {
			t.Fatal("retained-result restart did not create exactly one fresh generation")
		}
	})
}

func TestLeashCLIEnterPreservesTrailingBytesFromTheSameRead(t *testing.T) {
	fixture := startLeashCLI(t, "wait", "--start-on=connect-or-enter")
	if _, err := fixture.input.Write([]byte("\rq-after-enterx")); err != nil {
		t.Fatal(err)
	}
	fixture.result(t, 37)
	if !strings.Contains(fixture.output.text(), "q-after-enter") {
		t.Fatal("input after the start-trigger Enter was discarded")
	}
}

func TestLeashCLIBrowserInputAndDisconnectSurvival(t *testing.T) {
	fixture := startLeashCLI(t, "wait", "--start-on=connect")
	browser := fixture.connect(t)
	waitLeashRunning(t, fixture, browser, 1)
	if err := protocol.WriteFrame(fixture.ctx, browser, protocol.PeerBrowser, protocol.StateActiveLeash, protocol.Frame{Type: protocol.TypeTermInput, Payload: []byte("REMOTE_BYTES")}); err != nil {
		t.Fatal(err)
	}
	fixture.awaitText(t, "REMOTE_BYTES")
	// A disconnect cancels only the stream. Local input remains usable.
	browser.Close()
	time.Sleep(100 * time.Millisecond)
	if _, err := fixture.input.Write([]byte("qx")); err != nil {
		t.Fatal(err)
	}
	fixture.result(t, 37)
	if !strings.Contains(fixture.output.text(), "q") {
		t.Fatal("disconnect killed the child or swallowed local q")
	}
}

func TestLeashCLIWaitingInterruptAndDefaultExpiry(t *testing.T) {
	fixture := startLeashCLI(t, "exit", "--start-on=connect")
	fixture.signals <- os.Interrupt
	fixture.result(t, exitExpired)
	if strings.Contains(fixture.output.text(), "child-finished") {
		t.Fatal("waiting interrupt launched a child")
	}
	running := startLeashCLI(t, "wait", "--start-on=now", "--ttl=1s")
	running.awaitText(t, "child-ready")
	time.Sleep(1100 * time.Millisecond)
	if _, err := running.input.Write([]byte("qx")); err != nil {
		t.Fatal(err)
	}
	running.result(t, 37)
}

func waitLeashRunning(t *testing.T, fixture *leashCLIFixture, browser net.Conn, generation uint32) protocol.ProcessState {
	t.Helper()
	ready, running := false, false
	var latest protocol.ProcessState
	for {
		frame := terminalFrame(t, fixture, browser)
		if frame.Type == protocol.TypeTermOutput && bytes.Contains(frame.Payload, []byte("child-ready")) {
			ready = true
		}
		if frame.Type == protocol.TypeProcessState {
			state, err := protocol.DecodeProcessState(frame)
			if err != nil {
				t.Fatal(err)
			}
			running = state.Generation == generation && state.State == "running"
			latest = state
		}
		if ready && running {
			return latest
		}
	}
}

func sendLeashControl(t *testing.T, fixture *leashCLIFixture, browser net.Conn, action string, generation uint32) {
	t.Helper()
	frame, err := protocol.ProcessControlFrame(protocol.ProcessControl{Generation: generation, Action: action})
	if err == nil {
		err = protocol.WriteFrame(fixture.ctx, browser, protocol.PeerBrowser, protocol.StateActiveLeash, frame)
	}
	if err != nil {
		t.Fatal(err)
	}
}

func TestChildOutcomeIsNotAHostRootFailure(t *testing.T) {
	for _, outcome := range []session.Outcome{session.ModeComplete, session.LocalRevoke, session.TTLExpired, session.GraceExpired} {
		if !childOutcome(outcome) {
			t.Fatalf("child outcome classified as a host error: %s", outcome)
		}
	}
	for _, outcome := range []session.Outcome{session.ProtocolFailure, session.TransportFailure, session.InternalFailure, "unknown"} {
		if childOutcome(outcome) {
			t.Fatalf("root failure classified as a child outcome: %s", outcome)
		}
	}
}
