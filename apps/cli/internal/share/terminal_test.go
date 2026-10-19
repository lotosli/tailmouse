//go:build linux || darwin || windows

package share

import (
	"bufio"
	"fmt"
	"io"
	"net"
	"os"
	"strings"
	"testing"
	"time"

	"golang.org/x/term"
)

func terminalStream(t *testing.T, h *Host, welcome Welcome) (net.Conn, TerminalState) {
	t.Helper()
	s := openHost(t, h, "peer", Hello{Type: "hello", Version: 2, Session: h.ID(), Channel: "terminal", Resource: "cli", Member: welcome.Member, Grant: welcome.Grant})
	var state TerminalState
	objectFrom(t, s, &state)
	if state.Type != "terminal" || state.PID < 1 {
		t.Fatal("missing terminal authority")
	}
	return s, state
}
func readTerminalUntil(t *testing.T, r io.Reader, marker string) {
	t.Helper()
	var output strings.Builder
	for output.Len() < 1<<20 {
		frame, err := ReadFrame(r)
		if err != nil {
			t.Fatal("terminal did not produce expected output", err)
		}
		if frame.Kind == DataFrame {
			output.Write(frame.Data)
		}
		if strings.Contains(output.String(), marker) {
			return
		}
	}
	t.Fatal("terminal exceeded output budget")
}

func waitTerminal(t *testing.T, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for !condition() {
		if time.Now().After(deadline) {
			t.Fatal("terminal state did not settle")
		}
		time.Sleep(time.Millisecond)
	}
}
func TestTerminalSameProcessReconnectAndLocalPriority(t *testing.T) {
	h, token := terminalFixture(t, false, "echo")
	_, w := welcomeHost(t, h, token, "peer")
	s, state := terminalStream(t, h, w)
	if !state.Controller || !state.Running {
		t.Fatal("missing controller")
	}
	readTerminalUntil(t, s, "ready")
	if err := WriteFrame(s, DataFrame, []byte("first\n")); err != nil {
		t.Fatal(err)
	}
	readTerminalUntil(t, s, "result:first")
	if err := h.Terminal().LocalResize(t.Context(), 100, 30); err != nil {
		t.Fatal(err)
	}
	// Local input owns the seat and restores its dimensions.
	if err := h.Terminal().LocalInput(t.Context(), []byte("local\n")); err != nil {
		t.Fatal(err)
	}
	readTerminalUntil(t, s, "result:local")
	if h.CanInput(w.Member) {
		t.Fatal("local input did not reclaim control")
	}
	_ = s.Close()
	waitTerminal(t, func() bool { h.mu.Lock(); defer h.mu.Unlock(); return len(h.members[w.Member].streams) == 0 })
	if !h.GrantMember(1) {
		t.Fatal("explicit regrant failed")
	}
	next, resumed := terminalStream(t, h, w)
	if resumed.PID != state.PID || resumed.Cols != 100 || resumed.Rows != 30 || resumed.HistoryLost {
		t.Fatal("reconnect lost process or local size")
	}
	readTerminalUntil(t, next, "result:local")
	if err := WriteFrame(next, DataFrame, []byte("again\n")); err != nil {
		t.Fatal(err)
	}
	readTerminalUntil(t, next, "result:again")
}
func TestTerminalReadonlyCannotInject(t *testing.T) {
	h, token := terminalFixture(t, true, "echo")
	_, w := welcomeHost(t, h, token, "peer")
	s, state := terminalStream(t, h, w)
	if state.Controller || h.GrantMember(1) || h.GrantControl() {
		t.Fatal("readonly member received input authority")
	}
	readTerminalUntil(t, s, "ready")
	if err := WriteFrame(s, DataFrame, []byte("forbidden\n")); err != nil {
		t.Fatal(err)
	}
	if _, err := ReadFrame(s); err == nil {
		t.Fatal("readonly input stream remained open")
	}
	if !h.Terminal().Running() {
		t.Fatal("readonly denial killed shared process")
	}
}
func TestTerminalExitStateAndClose(t *testing.T) {
	h, token := terminalFixture(t, false, "exit")
	_, w := welcomeHost(t, h, token, "peer")
	s, state := terminalStream(t, h, w)
	for state.Running {
		frame, err := ReadFrame(s)
		if err != nil {
			t.Fatal(err)
		}
		if frame.Kind == JSONFrame && Decode(frame, &state) != nil {
			t.Fatal("invalid terminal state")
		}
	}
	if state.ExitCode != 19 {
		t.Fatalf("exit code %d", state.ExitCode)
	}
	if err := h.Close(); err != nil {
		t.Fatal(err)
	}
	if err := h.Close(); err != nil {
		t.Fatal(err)
	}
	if h.Terminal().Running() {
		t.Fatal("closed terminal reported running")
	}
}

func terminalHostCommand(t *testing.T, readOnly bool, argv []string) (*Host, string) {
	t.Helper()
	o := Options{Command: "dev", Argv: argv, Cwd: t.TempDir(), MaxClients: 2, TTL: time.Minute, Approval: "auto", ReadOnly: readOnly}
	h, token, err := NewHost(t.Context(), o, os.Environ())
	if err != nil {
		t.Fatal(err)
	}
	h.Ready()
	t.Cleanup(func() {
		if err := h.Close(); err != nil {
			t.Error(err)
		}
	})
	return h, token
}

// The same native child runs under Unix PTY and Windows ConPTY. The last
// argument is synthetic fixture data; no user command or invitation is stored.
func TestResourceTerminalChild(t *testing.T) {
	if len(os.Args) < 2 || !strings.HasPrefix(os.Args[len(os.Args)-1], "resource-child:") {
		return
	}
	mode := strings.TrimPrefix(os.Args[len(os.Args)-1], "resource-child:")
	watchdog := time.AfterFunc(10*time.Second, func() { os.Exit(124) })
	defer watchdog.Stop()
	if _, err := term.MakeRaw(int(os.Stdin.Fd())); err != nil {
		os.Exit(125)
	}
	if mode == "exit" {
		fmt.Fprint(os.Stdout, "finished\r\n")
		os.Exit(19)
	}
	fmt.Fprint(os.Stdout, "ready\r\n")
	input := bufio.NewReader(os.Stdin)
	for {
		line, err := input.ReadString('\n')
		if err != nil {
			os.Exit(125)
		}
		fmt.Fprintf(os.Stdout, "result:%s\r\n", strings.TrimRight(line, "\r\n"))
	}
}

func terminalFixture(t *testing.T, readOnly bool, mode string) (*Host, string) {
	t.Helper()
	binary, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	return terminalHostCommand(t, readOnly, []string{binary, "-test.run=^TestResourceTerminalChild$", "--", "resource-child:" + mode})
}
