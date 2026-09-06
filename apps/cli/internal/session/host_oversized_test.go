package session

import (
	"errors"
	"io"
	"net"
	"testing"
	"testing/synctest"
	"time"

	"tailmouse/apps/cli/internal/protocol"
)

func TestHostNotifiesOversizedPrefixBeforeBodyAndCloses(t *testing.T) {
	for _, scenario := range []struct {
		name   string
		active bool
		prefix []byte
	}{
		{"handshake", false, []byte{0, 0x10, 0, 1}},
		{"active global", true, []byte{0, 0x10, 0, 1}},
		{"active terminal", true, []byte{0, 0, 0x80, 1, byte(protocol.TypeTermInput), 0}},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				host := newTestHost(t, "leash", false)
				var browser net.Conn
				state := protocol.StateAwaitServerWelcome
				if scenario.active {
					browser, _ = connectTestHost(t, host, "leash", testHostID, 2)
					state = protocol.StateActiveLeash
				} else {
					var server net.Conn
					server, browser = net.Pipe()
					t.Cleanup(func() { _ = browser.Close() })
					if !host.Accept(server) {
						t.Fatal("host refused owned test connection")
					}
				}
				before := host.InspectMetrics()
				started := time.Now()
				if _, err := browser.Write(scenario.prefix); err != nil {
					t.Fatal(err)
				}
				frame, err := protocol.ReadFrame(t.Context(), browser, protocol.PeerBrowser, state)
				if err != nil {
					t.Fatal(err)
				}
				if code, _ := protocol.ErrorCodeOf(protocol.DecodeError(frame)); code != protocol.CodeFrameTooLarge || time.Since(started) != 0 {
					t.Fatal("host did not immediately reject the prefix before receiving any body")
				}
				var extra [1]byte
				if count, err := browser.Read(extra[:]); count != 0 || !errors.Is(err, io.EOF) {
					t.Fatal("oversized connection did not end at EOF")
				}
				synctest.Wait()
				metrics := host.InspectMetrics()
				if metrics.BytesRX-before.BytesRX != uint64(len(scenario.prefix)) || metrics.FramesRX != before.FramesRX || metrics.ProtocolErrors != 1 || metrics.ActiveConnection {
					t.Fatal("oversized prefix dispatched a frame, read its body or retained authority")
				}
				if scenario.active {
					if host.Wait(t.Context()) != ProtocolFailure {
						t.Fatal("active oversized failure lost its classification")
					}
				} else {
					select {
					case <-host.FirstHello():
						t.Fatal("invalid first frame granted a process start")
					default:
					}
				}
			})
		})
	}
}
