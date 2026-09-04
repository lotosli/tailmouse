//go:build darwin || linux

package main

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/signal"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	nativepty "github.com/creack/pty"
	"golang.org/x/sys/unix"
	"golang.org/x/term"
	"tailmouse/apps/cli/internal/config"
	"tailmouse/apps/cli/internal/invitation"
	"tailmouse/apps/cli/internal/protocol"
	"tailmouse/apps/cli/internal/session"
	tailcattransport "tailmouse/apps/cli/internal/transport/tailcat"
)

const leashEcho = "q\x03\x1b[A🐈"

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
		deadline = 90 * time.Second
	}
	time.AfterFunc(deadline, func() { os.Exit(124) })
	if mode == "exit" {
		fmt.Fprintln(os.Stdout, "child-finished")
		os.Exit(37)
	}
	if mode == "bulk" || mode == "bulk-raw" {
		if mode == "bulk-raw" {
			if _, err := term.MakeRaw(0); err != nil {
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
	if _, err := term.MakeRaw(0); err != nil {
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
			cols, rows, err := term.GetSize(0)
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
	args := append([]string{"leash", "--no-qr", "--post-exit-ttl=30ms"}, flags...)
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
	payload, _ := json.Marshal(map[string]any{"protocol_min": 1, "protocol_max": 1, "session_id": hex.EncodeToString(fixture.card.SessionID[:]), "mode": "leash", "client": map[string]string{"name": "test-browser", "version": "1", "platform": "test", "user_agent": ""}})
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

func TestLeashCLILocalBytesAndFirstControlCReachOneChild(t *testing.T) {
	fixture := startLeashCLI(t, "echo", "--start-on=now")
	fixture.awaitText(t, "child-ready")
	if _, err := fixture.input.Write([]byte(leashEcho)); err != nil {
		t.Fatal(err)
	}
	fixture.result(t, 37)
	if !bytes.Contains([]byte(fixture.output.text()), []byte(leashEcho)) {
		t.Fatal("raw q/control/ANSI/UTF-8 input changed")
	}
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
	fixture := startLeashCLI(t, "wait", "--start-on=connect", "--reconnect-grace=50ms")
	browser := fixture.connect(t)
	ready, running := false, false
	for {
		frame := terminalFrame(t, fixture, browser)
		if frame.Type == protocol.TypeTermOutput && bytes.Contains(frame.Payload, []byte("child-ready")) {
			ready = true
		}
		if frame.Type == protocol.TypeProcessState {
			state, _ := protocol.DecodeProcessState(frame)
			running = state.State == "running"
		}
		if ready && running {
			break
		}
	}
	if err := protocol.WriteFrame(fixture.ctx, browser, protocol.PeerBrowser, protocol.StateActiveLeash, protocol.Frame{Type: protocol.TypeTermInput, Payload: []byte("REMOTE_BYTES")}); err != nil {
		t.Fatal(err)
	}
	fixture.awaitText(t, "REMOTE_BYTES")
	// A disconnect cancels only the stream. Local input remains usable after grace.
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

func TestLeashCLIChildExitsDuringGraceAndReconnectRetainsResult(t *testing.T) {
	input, writer, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	diagnostics := &lockedLeashCapture{}
	fixture := startLeashCLIWithInput(t, "wait", input, writer, diagnostics, "--json", "--start-on=connect", "--post-exit-ttl=1s")
	browser := fixture.connect(t)
	original := waitLeashRunning(t, fixture, browser, 1)
	if original.PID == nil {
		t.Fatal("running process omitted its PID")
	}
	browser.Close()
	// The real host reports this only after releasing the disconnected lease.
	diagnostics.awaitText(t, fixture.ctx, `"event":"browser_disconnected"`)
	if _, err := fixture.input.Write([]byte("retained-tail🐈x")); err != nil {
		t.Fatal(err)
	}
	fixture.awaitText(t, "retained-tail🐈")
	ticker := time.NewTicker(5 * time.Millisecond)
	defer ticker.Stop()
	for {
		err := syscall.Kill(int(*original.PID), 0)
		if errors.Is(err, syscall.ESRCH) {
			break
		}
		if err != nil {
			t.Fatal("cannot observe owned child exit")
		}
		select {
		case <-ticker.C:
		case <-fixture.ctx.Done():
			t.Fatal("disconnected child did not exit")
		}
	}
	browser = fixture.connect(t)
	reset, exited := false, false
	var retained bytes.Buffer
	for {
		frame := terminalFrame(t, fixture, browser)
		switch frame.Type {
		case protocol.TypeTermReset:
			if reset {
				t.Fatal("reconnect reset the terminal more than once")
			}
			reset = true
		case protocol.TypeTermOutput:
			if !reset {
				t.Fatal("retained output preceded terminal reset")
			}
			retained.Write(frame.Payload)
		case protocol.TypeProcessState:
			state, err := protocol.DecodeProcessState(frame)
			if err != nil || state.State != "exited" || state.Generation != 1 || state.PID == nil || *state.PID != *original.PID || state.ExitCode == nil || *state.ExitCode != 37 {
				t.Fatal("reconnect lost the child result or silently restarted")
			}
			exited = true
		case protocol.TypeClose:
			ack, _ := protocol.CloseFrame("normal")
			if err := protocol.WriteFrame(fixture.ctx, browser, protocol.PeerBrowser, protocol.StateClosing, ack); err != nil {
				t.Fatal(err)
			}
			browser.Close()
			fixture.result(t, 37)
			if !reset || !exited || retained.String() != "child-ready\nretained-tail🐈" {
				t.Fatal("retained exit, reset or exact scrollback was not delivered")
			}
			return
		}
	}
}

func TestLeashCLITitleSurvivesRestartAndExit(t *testing.T) {
	binary, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	for _, title := range []string{"", "--", "<terminal> 🐈", strings.Repeat("<", 256)} {
		t.Run(title, func(t *testing.T) {
			fixture := startLeashCLI(t, "wait", "--start-on=connect", "--post-exit-ttl=200ms", "--title", title)
			browser := fixture.connect(t)
			first := waitLeashRunning(t, fixture, browser, 1)
			want := title
			if want == "" {
				want = filepath.Base(binary)
			}
			if first.Title != want {
				t.Fatal("original command title was not delivered")
			}
			sendLeashControl(t, fixture, browser, "restart", 1)
			second := waitLeashRunning(t, fixture, browser, 2)
			if second.Title != want || first.PID == nil || second.PID == nil || *first.PID == *second.PID {
				t.Fatal("restart changed the title or did not replace the process")
			}
			if _, err := fixture.input.Write([]byte("x")); err != nil {
				t.Fatal(err)
			}
			exited := false
			for {
				frame := terminalFrame(t, fixture, browser)
				if frame.Type == protocol.TypeProcessState {
					state, err := protocol.DecodeProcessState(frame)
					if err != nil || state.Title != want {
						t.Fatal("process lifecycle lost its immutable title")
					}
					exited = state.State == "exited" && state.ExitCode != nil && *state.ExitCode == 37
				}
				if frame.Type == protocol.TypeClose {
					ack, _ := protocol.CloseFrame("normal")
					if err := protocol.WriteFrame(fixture.ctx, browser, protocol.PeerBrowser, protocol.StateClosing, ack); err != nil {
						t.Fatal(err)
					}
					browser.Close()
					break
				}
			}
			fixture.result(t, 37)
			if !exited {
				t.Fatal("final titled exit state was not delivered")
			}
		})
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

func TestLeashCLIBrowserControlsPreserveExitAndSnapshot(t *testing.T) {
	for _, action := range []string{"interrupt", "terminate", "restart"} {
		t.Run(action, func(t *testing.T) {
			fixture := startLeashCLI(t, "wait", "--start-on=connect")
			browser := fixture.connect(t)
			waitLeashRunning(t, fixture, browser, 1)
			sendLeashControl(t, fixture, browser, action, 1)
			want := 130
			if action == "terminate" {
				want = 143
			}
			if action == "restart" {
				waitLeashRunning(t, fixture, browser, 2)
				fixture.awaitText(t, "TailMouse restarted process · generation 2")
				// The new reset must drain the old stream before input is accepted.
				if err := protocol.WriteFrame(fixture.ctx, browser, protocol.PeerBrowser, protocol.StateActiveLeash, protocol.Frame{Type: protocol.TypeTermInput, Payload: []byte("OLD_INPUT")}); err != nil {
					t.Fatal(err)
				}
				for {
					frame := terminalFrame(t, fixture, browser)
					if frame.Type == protocol.TypeError {
						if code, _ := protocol.ErrorCodeOf(protocol.DecodeError(frame)); code != protocol.CodeBackpressure {
							t.Fatal("restart did not reject old input")
						}
						break
					}
				}
				for {
					frame, err := protocol.ReadFrame(fixture.ctx, browser, protocol.PeerBrowser, protocol.StateActiveLeash)
					if err != nil {
						t.Fatal(err)
					}
					if frame.Type == protocol.TypePing {
						if err := protocol.WriteFrame(fixture.ctx, browser, protocol.PeerBrowser, protocol.StateActiveLeash, protocol.Frame{Type: protocol.TypePong, Payload: frame.Payload}); err != nil {
							t.Fatal(err)
						}
						break
					}
				}
				if err := protocol.WriteFrame(fixture.ctx, browser, protocol.PeerBrowser, protocol.StateActiveLeash, protocol.Frame{Type: protocol.TypeTermInput, Payload: []byte("x")}); err != nil {
					t.Fatal(err)
				}
				want = 37
			}
			closeLeashBrowser(t, fixture, browser)
			fixture.result(t, want)
			if strings.Contains(fixture.output.text(), "OLD_INPUT") {
				t.Fatal("old generation input reached the new process")
			}
		})
	}
}

func TestLeashCLIBrowserInterruptKeepsAcknowledgedStateForSurvivingChild(t *testing.T) {
	fixture := startLeashCLI(t, "ignore-interrupt", "--start-on=connect")
	browser := fixture.connect(t)
	waitLeashRunning(t, fixture, browser, 1)
	sendLeashControl(t, fixture, browser, "interrupt", 1)
	acknowledged, runningAfterAck, heartbeats := false, false, 0
	// Preserve the acknowledgment, then require PRD 9.11's return to running.
	// Two ordinary heartbeats bound observation without changing product time.
	for heartbeats < 2 && !runningAfterAck {
		frame, err := protocol.ReadFrame(fixture.ctx, browser, protocol.PeerBrowser, protocol.StateActiveLeash)
		if err != nil {
			t.Fatal(err)
		}
		if frame.Type == protocol.TypeProcessState {
			state, err := protocol.DecodeProcessState(frame)
			if err != nil {
				t.Fatal(err)
			}
			if state.State == "interrupting" {
				acknowledged = true
			}
			if state.State == "running" && acknowledged {
				runningAfterAck = true
			}
		}
		if frame.Type == protocol.TypePing {
			if err := protocol.WriteFrame(fixture.ctx, browser, protocol.PeerBrowser, protocol.StateActiveLeash, protocol.Frame{Type: protocol.TypePong, Payload: frame.Payload}); err != nil {
				t.Fatal(err)
			}
			heartbeats++
		}
	}
	if !acknowledged || !runningAfterAck {
		t.Fatalf("surviving child did not acknowledge then resume running: acknowledgment=%t running=%t", acknowledged, runningAfterAck)
	}
	if err := protocol.WriteFrame(fixture.ctx, browser, protocol.PeerBrowser, protocol.StateActiveLeash, protocol.Frame{Type: protocol.TypeTermInput, Payload: []byte("qx")}); err != nil {
		t.Fatal(err)
	}
	closeLeashBrowser(t, fixture, browser)
	fixture.result(t, 37)
	if !strings.Contains(fixture.output.text(), "q") {
		t.Fatal("input was not usable after interrupt")
	}
}

func TestLeashCLIResizeAndConcurrentInput(t *testing.T) {
	t.Run("resize", func(t *testing.T) {
		fixture := startLeashCLI(t, "size", "--start-on=connect")
		browser := fixture.connect(t)
		waitLeashRunning(t, fixture, browser, 1)
		for _, payload := range [][]byte{{0, 90, 0, 30}, {0, 120, 0, 41}} {
			if err := protocol.WriteFrame(fixture.ctx, browser, protocol.PeerBrowser, protocol.StateActiveLeash, protocol.Frame{Type: protocol.TypeTermResize, Payload: payload}); err != nil {
				t.Fatal(err)
			}
		}
		time.Sleep(80 * time.Millisecond)
		fixture.input.Write([]byte("s"))
		fixture.awaitText(t, "size 120x41")
		fixture.signals <- syscall.SIGWINCH // Redirected console has no dimensions to submit.
		fixture.input.Write([]byte("x"))
		closeLeashBrowser(t, fixture, browser)
		fixture.result(t, 37)
	})
	t.Run("atomic chunks", func(t *testing.T) {
		fixture := startLeashCLI(t, "records", "--start-on=connect")
		browser := fixture.connect(t)
		waitLeashRunning(t, fixture, browser, 1)
		var local, remote bytes.Buffer
		for index := 0; index < 50; index++ {
			fmt.Fprintf(&local, "LOCAL-%010d\n", index)
			fmt.Fprintf(&remote, "PHONE-%010d\n", index)
		}
		done := make(chan error, 2)
		go func() { _, err := fixture.input.Write(local.Bytes()); done <- err }()
		go func() {
			done <- protocol.WriteFrame(fixture.ctx, browser, protocol.PeerBrowser, protocol.StateActiveLeash, protocol.Frame{Type: protocol.TypeTermInput, Payload: remote.Bytes()})
		}()
		for range 2 {
			if err := <-done; err != nil {
				t.Fatal(err)
			}
		}
		closeLeashBrowser(t, fixture, browser)
		fixture.result(t, 37)
		text := fixture.output.text()
		if !strings.Contains(text, local.String()+remote.String()) && !strings.Contains(text, remote.String()+local.String()) {
			t.Fatal("accepted local/browser byte chunks interleaved")
		}
	})
}

func TestLeashCLILocalSIGWINCHAndBrowserResizeReachTheSamePTY(t *testing.T) {
	master, slave, err := nativepty.Open()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { master.Close(); slave.Close() })
	fixture := startLeashCLIWithInput(t, "size", slave, master, io.Discard, "--start-on=connect")
	browser := fixture.connect(t)
	waitLeashRunning(t, fixture, browser, 1)
	for index, size := range []struct {
		local              bool
		cols, rows         int
		wantCols, wantRows int
	}{
		{false, 100, 33, 100, 33},
		{true, 120, 45, 120, 45},
		{true, 19, 4, 120, 45},
		{true, 20, 5, 20, 5},
		{false, 500, 200, 500, 200},
	} {
		if size.local {
			if err := nativepty.Setsize(master, &nativepty.Winsize{Cols: uint16(size.cols), Rows: uint16(size.rows)}); err != nil {
				t.Fatal(err)
			}
			fixture.signals <- syscall.SIGWINCH
		} else {
			payload := binary.BigEndian.AppendUint16(nil, uint16(size.cols))
			payload = binary.BigEndian.AppendUint16(payload, uint16(size.rows))
			frame := protocol.Frame{Type: protocol.TypeTermResize, Payload: payload}
			if err := protocol.WriteFrame(fixture.ctx, browser, protocol.PeerBrowser, protocol.StateActiveLeash, frame); err != nil {
				t.Fatal(err)
			}
		}
		// The real CLI coalesces sizes for 50 ms; sample the child's terminal
		// after that boundary, including an invalid local size with no effect.
		time.Sleep(80 * time.Millisecond)
		if _, err := fixture.input.Write([]byte("s")); err != nil {
			t.Fatal(err)
		}
		fixture.awaitText(t, fmt.Sprintf("size %dx%d sample %d", size.wantCols, size.wantRows, index+1))
	}
	if _, err := fixture.input.Write([]byte("x")); err != nil {
		t.Fatal(err)
	}
	closeLeashBrowser(t, fixture, browser)
	fixture.result(t, 37)
}

func TestLeashCLICleanupFailureDoesNotMasqueradeAsChildExit(t *testing.T) {
	fixture := startLeashCLI(t, "wait", "--start-on=connect")
	fixture.transport.mu.Lock()
	fixture.transport.closeErr = errors.New("synthetic private transport detail")
	fixture.transport.mu.Unlock()
	browser := fixture.connect(t)
	waitLeashRunning(t, fixture, browser, 1)
	if _, err := fixture.input.Write([]byte("x")); err != nil {
		t.Fatal(err)
	}
	closeLeashBrowser(t, fixture, browser)
	fixture.result(t, exitTransport)
}

func TestLeashCLIBoundedDrainPreservesChildExit(t *testing.T) {
	for _, test := range []struct {
		name string
		err  error
		code int
	}{
		{"bounded drain", errors.Join(tailcattransport.ErrDrain, context.DeadlineExceeded), 37},
		{"unexpected drain failure", tailcattransport.ErrDrain, exitTransport},
		{"drain and close failure", errors.Join(tailcattransport.ErrDrain, context.DeadlineExceeded, tailcattransport.ErrClose), exitTransport},
		{"unclassified deadline", context.DeadlineExceeded, exitTransport},
	} {
		t.Run(test.name, func(t *testing.T) {
			input, writer, err := os.Pipe()
			if err != nil {
				t.Fatal(err)
			}
			var diagnostic bytes.Buffer
			fixture := startLeashCLIWithInput(t, "wait", input, writer, &diagnostic, "--start-on=connect", "--json")
			fixture.transport.mu.Lock()
			fixture.transport.closeErr = test.err
			fixture.transport.mu.Unlock()
			browser := fixture.connect(t)
			waitLeashRunning(t, fixture, browser, 1)
			if _, err := fixture.input.Write([]byte("x")); err != nil {
				t.Fatal(err)
			}
			closeLeashBrowser(t, fixture, browser)
			fixture.result(t, test.code)
			warned := strings.Contains(diagnostic.String(), `"reason":"transport_drain_timeout"`)
			if warned != (test.code == 37) {
				t.Fatal("bounded drain warning was omitted or disguised a close failure")
			}
		})
	}
}

func TestLeashCLIRestoresLocalTerminalAfterExitErrorAndPanic(t *testing.T) {
	for _, fault := range []string{"none", "error", "panic"} {
		t.Run(fault, func(t *testing.T) {
			master, _, fd, original, flags := terminalPair(t)
			duplicate, err := unix.Dup(fd)
			if err != nil {
				t.Fatal(err)
			}
			input := os.NewFile(uintptr(duplicate), "owned-test-terminal")
			diagnostics := &interruptDiagnosticFault{fault: fault}
			fixture := startLeashCLIWithInput(t, "ignore", input, master, diagnostics, "--json", "--start-on=connect")
			browser := fixture.connect(t)
			state := waitLeashRunning(t, fixture, browser, 1)
			if raw, err := term.GetState(fd); err != nil || reflect.DeepEqual(raw, original) {
				t.Fatal("CLI did not enter local raw mode before the fault")
			}
			want := 37
			if fault == "none" {
				if _, err := master.Write([]byte("q🐈x")); err != nil {
					t.Fatal(err)
				}
			} else {
				fixture.signals <- os.Interrupt
				fixture.signals <- os.Interrupt
				want = exitInternal
			}
			closeLeashBrowser(t, fixture, browser)
			fixture.result(t, want)
			assertTerminalRestored(t, fd, original, flags)
			if state.PID == nil || !errors.Is(syscall.Kill(int(*state.PID), 0), syscall.ESRCH) {
				t.Fatal("CLI cleanup left its owned child running")
			}
			if (fault != "none") != (diagnostics.failures == 1) {
				t.Fatal("test did not exercise exactly the requested failure")
			}
		})
	}
}

type interruptDiagnosticFault struct {
	fault    string
	failures int
}

func (writer *interruptDiagnosticFault) Write(data []byte) (int, error) {
	if bytes.Contains(data, []byte("Second interrupt confirmed:")) {
		writer.failures++
		if writer.fault == "panic" {
			panic("synthetic diagnostic panic")
		}
		return 0, io.ErrClosedPipe
	}
	return len(data), nil
}

func TestLeashCLIFinalDiagnosticFailurePreservesEarlierRoot(t *testing.T) {
	for _, transportFailure := range []bool{false, true} {
		t.Run(fmt.Sprintf("transport-failure-%t", transportFailure), func(t *testing.T) {
			input, writer, err := os.Pipe()
			if err != nil {
				t.Fatal(err)
			}
			diagnostic := &failFinalLeashDiagnostic{}
			fixture := startLeashCLIWithInput(t, "wait", input, writer, diagnostic, "--start-on=connect", "--json")
			want := exitInternal
			if transportFailure {
				fixture.transport.mu.Lock()
				fixture.transport.closeErr = errors.New("synthetic private transport detail")
				fixture.transport.mu.Unlock()
				want = exitTransport
			}
			browser := fixture.connect(t)
			waitLeashRunning(t, fixture, browser, 1)
			if _, err := fixture.input.Write([]byte("x")); err != nil {
				t.Fatal(err)
			}
			closeLeashBrowser(t, fixture, browser)
			fixture.result(t, want)
			if diagnostic.failures != 1 {
				t.Fatal("final diagnostic failure was not exercised exactly once")
			}
		})
	}
}

type failFinalLeashDiagnostic struct{ failures int }

func (writer *failFinalLeashDiagnostic) Write(data []byte) (int, error) {
	if bytes.Contains(data, []byte(`"event":"terminal_failure"`)) {
		writer.failures++
		return 0, errors.New("synthetic private diagnostic detail")
	}
	return len(data), nil
}

func TestLeashCleanupCannotReplaceProtocolRootFailure(t *testing.T) {
	fixture := startLeashCLI(t, "wait", "--start-on=connect")
	fixture.transport.mu.Lock()
	fixture.transport.closeErr = errors.New("synthetic private cleanup detail")
	fixture.transport.mu.Unlock()
	browser := fixture.connect(t)
	state := waitLeashRunning(t, fixture, browser, 1)
	if state.PID == nil {
		t.Fatal("owned child PID is missing")
	}
	childGoneBeforeTransport := false
	fixture.transport.mu.Lock()
	fixture.transport.onClose = func() {
		childGoneBeforeTransport = errors.Is(syscall.Kill(int(*state.PID), 0), syscall.ESRCH)
	}
	fixture.transport.mu.Unlock()
	if _, err := browser.Write([]byte{0, 0, 0, 1}); err != nil {
		t.Fatal(err)
	}
	frame := terminalFrame(t, fixture, browser)
	if frame.Type != protocol.TypeError {
		t.Fatal("malformed peer was not rejected")
	}
	browser.Close()
	fixture.result(t, exitProtocol)
	if !childGoneBeforeTransport {
		t.Fatal("protocol failure closed transport before mode cleanup")
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

func TestLeashCLIExplicitKillPoliciesAndStartupCodes(t *testing.T) {
	for _, test := range []struct {
		name, mode string
		flags      []string
		code       int
	}{
		{"missing executable", "missing", nil, 127},
		{"not executable", "not-executable", nil, 126},
		{"missing cwd", "exit", []string{"--cwd=" + filepath.Join(t.TempDir(), "missing")}, 7},
		{"expiry kills only when requested", "wait", []string{"--ttl=1s", "--kill-on-expire"}, 143},
	} {
		t.Run(test.name, func(t *testing.T) {
			fixture := startLeashCLI(t, test.mode, append([]string{"--start-on=now"}, test.flags...)...)
			fixture.result(t, test.code)
		})
	}
	t.Run("disconnect kill", func(t *testing.T) {
		fixture := startLeashCLI(t, "wait", "--start-on=connect", "--kill-on-disconnect")
		browser := fixture.connect(t)
		waitLeashRunning(t, fixture, browser, 1)
		browser.Close()
		fixture.result(t, 143)
	})
	t.Run("second interrupt", func(t *testing.T) {
		fixture := startLeashCLI(t, "ignore", "--start-on=now")
		fixture.awaitText(t, "child-ready")
		fixture.signals <- os.Interrupt
		fixture.signals <- os.Interrupt
		fixture.result(t, 137)
	})
	t.Run("shutdown signal", func(t *testing.T) {
		fixture := startLeashCLI(t, "wait", "--start-on=now")
		fixture.awaitText(t, "child-ready")
		fixture.signals <- syscall.SIGTERM
		fixture.result(t, 143)
	})
	if code := run(context.Background(), nil, []string{"leash", "--no-qr", "--start-on=now", "--", "unused"}, nil, t.TempDir(), io.Discard, io.Discard, newFakeTransport().start); code != config.ExitPTY {
		t.Fatal("non-file console was not rejected")
	}
}

func TestLeashCLISlowBrowserDoesNotBlockChildAndCountsExactDrops(t *testing.T) {
	for _, mode := range []string{"bulk", "bulk-raw"} {
		t.Run(mode, func(t *testing.T) { testLeashSlowBrowser(t, mode) })
	}
}

func testLeashSlowBrowser(t *testing.T, mode string) {
	t.Helper()
	input, writer, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	var diagnostics bytes.Buffer
	fixture := startLeashCLIWithInput(t, mode, input, writer, &diagnostics,
		"--json", "--verbose", "--start-on=connect", "--post-exit-ttl=2s", "--scrollback-bytes=65536")
	browser := fixture.connect(t)
	// Intentionally read no terminal frame until all 4 MiB reached local stdout.
	started := time.Now()
	fixture.awaitText(t, "bulk-finished")
	t.Logf("4 MiB reached local output with the browser fully blocked in %s", time.Since(started))
	var delivered, dropped uint64
	for {
		frame := terminalFrame(t, fixture, browser)
		switch frame.Type {
		case protocol.TypeTermReset:
			delivered, dropped = 0, 0
		case protocol.TypeTermOutput:
			delivered += uint64(len(frame.Payload))
		case protocol.TypeOutputDropped:
			value, err := protocol.DecodeOutputDropped(frame)
			if err != nil {
				t.Fatal(err)
			}
			dropped = value.Bytes
		case protocol.TypeClose:
			ack, _ := protocol.CloseFrame("normal")
			if err := protocol.WriteFrame(fixture.ctx, browser, protocol.PeerBrowser, protocol.StateClosing, ack); err != nil {
				t.Fatal(err)
			}
			browser.Close()
			fixture.result(t, 37)
			want := uint64(4<<20) + uint64(len("bulk-finished\r\n"))
			if dropped == 0 || delivered+dropped != want {
				t.Fatalf("retained output %d + dropped %d != %d", delivered, dropped, want)
			}
			var logged uint64
			for _, event := range decodeDiagnostics(t, diagnostics.String()) {
				if event.Event != "output_dropped" {
					continue
				}
				if event.Generation != 1 || event.DroppedBytes == nil || *event.DroppedBytes < logged || event.Metrics == nil ||
					event.Metrics.ProcessGeneration != 1 || event.Metrics.OutputDroppedBytes != *event.DroppedBytes || event.Metrics.OutputRingUsed != 65536 {
					t.Fatal("drop diagnostic lost its cumulative count, bounded history or generation")
				}
				logged = *event.DroppedBytes
			}
			if logged != dropped {
				t.Fatalf("diagnostic drop count %d differs from wire count %d", logged, dropped)
			}
			assertSafeDiagnostics(t, diagnostics.String(), "bulk-finished", strings.Repeat("Z", 64))
			return
		}
	}
}

func TestLeashCLIReadonlyAndDisabledActionsRejectWithoutClosingChild(t *testing.T) {
	for _, test := range []struct {
		flag, action string
		code         protocol.ErrorCode
	}{
		{"--readonly", "input", protocol.CodeReadonly},
		{"--no-restart", "restart", protocol.CodeRestartDisabled},
		{"--no-terminate", "terminate", protocol.CodeTerminateDisabled},
	} {
		t.Run(test.flag, func(t *testing.T) {
			fixture := startLeashCLI(t, "wait", "--start-on=connect", test.flag)
			browser := fixture.connect(t)
			waitLeashRunning(t, fixture, browser, 1)
			if test.action == "input" {
				if err := protocol.WriteFrame(fixture.ctx, browser, protocol.PeerBrowser, protocol.StateActiveLeash, protocol.Frame{Type: protocol.TypeTermInput, Payload: []byte("DENIED_INPUT")}); err != nil {
					t.Fatal(err)
				}
			} else {
				sendLeashControl(t, fixture, browser, test.action, 1)
			}
			for {
				frame := terminalFrame(t, fixture, browser)
				if frame.Type != protocol.TypeError {
					continue
				}
				if code, _ := protocol.ErrorCodeOf(protocol.DecodeError(frame)); code != test.code {
					t.Fatalf("denied action = %s", code)
				}
				break
			}
			fixture.input.Write([]byte("x"))
			closeLeashBrowser(t, fixture, browser)
			fixture.result(t, 37)
			if strings.Contains(fixture.output.text(), "DENIED_INPUT") || strings.Contains(fixture.output.text(), "restarted process") {
				t.Fatal("denied action reached the child")
			}
		})
	}
}
