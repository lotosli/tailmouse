//go:build linux || darwin

package share

import (
	"io"
	"net"
	"os"
	"strings"
	"testing"
	"time"
)

func terminalHost(t *testing.T, readOnly bool, command string) (*Host, string) {
	t.Helper()
	o := Options{Command: "dev", Argv: []string{"/bin/sh", "-c", command}, Cwd: t.TempDir(), MaxClients: 2, TTL: time.Minute, Approval: "auto", ReadOnly: readOnly}
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

const echoCommand = `printf 'ready\n'; while IFS= read -r line; do printf 'result:%s\n' "$line"; done`

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
	h, token := terminalHost(t, false, echoCommand)
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
	h, token := terminalHost(t, true, echoCommand)
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
func TestTerminalBoundedHistoryRequestsRedrawWithoutRestart(t *testing.T) {
	h, token := terminalHost(t, false, "head -c 4194400 /dev/zero; "+echoCommand)
	waitTerminal(t, func() bool { h.Terminal().mu.Lock(); defer h.Terminal().mu.Unlock(); return h.Terminal().truncated })
	_, w := welcomeHost(t, h, token, "peer")
	s, state := terminalStream(t, h, w)
	if !state.HistoryLost || state.Recovery != "redraw" {
		t.Fatal("overflow was silently replayed")
	}
	written := make(chan error, 1)
	go func() { written <- WriteFrame(s, DataFrame, []byte("after-redraw\n")) }()
	readTerminalUntil(t, s, "result:after-redraw")
	if err := <-written; err != nil {
		t.Fatal(err)
	}
	if h.Terminal().process.PID() != state.PID {
		t.Fatal("redraw restarted child")
	}
}
func TestTerminalExitStateAndClose(t *testing.T) {
	h, token := terminalHost(t, false, "printf 'finished\\n'; exit 19")
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
