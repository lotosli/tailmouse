package session

import (
	"net"
	"testing"
	"testing/synctest"
	"time"

	"tailmouse/apps/cli/internal/protocol"
)

func TestHostTruncatedHandshakeCannotAcquireAuthority(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		host := newTestHost(t, "leash", false)
		server, browser := net.Pipe()
		if !host.Accept(server) {
			t.Fatal("host refused owned handshake fixture")
		}
		if _, err := browser.Write([]byte{0, 0, 0, 5, byte(protocol.TypeClientHello), 0, '{'}); err != nil {
			t.Fatal(err)
		}
		_ = browser.Close()
		synctest.Wait()
		select {
		case <-host.FirstHello():
			t.Fatal("truncated handshake granted a process-start trigger")
		default:
		}
		if host.Authority.Inspect(time.Now()).Owner != 0 || host.InspectMetrics().FramesRX != 0 {
			t.Fatal("truncated handshake dispatched data or acquired authority")
		}
		_, welcome := connectTestHost(t, host, "leash", testHostID, 1)
		if welcome.Type != protocol.TypeServerWelcome {
			t.Fatal("later valid handshake failed after rejected partial handshake")
		}
	})
}

func TestHostTruncatedFrameDoesNotExtendReconnectGrace(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		host := newTestHost(t, "leash", false)
		browser, _ := connectTestHost(t, host, "leash", testHostID, 1)
		if _, err := browser.Write([]byte{0}); err != nil {
			t.Fatal(err)
		}
		_ = browser.Close()
		synctest.Wait()
		time.Sleep(time.Second)
		if host.Wait(t.Context()) != GraceExpired {
			t.Fatal("truncated stream changed the configured one-second reconnect grace")
		}
	})
}

func TestHostTruncatedActiveFrameReleasesLeaseWithoutEndingSession(t *testing.T) {
	for _, prefix := range [][]byte{{0}, {0, 0, 0, 5}, {0, 0, 0, 5, byte(protocol.TypeTermInput)}, {0, 0, 0, 5, byte(protocol.TypeTermInput), 0}, {0, 0, 0, 5, byte(protocol.TypeTermInput), 0, 'o', 'l'}} {
		synctest.Test(t, func(t *testing.T) {
			host := newTestHost(t, "leash", false)
			browser, _ := connectTestHost(t, host, "leash", testHostID, 1)
			before := host.InspectMetrics()
			if _, err := browser.Write(prefix); err != nil {
				t.Fatal(err)
			}
			if err := browser.Close(); err != nil {
				t.Fatal(err)
			}
			synctest.Wait()
			after := host.InspectMetrics()
			if after.ActiveConnection || after.ProtocolErrors != before.ProtocolErrors || after.FramesRX != before.FramesRX {
				t.Fatal("truncated transport retained authority, dispatched a partial frame or became a protocol failure")
			}
			replacement, welcome := connectTestHost(t, host, "leash", testHostID, 1)
			if welcome.Type != protocol.TypeServerWelcome {
				t.Fatal("fresh valid handshake could not replace the interrupted stream")
			}
			if err := replacement.Close(); err != nil {
				t.Fatal(err)
			}
			synctest.Wait()
		})
	}
}

func TestHostInvalidActiveFrameRemainsTerminalAfterEOF(t *testing.T) {
	for _, wire := range [][]byte{
		{0, 0, 0, 1},
		{0, 0, 0, 3, byte(protocol.TypeTermInput), 1},
		{0, 0, 0, 3, 0xff, 0},
		{0, 0, 0, 3, byte(protocol.TypeTermOutput), 0},
		{0, 0, 0, 6, byte(protocol.TypeTermResize), 0, 0, 1, 0, 1},
	} {
		synctest.Test(t, func(t *testing.T) {
			host := newTestHost(t, "leash", false)
			browser, _ := connectTestHost(t, host, "leash", testHostID, 1)
			if _, err := browser.Write(wire); err != nil {
				t.Fatal(err)
			}
			if err := browser.Close(); err != nil {
				t.Fatal(err)
			}
			synctest.Wait()
			if host.Wait(t.Context()) != ProtocolFailure || host.InspectMetrics().ProtocolErrors != 1 {
				t.Fatal("EOF replaced an already detected invalid frame with recovery")
			}
		})
	}
}
