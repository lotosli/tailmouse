package session

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net"
	"sync"
	"testing"
	"testing/synctest"
	"time"

	"tailmouse/apps/cli/internal/leash"
	"tailmouse/apps/cli/internal/protocol"
)

var testHostID = [16]byte{1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16}

func TestHostMeasuresOneHertzLatencyAndClosesWithInFlightTraffic(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		host := newTestHost(t, "leash", false)
		events := make(chan Event, 3)
		host.observe = func(event Event) error { events <- event; return nil }
		browser, _ := connectTestHost(t, host, "leash", testHostID, 2)
		synctest.Wait()
		started := time.Now()
		for index := 1; index <= 2; index++ {
			ping, err := protocol.ReadFrame(context.Background(), browser, protocol.PeerBrowser, protocol.StateActiveLeash)
			if err != nil || ping.Type != protocol.TypePing {
				t.Fatal("one-hertz ping missing", err)
			}
			if time.Since(started) != time.Duration(index)*time.Second {
				t.Fatal("PING cadence is not one hertz")
			}
			time.Sleep(40 * time.Millisecond)
			if err := protocol.WriteFrame(context.Background(), browser, protocol.PeerBrowser, protocol.StateActiveLeash,
				protocol.Frame{Type: protocol.TypePong, Payload: ping.Payload}); err != nil {
				t.Fatal(err)
			}
			synctest.Wait()
		}
		metrics := host.InspectMetrics()
		if metrics.Samples != 2 || metrics.RTTMS != 40 || metrics.JitterMS != 0 || metrics.FramesTX != 4 || metrics.FramesRX != 4 || metrics.BytesTX == 0 || metrics.BytesRX == 0 || !metrics.ActiveConnection {
			t.Fatalf("metrics = %#v", metrics)
		}
		closed := make(chan error, 1)
		go func() { closed <- host.Close("local_revoke") }()
		frame, err := protocol.ReadFrame(context.Background(), browser, protocol.PeerBrowser, protocol.StateActiveLeash)
		if err != nil || frame.Type != protocol.TypeClose {
			t.Fatal("host close missing", err)
		}
		// A write accepted by the peer before it saw CLOSE may cross ours.
		if err := protocol.WriteFrame(context.Background(), browser, protocol.PeerBrowser, protocol.StateActiveLeash,
			protocol.Frame{Type: protocol.TypePong, Payload: make([]byte, 16)}); err != nil {
			t.Fatal(err)
		}
		ack, _ := protocol.CloseFrame("local_revoke")
		if err := protocol.WriteFrame(context.Background(), browser, protocol.PeerBrowser, protocol.StateClosing, ack); err != nil {
			t.Fatal(err)
		}
		_ = browser.Close()
		if err := <-closed; err != nil {
			t.Fatal(err)
		}
		if host.InspectMetrics().ActiveConnection {
			t.Fatal("closed connection remained active")
		}
		if len(events) != 3 || (<-events).Kind != BrowserConnected {
			t.Fatal("connection diagnostics lost a transition")
		}
		for sample := uint64(1); sample <= 2; sample++ {
			event := <-events
			if event.Kind != RTTMeasured || event.Metrics.Samples != sample || event.Metrics.RTTMS != 40 {
				t.Fatal("RTT diagnostics did not contain the actual samples")
			}
		}
	})
}

func TestHostDiagnosticFailureChoosesInternalOutcomeAndJoinsWorkers(t *testing.T) {
	for _, kind := range []EventKind{BrowserConnected, BrowserDisconnected, RTTMeasured, TerminalOutputDropped} {
		synctest.Test(t, func(t *testing.T) {
			host, err := NewHost(context.Background(), Config{Mode: "leash", SessionID: testHostID, ReconnectGrace: time.Minute}, time.Now(), func(event Event) error {
				if event.Kind == kind {
					return errors.New("synthetic diagnostic sink failure")
				}
				return nil
			})
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = host.Close("local_revoke") })
			if kind == TerminalOutputDropped {
				if err := host.ConfigureLeash(); err != nil {
					t.Fatal(err)
				}
				process := &terminalFixturePTY{output: bytes.NewReader(bytes.Repeat([]byte{'x'}, 128<<10)), done: make(chan struct{})}
				pump, err := leash.NewPump(process, 64<<10, func(context.Context, []byte) error { return nil })
				if err != nil {
					t.Fatal(err)
				}
				if err := pump.Run(t.Context()); err != nil {
					t.Fatal(err)
				}
				if err := host.PublishLeash(protocol.ProcessState{Generation: 1, State: "exited"}, pump); err != nil {
					t.Fatal(err)
				}
			}
			if err := host.Listen("official", "relay.example.com", time.Now()); err != nil {
				t.Fatal(err)
			}
			browser, _ := connectTestHost(t, host, "leash", testHostID, 2)
			if kind == TerminalOutputDropped {
				for {
					frame, err := protocol.ReadFrame(t.Context(), browser, protocol.PeerBrowser, protocol.StateActiveLeash)
					if err != nil {
						break
					}
					if frame.Type == protocol.TypeOutputDropped {
						t.Fatal("failed diagnostic did not stop before the next network write")
					}
				}
			}
			if kind == RTTMeasured {
				ping, err := protocol.ReadFrame(context.Background(), browser, protocol.PeerBrowser, protocol.StateActiveLeash)
				if err != nil || ping.Type != protocol.TypePing {
					t.Fatal("ping missing")
				}
				if err := protocol.WriteFrame(context.Background(), browser, protocol.PeerBrowser, protocol.StateActiveLeash, protocol.Frame{Type: protocol.TypePong, Payload: ping.Payload}); err != nil {
					t.Fatal(err)
				}
			}
			if kind == BrowserDisconnected {
				_ = browser.Close()
			}
			synctest.Wait()
			if host.Wait(context.Background()) != InternalFailure {
				t.Fatal("diagnostic failure did not terminate the session")
			}
			if err := host.Close("local_revoke"); err != nil {
				t.Fatal(err)
			}
			if host.InspectMetrics().ActiveConnection {
				t.Fatal("failed observer retained an active connection")
			}
		})
	}
}

func newTestHost(t *testing.T, mode string, readonly bool) *Host {
	t.Helper()
	host, err := NewHost(context.Background(), Config{Mode: mode, SessionID: testHostID, ReconnectGrace: time.Second, Readonly: readonly}, time.Now(), nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = host.Close("local_revoke") })
	if err := host.Listen("official", "relay.example.com", time.Now()); err != nil {
		t.Fatal(err)
	}
	return host
}

func connectTestHost(t *testing.T, host *Host, mode string, id [16]byte, version int) (net.Conn, protocol.Frame) {
	t.Helper()
	server, browser := net.Pipe()
	t.Cleanup(func() { _ = browser.Close() })
	_ = browser.SetDeadline(time.Now().Add(3 * time.Second))
	if !host.Accept(server) {
		t.Fatal("host rejected test transport admission")
	}
	writeTestHello(t, browser, mode, id, version)
	frame, err := protocol.ReadFrame(context.Background(), browser, protocol.PeerBrowser, protocol.StateAwaitServerWelcome)
	if err != nil {
		t.Fatal(err)
	}
	if frame.Type == protocol.TypeAuthChallenge {
		challenge, err := protocol.DecodeAuthChallenge(frame)
		clear(frame.Payload)
		if err != nil {
			t.Fatal(err)
		}
		code, ok := host.AccessCodeForDisplay()
		if !ok {
			t.Fatal("protected test host did not retain its access code")
		}
		proof := AccessProof(code, id, challenge)
		clear(code[:])
		clear(challenge[:])
		proofFrame, err := protocol.AuthProofFrame(proof)
		clear(proof[:])
		if err != nil {
			t.Fatal(err)
		}
		if err := protocol.WriteFrame(context.Background(), browser, protocol.PeerBrowser, protocol.StateAwaitAuthProof, proofFrame); err != nil {
			t.Fatal(err)
		}
		clear(proofFrame.Payload)
		frame, err = protocol.ReadFrame(context.Background(), browser, protocol.PeerBrowser, protocol.StateAwaitServerWelcome)
		if err != nil {
			t.Fatal(err)
		}
	}
	return browser, frame
}

func writeTestHello(t *testing.T, browser net.Conn, mode string, id [16]byte, version int) {
	t.Helper()
	hello, _ := json.Marshal(map[string]any{
		"protocol_min": version, "protocol_max": version, "session_id": hex.EncodeToString(id[:]), "mode": mode,
		"client": map[string]string{"name": "test-browser", "version": "1", "platform": "test", "user_agent": ""},
	})
	wire := make([]byte, 6+len(hello))
	binary.BigEndian.PutUint32(wire, uint32(len(hello)+2))
	wire[4] = byte(protocol.TypeClientHello)
	copy(wire[6:], hello)
	if _, err := browser.Write(wire); err != nil {
		t.Fatal("hello write failed")
	}
}

func TestFirstHelloRetainsStartTriggerBeforeWelcomeAndAfterDisconnect(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		host := newTestHost(t, "leash", false)
		first := host.FirstHello()
		select {
		case <-first:
			t.Fatal("host supplied a start trigger before a valid HELLO")
		default:
		}
		server, browser := net.Pipe()
		t.Cleanup(func() { _ = browser.Close() })
		if !host.Accept(server) {
			t.Fatal("host rejected test connection")
		}
		writeTestHello(t, browser, "leash", testHostID, 2)
		challengeFrame, err := protocol.ReadFrame(context.Background(), browser, protocol.PeerBrowser, protocol.StateAwaitServerWelcome)
		if err != nil || challengeFrame.Type != protocol.TypeAuthChallenge {
			t.Fatal("protected host did not request proof", err)
		}
		select {
		case <-first:
			t.Fatal("preliminary HELLO supplied a start trigger before authentication")
		default:
		}
		challenge, _ := protocol.DecodeAuthChallenge(challengeFrame)
		clear(challengeFrame.Payload)
		code, _ := host.AccessCodeForDisplay()
		proof := AccessProof(code, testHostID, challenge)
		proofFrame, _ := protocol.AuthProofFrame(proof)
		clear(code[:])
		clear(challenge[:])
		clear(proof[:])
		if err := protocol.WriteFrame(context.Background(), browser, protocol.PeerBrowser, protocol.StateAwaitAuthProof, proofFrame); err != nil {
			t.Fatal(err)
		}
		clear(proofFrame.Payload)
		// WELCOME cannot complete because this peer never reads it. A diagnostic
		// callback after that write would lose the required startup notification.
		synctest.Wait()
		select {
		case <-first:
		default:
			t.Fatal("valid HELLO was hidden behind the blocked WELCOME write")
		}
		if snapshot := host.Authority.Inspect(time.Now()); snapshot.State != Active || snapshot.Owner == 0 {
			t.Fatal("start notification preceded authority acquisition")
		}
		_ = browser.Close()
		synctest.Wait()
		if snapshot := host.Authority.Inspect(time.Now()); snapshot.State != Listening || !snapshot.GraceDeadline.IsZero() {
			t.Fatal("test browser did not return Leash to listening")
		}
		select {
		case <-first:
		default:
			t.Fatal("disconnect lost the historical start notification")
		}
		replacement, response := connectTestHost(t, host, "leash", testHostID, 2)
		if response.Type != protocol.TypeServerWelcome || host.FirstHello() != first {
			t.Fatal("reconnect replaced the one-shot startup trigger")
		}
		_ = replacement.Close()
	})
}

func TestFirstHelloRequiresValidUnexpiredAuthority(t *testing.T) {
	for _, test := range []struct {
		name, mode string
		id         [16]byte
		version    int
		expired    bool
	}{
		{"wrong identity", "leash", [16]byte{8}, 2, false},
		{"wrong mode", "leash", testHostID, 1, false},
		{"wrong protocol", "leash", testHostID, 1, false},
		{"expired", "leash", testHostID, 2, true},
	} {
		t.Run(test.name, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				host, err := NewHost(t.Context(), Config{Mode: "leash", SessionID: testHostID, TTL: time.Second}, time.Now(), nil)
				if err != nil {
					t.Fatal(err)
				}
				t.Cleanup(func() { _ = host.Close("local_revoke") })
				if err := host.Listen("official", "relay.example.com", time.Now()); err != nil {
					t.Fatal(err)
				}
				if test.expired {
					time.Sleep(time.Second)
				}
				browser, response := connectTestHost(t, host, test.mode, test.id, test.version)
				if response.Type != protocol.TypeError {
					t.Fatal("invalid peer was not rejected")
				}
				_ = browser.Close()
				synctest.Wait()
				select {
				case <-host.FirstHello():
					t.Fatal("invalid or expired HELLO supplied a process startup trigger")
				default:
				}
				if err := host.Close("local_revoke"); err != nil {
					t.Fatal(err)
				}
				select {
				case <-host.FirstHello():
					t.Fatal("host closure was mistaken for a startup trigger")
				default:
				}
			})
		})
	}
}

func waitHostState(t *testing.T, host *Host, state State) Snapshot {
	t.Helper()
	timer := time.NewTimer(time.Second)
	defer timer.Stop()
	for {
		snapshot := host.Authority.Inspect(time.Now())
		if snapshot.State == state {
			return snapshot
		}
		select {
		case <-host.changed:
		case <-timer.C:
			t.Fatalf("host did not reach %s (at %s)", state, snapshot.State)
		}
	}
}

func TestHostNegotiatesAuthorityAndNormalClose(t *testing.T) {
	host := newTestHost(t, "leash", false)
	browser, welcome := connectTestHost(t, host, "leash", testHostID, 2)
	if welcome.Type != protocol.TypeServerWelcome || welcome.SelectedProtocol != 2 {
		t.Fatal("missing negotiated welcome")
	}
	var value struct {
		Mode         string
		Capabilities []string
		ExpiresAt    int64 `json:"expires_at"`
	}
	if err := json.Unmarshal(welcome.Payload, &value); err != nil {
		t.Fatal(err)
	}
	if value.Mode != "leash" || len(value.Capabilities) != 6 || value.ExpiresAt != 0 {
		t.Fatal("welcome authority is incorrect")
	}
	ping := protocol.Frame{Type: protocol.TypePing, Payload: make([]byte, 16)}
	ping.Payload[15] = 7
	if err := protocol.WriteFrame(context.Background(), browser, protocol.PeerBrowser, protocol.StateActiveLeash, ping); err != nil {
		t.Fatal(err)
	}
	pong, err := protocol.ReadFrame(context.Background(), browser, protocol.PeerBrowser, protocol.StateActiveLeash)
	if err != nil || pong.Type != protocol.TypePong || !bytes.Equal(pong.Payload, ping.Payload) {
		t.Fatal("PING did not echo byte-for-byte as PONG")
	}
	closeFrame, _ := protocol.CloseFrame("normal")
	if err := protocol.WriteFrame(context.Background(), browser, protocol.PeerBrowser, protocol.StateActiveLeash, closeFrame); err != nil {
		t.Fatal(err)
	}
	closed, err := protocol.ReadFrame(context.Background(), browser, protocol.PeerBrowser, protocol.StateClosing)
	if err != nil || closed.Type != protocol.TypeClose {
		t.Fatal("host omitted CLOSE acknowledgement")
	}
	_ = browser.Close()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if outcome := host.Wait(ctx); outcome != LocalRevoke {
		t.Fatalf("outcome = %s", outcome)
	}
	if err := host.Close("mode_complete"); err != nil {
		t.Fatal(err)
	}
	if err := host.Close("normal"); err != nil {
		t.Fatal("repeat close changed its outcome")
	}
}

func TestHostRejectsPeersWithoutChangingTheOwner(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		host := newTestHost(t, "leash", true)
		owner, welcome := connectTestHost(t, host, "leash", testHostID, 2)
		if !bytes.Contains(welcome.Payload, []byte(`"capabilities":["terminal_output"]`)) {
			t.Fatal("readonly capability manifest was not authoritative")
		}
		lease := host.Authority.Inspect(time.Now()).Owner
		for _, test := range []struct {
			mode    string
			id      [16]byte
			version int
			code    protocol.ErrorCode
		}{
			{"leash", testHostID, 2, protocol.CodeSessionBusy},
			{"unsupported", testHostID, 2, protocol.CodeBadFrame},
			{"leash", [16]byte{8}, 2, protocol.CodeBadMouseCard},
			{"leash", testHostID, 1, protocol.CodeProtocolMismatch},
		} {
			browser, response := connectTestHost(t, host, test.mode, test.id, test.version)
			if code, ok := protocol.ErrorCodeOf(protocol.DecodeError(response)); !ok || code != test.code {
				t.Fatalf("rejection = %s, want %s", code, test.code)
			}
			_ = browser.Close()
			synctest.Wait()
			if snapshot := host.Authority.Inspect(time.Now()); snapshot.State != Active || snapshot.Owner != lease {
				t.Fatal("rejected peer displaced the owner")
			}
		}
		if err := protocol.WriteFrame(context.Background(), owner, protocol.PeerBrowser, protocol.StateActiveLeash, protocol.Frame{Type: protocol.TypeTermInput, Payload: []byte("input")}); err != nil {
			t.Fatal(err)
		}
		response, err := protocol.ReadFrame(context.Background(), owner, protocol.PeerBrowser, protocol.StateActiveLeash)
		if err != nil {
			t.Fatal(err)
		}
		if code, _ := protocol.ErrorCodeOf(protocol.DecodeError(response)); code != protocol.CodeReadonly {
			t.Fatal("readonly input was not rejected at the host")
		}
		_ = owner.Close()
		// Listening can precede worker retirement; settle the closed streams
		// before requesting a new authentication slot.
		synctest.Wait()
		waitHostState(t, host, Listening)
		replacement, response := connectTestHost(t, host, "leash", testHostID, 2)
		if response.Type != protocol.TypeServerWelcome {
			t.Fatal("replacement did not negotiate a fresh welcome")
		}
		snapshot := host.Authority.Inspect(time.Now())
		if snapshot.Owner == lease || snapshot.Reconnects != 1 {
			t.Fatal("reconnect reused stale ownership")
		}
		_ = replacement.Close()
	})
}

func TestHostBoundsPendingWorkersAndJoinsOnClose(t *testing.T) {
	host, err := NewHost(context.Background(), Config{Mode: "leash", NoPassword: true, SessionID: testHostID}, time.Now(), nil)
	if err != nil {
		t.Fatal(err)
	}
	for index := 0; index < MaxPendingAuthentication; index++ {
		server, browser := net.Pipe()
		defer browser.Close()
		if !host.Accept(server) {
			t.Fatal("bounded handshake slot unavailable")
		}
	}
	server, overflow := net.Pipe()
	defer overflow.Close()
	if host.Accept(server) || host.Accept(nil) {
		t.Fatal("over-capacity or nil admission succeeded")
	}
	var data [1]byte
	if _, err := overflow.Read(data[:]); !errors.Is(err, io.EOF) {
		t.Fatal("overflow transport was not closed")
	}
	var group sync.WaitGroup
	for range 8 {
		group.Go(func() {
			if err := host.Close("local_revoke"); err != nil {
				t.Error(err)
			}
		})
	}
	group.Wait()
	host.mu.Lock()
	remaining := len(host.connections)
	host.mu.Unlock()
	if remaining != 0 || host.Authority.Inspect(time.Now()).State != Closed {
		t.Fatal("close retained workers or authority")
	}
	lateServer, lateBrowser := net.Pipe()
	defer lateBrowser.Close()
	if host.Accept(lateServer) {
		t.Fatal("closed host accepted a late stream")
	}
}

func TestHostShutdownTimeoutStillJoinsAndRevokes(t *testing.T) {
	for _, receiveClose := range []bool{false, true} {
		name := "blocked-close-write"
		if receiveClose {
			name = "missing-close-ack"
		}
		t.Run(name, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				host := newTestHost(t, "leash", false)
				browser, _ := connectTestHost(t, host, "leash", testHostID, 2)
				host.finish(ModeComplete)
				started := time.Now()
				done := make(chan error, 1)
				go func() { done <- host.Close("normal") }()
				if receiveClose {
					frame, err := protocol.ReadFrame(context.Background(), browser, protocol.PeerBrowser, protocol.StateActiveLeash)
					if err != nil || frame.Type != protocol.TypeClose {
						t.Fatal("host close notification missing")
					}
				}
				if err := <-done; err != ErrShutdown || time.Since(started) != closeLimit {
					t.Fatal("unacknowledged shutdown did not report its exact bounded failure")
				}
				state := host.Authority.Inspect(time.Now())
				if state.State != Closed || state.Outcome != ModeComplete || state.Owner != 0 || len(host.Authority.Capabilities()) != 0 {
					t.Fatal("shutdown failure retained authority or replaced the first outcome")
				}
				host.mu.Lock()
				remaining, welcome := len(host.connections), host.welcome
				host.mu.Unlock()
				host.Authority.mu.Lock()
				identityCleared := host.Authority.identifier == [16]byte{}
				host.Authority.mu.Unlock()
				if remaining != 0 || welcome.Mode != "" || len(welcome.Capabilities) != 0 || !identityCleared {
					t.Fatal("shutdown failure retained a worker, welcome state or identity")
				}
				var data [1]byte
				if _, err := browser.Read(data[:]); !errors.Is(err, io.EOF) {
					t.Fatal("shutdown failure left the peer stream open")
				}
				if err := host.Close("normal"); err != ErrShutdown || time.Since(started) != closeLimit {
					t.Fatal("repeated shutdown changed its outcome or repeated the wait")
				}
				server, peer := net.Pipe()
				defer peer.Close()
				if host.Accept(server) {
					t.Fatal("shutdown failure admitted a later connection")
				}
			})
		})
	}
}

func TestHostTimersAndCancellationSelectTerminalOutcomes(t *testing.T) {
	for _, test := range []struct {
		name   string
		ttl    time.Duration
		cancel bool
		want   Outcome
	}{
		{"ttl", 20 * time.Millisecond, false, TTLExpired},
		{"revoke", 0, true, LocalRevoke},
	} {
		t.Run(test.name, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			host, err := NewHost(ctx, Config{Mode: "leash", NoPassword: true, SessionID: testHostID, TTL: test.ttl}, time.Now(), nil)
			if err != nil {
				t.Fatal(err)
			}
			if err := host.Listen("official", "relay.example.com", time.Now()); err != nil {
				t.Fatal(err)
			}
			if test.cancel {
				cancel()
			}
			if outcome := host.Wait(ctx); outcome != test.want {
				t.Fatalf("outcome = %s", outcome)
			}
			if err := host.Close("expired"); err != nil {
				t.Fatal(err)
			}
		})
	}
	synctest.Test(t, func(t *testing.T) {
		ctx, cancel := context.WithCancel(t.Context())
		host, err := NewHost(ctx, Config{Mode: "leash", SessionID: testHostID, ReconnectGrace: 10 * time.Millisecond}, time.Now(), nil)
		if err != nil {
			t.Fatal(err)
		}
		if err := host.Listen("official", "relay.example.com", time.Now()); err != nil {
			t.Fatal(err)
		}
		browser, _ := connectTestHost(t, host, "leash", testHostID, 2)
		_ = browser.Close()
		synctest.Wait()
		done := make(chan Outcome, 1)
		go func() { done <- host.Wait(ctx) }()
		time.Sleep(4*time.Hour + 30*time.Second)
		synctest.Wait()
		select {
		case outcome := <-done:
			t.Fatalf("browser absence ended a Host-lived Leash share: %s", outcome)
		default:
		}
		if snapshot := host.Authority.Inspect(time.Now()); snapshot.State != Listening || !snapshot.ExpiresAt.IsZero() || !snapshot.GraceDeadline.IsZero() {
			t.Fatal("Host-lived Leash installed a hidden absence or four-hour deadline")
		}
		cancel()
		synctest.Wait()
		if outcome := <-done; outcome != LocalRevoke {
			t.Fatalf("local revoke outcome = %s", outcome)
		}
		if err := host.Close("local_revoke"); err != nil {
			t.Fatal(err)
		}
	})
}

func TestActiveHostExpiryRevokesAuthorityBeforeGracefulClose(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		host, err := NewHost(context.Background(), Config{Mode: "leash", NoPassword: true, SessionID: testHostID, TTL: 100 * time.Millisecond}, time.Now(), nil)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = host.Close("expired") })
		if err := host.Listen("official", "relay.example.com", time.Now()); err != nil {
			t.Fatal(err)
		}
		browser, _ := connectTestHost(t, host, "leash", testHostID, 2)
		done := make(chan error, 1)
		go func() {
			if host.Wait(context.Background()) != TTLExpired {
				done <- errors.New("host lost the expiry outcome")
				return
			}
			done <- host.Close("expired")
		}()
		frame, err := protocol.ReadFrame(context.Background(), browser, protocol.PeerBrowser, protocol.StateActiveLeash)
		reason, decodeErr := protocol.DecodeClose(frame)
		if err != nil || decodeErr != nil || frame.Type != protocol.TypeClose || reason != "expired" {
			t.Fatal("active peer did not receive the expiry notification")
		}
		state := host.Authority.Inspect(time.Now())
		if state.State != Expired || state.Owner != 0 || len(host.Authority.Capabilities()) != 0 {
			t.Fatal("expiry notification preceded authority revocation")
		}
		ack, _ := protocol.CloseFrame("expired")
		if err := protocol.WriteFrame(context.Background(), browser, protocol.PeerBrowser, protocol.StateClosing, ack); err != nil {
			t.Fatal(err)
		}
		_ = browser.Close()
		if err := <-done; err != nil {
			t.Fatal(err)
		}
		if host.Authority.Inspect(time.Now()).Outcome != TTLExpired || host.InspectMetrics().ActiveConnection {
			t.Fatal("cleanup replaced expiry or retained the browser slot")
		}
	})
}
