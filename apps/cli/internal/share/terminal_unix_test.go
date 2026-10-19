//go:build linux || darwin

package share

import (
	"testing"
)

func terminalHost(t *testing.T, readOnly bool, command string) (*Host, string) {
	t.Helper()
	return terminalHostCommand(t, readOnly, []string{"/bin/sh", "-c", command})
}

const echoCommand = `printf 'ready\n'; while IFS= read -r line; do printf 'result:%s\n' "$line"; done`

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
