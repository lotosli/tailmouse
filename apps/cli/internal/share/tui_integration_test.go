//go:build tailcatintegration && (linux || darwin)

package share

import (
	"net"
	"os/exec"
	"strings"
	"sync"
	"testing"
	"time"
)

// These are actual child TUIs under the owned PTY. The output overflow forces
// redraw recovery instead of permitting a passing historical-screen replay.
// htop's resize handler may emit only screen deltas. Exercise the explicit
// Ctrl+L action offered by the recovery notice and existing terminal toolbar.
func TestResourceTUIRedraw(t *testing.T) {
	for _, fixture := range []struct{ name, binary, command, marker, redraw, quit string }{
		{"vim", "vim.tiny", "printf 'resource-vim-marker\\n' > screen.txt; head -c 4194400 /dev/zero; exec env TERM=xterm-256color vim.tiny -u NONE -i NONE -n -N screen.txt", "resource-vim-marker", "", ":q!\r"},
		{"htop", "htop", "head -c 4194400 /dev/zero; exec env TERM=xterm-256color HTOPRC=\"$PWD/htoprc\" htop --readonly --pid=$$", "Tasks:", "\x0c", "q"},
	} {
		t.Run(fixture.name, func(t *testing.T) {
			if _, err := exec.LookPath(fixture.binary); err != nil {
				t.Skip("named TUI binary unavailable; platform acceptance remains pending")
			}
			h, token := terminalHost(t, false, fixture.command)
			output := &tuiOutput{marker: fixture.marker, ready: make(chan struct{})}
			h.Terminal().SetLocal(output)
			select {
			case <-output.ready:
			case <-time.After(5 * time.Second):
				t.Fatal("named TUI did not render its initial screen")
			}
			_, w := welcomeHost(t, h, token, "peer")
			stream, first := terminalStream(t, h, w)
			if !first.HistoryLost || first.Recovery != "redraw" {
				t.Fatal("TUI overflow was not reported as requiring redraw")
			}
			readTUIRedraw(t, stream, fixture.marker, fixture.redraw)
			_ = stream.Close()
			deadline := time.Now().Add(time.Second)
			for {
				h.mu.Lock()
				active := len(h.members[w.Member].streams)
				h.mu.Unlock()
				if active == 0 {
					break
				}
				if time.Now().After(deadline) {
					t.Fatal("previous terminal did not release")
				}
				time.Sleep(time.Millisecond)
			}
			next, redraw := terminalStream(t, h, w)
			if first.PID != redraw.PID || !redraw.HistoryLost || redraw.Recovery != "redraw" {
				t.Fatal("TUI did not retain process and request redraw")
			}
			readTUIRedraw(t, next, fixture.marker, fixture.redraw)
			if err := WriteFrame(next, DataFrame, []byte(fixture.quit)); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func readTUIRedraw(t *testing.T, stream net.Conn, marker, shortcut string) {
	t.Helper()
	if shortcut == "" {
		readTerminalUntil(t, stream, marker)
		return
	}
	// net.Pipe is unbuffered: drain output while the explicit user action is
	// sent, as the browser's independent reader/writer do on a real stream.
	written := make(chan error, 1)
	go func() { written <- WriteFrame(stream, DataFrame, []byte(shortcut)) }()
	readTerminalUntil(t, stream, marker)
	if err := <-written; err != nil {
		t.Fatal(err)
	}
}

// Keep only enough recent output to identify the synthetic screen marker.
type tuiOutput struct {
	marker, tail string
	ready        chan struct{}
	once         sync.Once
}

func (w *tuiOutput) Write(b []byte) (int, error) {
	w.tail += string(b)
	if len(w.tail) > 65536 {
		w.tail = w.tail[len(w.tail)-65536:]
	}
	if strings.Contains(w.tail, w.marker) {
		w.once.Do(func() { close(w.ready) })
	}
	return len(b), nil
}
