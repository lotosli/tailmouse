package session

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net"
	"sync"
	"sync/atomic"
	"testing"
	"testing/synctest"
	"time"

	"tailmouse/apps/cli/internal/leash"
	"tailmouse/apps/cli/internal/protocol"
)

func TestProtectedAndLinkOnlyAdmissionStates(t *testing.T) {
	for _, linkOnly := range []bool{false, true} {
		name := "protected"
		if linkOnly {
			name = "link-only"
		}
		t.Run(name, func(t *testing.T) {
			host, err := NewHost(t.Context(), Config{
				Mode: "leash", SessionID: testHostID, ReconnectGrace: time.Minute,
				NoPassword: linkOnly, entropy: bytes.NewReader(sequentialEntropy(256)),
			}, time.Now(), nil)
			if err != nil {
				t.Fatal(err)
			}
			if err := host.Listen("official", "relay.example.com", time.Now()); err != nil {
				t.Fatal(err)
			}
			code, available := host.AccessCodeForDisplay()
			if available == linkOnly || (!linkOnly && code.Grouped() != "2345-6789-ABCD-EFGH") {
				t.Fatal("Host selected the wrong access mode")
			}
			clear(code[:])
			browser, response := connectTestHost(t, host, "leash", testHostID, 2)
			if response.Type != protocol.TypeServerWelcome {
				t.Fatal("admitted peer did not receive a welcome")
			}
			accessMode := `"access_mode":"code"`
			if linkOnly {
				accessMode = `"access_mode":"link"`
			}
			if !bytes.Contains(response.Payload, []byte(accessMode)) {
				t.Fatal("welcome did not report the Host-authoritative access mode")
			}
			_ = browser.Close()
			waitForNoConnections(t, host)
			if err := host.Close("local_revoke"); err != nil {
				t.Fatal(err)
			}
			if code, ok := host.AccessCodeForDisplay(); ok || code != (AccessCode{}) {
				t.Fatal("closed share retained its access code")
			}
		})
	}
}

func TestAdmissionPrecedesStartSlotAndTerminalDisclosure(t *testing.T) {
	const privateOutput = "tcPrivateTerminalOutput"
	const privateTitle = "tcPrivateTaskMetadata"
	host, err := NewHost(t.Context(), Config{
		Mode: "leash", SessionID: testHostID, ReconnectGrace: time.Minute,
		entropy: bytes.NewReader(sequentialEntropy(512)),
	}, time.Now(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := host.ConfigureLeash(); err != nil {
		t.Fatal(err)
	}
	process := &terminalFixturePTY{output: bytes.NewReader([]byte(privateOutput)), done: make(chan struct{})}
	pump, err := leash.NewPump(process, 64<<10, func(context.Context, []byte) error { return nil })
	if err != nil {
		t.Fatal(err)
	}
	if err := pump.Run(t.Context()); err != nil {
		t.Fatal(err)
	}
	if err := host.PublishLeash(protocol.ProcessState{Generation: 1, State: "running", Title: privateTitle}, pump); err != nil {
		t.Fatal(err)
	}
	if err := host.Listen("official", "tcprivate-relay.example.com", time.Now()); err != nil {
		t.Fatal(err)
	}

	server, stalled := net.Pipe()
	if !host.Accept(server) {
		t.Fatal("Host rejected the stalled authentication fixture")
	}
	writeTestHello(t, stalled, "leash", testHostID, 2)
	challenge, err := protocol.ReadFrame(t.Context(), stalled, protocol.PeerBrowser, protocol.StateAwaitServerWelcome)
	if err != nil || challenge.Type != protocol.TypeAuthChallenge {
		t.Fatal("stalled peer did not stop at the authentication boundary", err)
	}
	if bytes.Contains(challenge.Payload, []byte(privateOutput)) || bytes.Contains(challenge.Payload, []byte(privateTitle)) || bytes.Contains(challenge.Payload, []byte("tcprivate-relay.example.com")) {
		t.Fatal("authentication challenge disclosed task or relay data")
	}
	clear(challenge.Payload)

	server, wrong := net.Pipe()
	if !host.Accept(server) {
		t.Fatal("Host rejected the failed authentication fixture")
	}
	writeTestHello(t, wrong, "leash", testHostID, 2)
	challenge, err = protocol.ReadFrame(t.Context(), wrong, protocol.PeerBrowser, protocol.StateAwaitServerWelcome)
	if err != nil || challenge.Type != protocol.TypeAuthChallenge {
		t.Fatal("failed peer did not receive a challenge", err)
	}
	clear(challenge.Payload)
	proofFrame, err := protocol.AuthProofFrame([32]byte{})
	if err != nil {
		t.Fatal(err)
	}
	if err := protocol.WriteFrame(t.Context(), wrong, protocol.PeerBrowser, protocol.StateAwaitAuthProof, proofFrame); err != nil {
		t.Fatal(err)
	}
	clear(proofFrame.Payload)
	response, err := protocol.ReadFrame(t.Context(), wrong, protocol.PeerBrowser, protocol.StateAwaitServerWelcome)
	if err != nil || response.Type != protocol.TypeError {
		t.Fatal("failed peer did not receive a bounded rejection", err)
	}
	if code, _ := protocol.ErrorCodeOf(protocol.DecodeError(response)); code != protocol.CodeAuthFailed {
		t.Fatalf("failed proof returned %s", code)
	}
	if bytes.Contains(response.Payload, []byte(privateOutput)) || bytes.Contains(response.Payload, []byte(privateTitle)) {
		t.Fatal("authentication failure disclosed terminal data")
	}
	clear(response.Payload)
	_ = wrong.Close()

	server, old := net.Pipe()
	if !host.Accept(server) {
		t.Fatal("Host rejected the old-peer fixture")
	}
	writeTestHello(t, old, "leash", testHostID, 1)
	response, err = protocol.ReadFrame(t.Context(), old, protocol.PeerBrowser, protocol.StateAwaitServerWelcome)
	if err != nil || response.Type != protocol.TypeError {
		t.Fatal("old peer did not fail closed before admission", err)
	}
	if bytes.Contains(response.Payload, []byte(privateOutput)) || bytes.Contains(response.Payload, []byte(privateTitle)) {
		t.Fatal("old-peer rejection disclosed terminal data")
	}
	clear(response.Payload)
	_ = old.Close()

	select {
	case <-host.FirstHello():
		t.Fatal("failed, stalled, or old peers triggered process startup")
	default:
	}
	if snapshot := host.Authority.Inspect(time.Now()); snapshot.State == Active || snapshot.Owner != 0 {
		t.Fatal("an unauthenticated peer acquired the active slot")
	}
	host.terminal.mu.Lock()
	attached := host.terminal.connection != nil
	host.terminal.mu.Unlock()
	if attached {
		t.Fatal("an unauthenticated peer received terminal state")
	}

	owner, welcome := connectTestHost(t, host, "leash", testHostID, 2)
	if welcome.Type != protocol.TypeServerWelcome {
		t.Fatal("authenticated owner did not receive session metadata")
	}
	gotOutput, gotState := false, false
	for range 8 {
		frame, err := protocol.ReadFrame(t.Context(), owner, protocol.PeerBrowser, protocol.StateActiveLeash)
		if err != nil {
			t.Fatal(err)
		}
		switch frame.Type {
		case protocol.TypeTermOutput:
			gotOutput = gotOutput || bytes.Contains(frame.Payload, []byte(privateOutput))
		case protocol.TypeProcessState:
			state, decodeErr := protocol.DecodeProcessState(frame)
			if decodeErr != nil {
				t.Fatal(decodeErr)
			}
			gotState = gotState || state.Title == privateTitle
		case protocol.TypePing:
			if err := protocol.WriteFrame(t.Context(), owner, protocol.PeerBrowser, protocol.StateActiveLeash, protocol.Frame{Type: protocol.TypePong, Payload: frame.Payload}); err != nil {
				t.Fatal(err)
			}
		}
		clear(frame.Payload)
		if gotOutput && gotState {
			break
		}
	}
	if !gotOutput || !gotState {
		t.Fatal("authenticated owner did not receive the retained terminal snapshot")
	}
	_ = stalled.Close()
	_ = owner.Close()
	waitForNoConnections(t, host)
	if err := host.Close("local_revoke"); err != nil {
		t.Fatal(err)
	}
}

func TestConcurrentAuthenticatedPeersSelectOneOwnerAndReconnectSnapshot(t *testing.T) {
	privateOutput := bytes.Repeat([]byte("01234567"), (72<<10)/8)
	host, err := NewHost(t.Context(), Config{
		Mode: "leash", SessionID: testHostID, ReconnectGrace: time.Minute,
		entropy: bytes.NewReader(sequentialEntropy(512)),
	}, time.Now(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := host.ConfigureLeash(); err != nil {
		t.Fatal(err)
	}
	process := &terminalFixturePTY{output: bytes.NewReader(privateOutput), done: make(chan struct{})}
	pump, err := leash.NewPump(process, leash.MinScrollback, func(context.Context, []byte) error { return nil })
	if err != nil {
		t.Fatal(err)
	}
	if err := pump.Run(t.Context()); err != nil {
		t.Fatal(err)
	}
	if err := host.PublishLeash(protocol.ProcessState{Generation: 1, State: "running", Title: "private-race-task"}, pump); err != nil {
		t.Fatal(err)
	}
	if err := host.Listen("official", "relay.example.com", time.Now()); err != nil {
		t.Fatal(err)
	}
	defer func() {
		clear(privateOutput)
		if err := host.Close("local_revoke"); err != nil {
			t.Error(err)
		}
	}()

	code, ok := host.AccessCodeForDisplay()
	if !ok {
		t.Fatal("protected Host lost its access code")
	}
	type candidate struct {
		peer  net.Conn
		proof protocol.Frame
	}
	candidates := make([]candidate, 2)
	for index := range candidates {
		server, peer := net.Pipe()
		_ = peer.SetDeadline(time.Now().Add(3 * time.Second))
		if !host.Accept(server) {
			t.Fatal("Host rejected an authentication race candidate")
		}
		writeTestHello(t, peer, "leash", testHostID, 2)
		challengeFrame, readErr := protocol.ReadFrame(t.Context(), peer, protocol.PeerBrowser, protocol.StateAwaitServerWelcome)
		if readErr != nil || challengeFrame.Type != protocol.TypeAuthChallenge {
			t.Fatal("authentication race candidate did not receive a challenge", readErr)
		}
		challenge, decodeErr := protocol.DecodeAuthChallenge(challengeFrame)
		clear(challengeFrame.Payload)
		if decodeErr != nil {
			t.Fatal(decodeErr)
		}
		proof := AccessProof(code, testHostID, challenge)
		clear(challenge[:])
		proofFrame, frameErr := protocol.AuthProofFrame(proof)
		clear(proof[:])
		if frameErr != nil {
			t.Fatal(frameErr)
		}
		candidates[index] = candidate{peer: peer, proof: proofFrame}
	}
	clear(code[:])

	type result struct {
		index int
		frame protocol.Frame
		err   error
	}
	start := make(chan struct{})
	results := make(chan result, len(candidates))
	var group sync.WaitGroup
	for index := range candidates {
		group.Go(func() {
			<-start
			candidate := &candidates[index]
			err := protocol.WriteFrame(t.Context(), candidate.peer, protocol.PeerBrowser, protocol.StateAwaitAuthProof, candidate.proof)
			clear(candidate.proof.Payload)
			if err != nil {
				results <- result{index: index, err: err}
				return
			}
			frame, err := protocol.ReadFrame(t.Context(), candidate.peer, protocol.PeerBrowser, protocol.StateAwaitServerWelcome)
			results <- result{index: index, frame: frame, err: err}
		})
	}
	close(start)
	group.Wait()
	close(results)

	winner := -1
	for result := range results {
		if result.err != nil {
			t.Fatal(result.err)
		}
		switch result.frame.Type {
		case protocol.TypeServerWelcome:
			if winner != -1 {
				t.Fatal("authentication race admitted more than one owner")
			}
			winner = result.index
		case protocol.TypeError:
			if code, _ := protocol.ErrorCodeOf(protocol.DecodeError(result.frame)); code != protocol.CodeSessionBusy {
				t.Fatalf("authentication race loser returned %s", code)
			}
			if bytes.Contains(result.frame.Payload, privateOutput[:32]) || bytes.Contains(result.frame.Payload, []byte("private-race-task")) {
				t.Fatal("authentication race loser received task data")
			}
			_ = candidates[result.index].peer.Close()
		default:
			t.Fatalf("authentication race returned frame %d", result.frame.Type)
		}
		clear(result.frame.Payload)
	}
	if winner == -1 {
		t.Fatal("authentication race did not admit an owner")
	}

	assertSnapshot := func(peer net.Conn) {
		t.Helper()
		var output []byte
		var dropped uint64
		stage := 0
		for range 8 {
			frame, readErr := protocol.ReadFrame(t.Context(), peer, protocol.PeerBrowser, protocol.StateActiveLeash)
			if readErr != nil {
				t.Fatal(readErr)
			}
			switch frame.Type {
			case protocol.TypeTermReset:
				if stage != 0 {
					t.Fatal("snapshot reset was missing or reordered")
				}
				stage = 1
			case protocol.TypeTermOutput:
				if stage != 1 {
					t.Fatal("snapshot output was missing or reordered")
				}
				output = append(output, frame.Payload...)
			case protocol.TypeOutputDropped:
				if stage != 1 {
					t.Fatal("snapshot drop count was missing or reordered")
				}
				value, decodeErr := protocol.DecodeOutputDropped(frame)
				if decodeErr != nil {
					t.Fatal(decodeErr)
				}
				dropped = value.Bytes
				stage = 2
			case protocol.TypeProcessState:
				if stage != 2 {
					t.Fatal("process state preceded the complete snapshot")
				}
				state, decodeErr := protocol.DecodeProcessState(frame)
				if decodeErr != nil || state.Title != "private-race-task" {
					t.Fatal("admitted owner received the wrong process state", decodeErr)
				}
				clear(frame.Payload)
				if !bytes.Equal(output, privateOutput[len(privateOutput)-leash.MinScrollback:]) || dropped != uint64(len(privateOutput)-leash.MinScrollback) {
					t.Fatal("admitted owner received a gapped, duplicated, or unbounded snapshot")
				}
				clear(output)
				return
			default:
				t.Fatalf("unexpected snapshot frame %d", frame.Type)
			}
			clear(frame.Payload)
		}
		t.Fatal("snapshot exceeded its bounded frame sequence")
	}

	owner := candidates[winner].peer
	assertSnapshot(owner)
	firstLease := host.Authority.Inspect(time.Now()).Owner
	_ = owner.Close()
	waitHostState(t, host, Listening)
	replacement, welcome := connectTestHost(t, host, "leash", testHostID, 2)
	if welcome.Type != protocol.TypeServerWelcome {
		t.Fatal("fresh authenticated stream was not admitted")
	}
	clear(welcome.Payload)
	if next := host.Authority.Inspect(time.Now()).Owner; next == 0 || next == firstLease {
		t.Fatal("disconnect handoff reused the old active lease")
	}
	assertSnapshot(replacement)
	_ = replacement.Close()
	waitForNoConnections(t, host)
}

func TestConcurrentAuthenticatedPeersCannotEvictActiveLease(t *testing.T) {
	host, err := NewHost(t.Context(), Config{
		Mode: "leash", SessionID: testHostID, ReconnectGrace: time.Minute,
		entropy: bytes.NewReader(sequentialEntropy(1024)),
	}, time.Now(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := host.Listen("official", "relay.example.com", time.Now()); err != nil {
		t.Fatal(err)
	}
	owner, response := connectTestHost(t, host, "leash", testHostID, 2)
	if response.Type != protocol.TypeServerWelcome {
		t.Fatal("owner was not admitted")
	}
	before := host.Authority.Inspect(time.Now())
	code, ok := host.AccessCodeForDisplay()
	if !ok {
		t.Fatal("protected Host lost its access code")
	}
	helloPayload, err := json.Marshal(map[string]any{
		"protocol_min": 2, "protocol_max": 2, "session_id": hex.EncodeToString(testHostID[:]), "mode": "leash",
		"client": map[string]string{"name": "parallel-test", "version": "1", "platform": "test", "user_agent": ""},
	})
	if err != nil {
		t.Fatal(err)
	}

	results := make(chan protocol.ErrorCode, MaxPendingAuthentication)
	var group sync.WaitGroup
	for range MaxPendingAuthentication {
		group.Go(func() {
			server, peer := net.Pipe()
			defer peer.Close()
			_ = peer.SetDeadline(time.Now().Add(3 * time.Second))
			if !host.Accept(server) {
				results <- "admission_rejected"
				return
			}
			helloFrame := protocol.Frame{Type: protocol.TypeClientHello, Payload: bytes.Clone(helloPayload)}
			if err := protocol.WriteFrame(t.Context(), peer, protocol.PeerBrowser, protocol.StateAwaitClientHello, helloFrame); err != nil {
				clear(helloFrame.Payload)
				results <- "write_failed"
				return
			}
			clear(helloFrame.Payload)
			challengeFrame, err := protocol.ReadFrame(t.Context(), peer, protocol.PeerBrowser, protocol.StateAwaitServerWelcome)
			if err != nil {
				results <- "read_failed"
				return
			}
			challenge, err := protocol.DecodeAuthChallenge(challengeFrame)
			clear(challengeFrame.Payload)
			if err != nil {
				results <- "challenge_failed"
				return
			}
			proof := AccessProof(code, testHostID, challenge)
			clear(challenge[:])
			proofFrame, err := protocol.AuthProofFrame(proof)
			clear(proof[:])
			if err != nil || protocol.WriteFrame(t.Context(), peer, protocol.PeerBrowser, protocol.StateAwaitAuthProof, proofFrame) != nil {
				clear(proofFrame.Payload)
				results <- "proof_failed"
				return
			}
			clear(proofFrame.Payload)
			rejection, err := protocol.ReadFrame(t.Context(), peer, protocol.PeerBrowser, protocol.StateAwaitServerWelcome)
			if err != nil {
				results <- "rejection_failed"
				return
			}
			got, _ := protocol.ErrorCodeOf(protocol.DecodeError(rejection))
			clear(rejection.Payload)
			results <- got
		})
	}
	group.Wait()
	close(results)
	clear(helloPayload)
	clear(code[:])
	for got := range results {
		if got != protocol.CodeSessionBusy {
			t.Fatalf("parallel authenticated peer returned %s", got)
		}
	}
	after := host.Authority.Inspect(time.Now())
	if after.State != Active || after.Owner != before.Owner || after.Owner == 0 {
		t.Fatal("parallel peers consumed or evicted the owner's active slot")
	}
	_ = owner.Close()
	waitForNoConnections(t, host)
	if err := host.Close("local_revoke"); err != nil {
		t.Fatal(err)
	}
}

func TestLeashBoundsConcurrentPendingAdmissionAndJoinsWorkers(t *testing.T) {
	host, err := NewHost(t.Context(), Config{Mode: "leash", SessionID: testHostID}, time.Now(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := host.Listen("official", "relay.example.com", time.Now()); err != nil {
		t.Fatal(err)
	}
	var accepted atomic.Int32
	var peersMu sync.Mutex
	var peers []net.Conn
	var group sync.WaitGroup
	for range 32 {
		group.Go(func() {
			server, browser := net.Pipe()
			if host.Accept(server) {
				accepted.Add(1)
			}
			peersMu.Lock()
			peers = append(peers, browser)
			peersMu.Unlock()
		})
	}
	group.Wait()
	if accepted.Load() != MaxPendingAuthentication {
		t.Fatalf("accepted %d pending streams, want %d", accepted.Load(), MaxPendingAuthentication)
	}
	if err := host.Close("local_revoke"); err != nil {
		t.Fatal(err)
	}
	for _, peer := range peers {
		_ = peer.Close()
	}
	host.mu.Lock()
	remaining := len(host.connections)
	host.mu.Unlock()
	if remaining != 0 {
		t.Fatal("Host close retained an authentication worker")
	}
}

func TestLeashAuthenticationByteAndTimeBudgets(t *testing.T) {
	t.Run("bytes", func(t *testing.T) {
		host, err := NewHost(t.Context(), Config{Mode: "leash", SessionID: testHostID}, time.Now(), nil)
		if err != nil {
			t.Fatal(err)
		}
		if err := host.Listen("official", "relay.example.com", time.Now()); err != nil {
			t.Fatal(err)
		}
		server, browser := net.Pipe()
		if !host.Accept(server) {
			t.Fatal("Host rejected the bounded test stream")
		}
		wire := make([]byte, authenticationByteLimit+1)
		wire[0], wire[1] = 0, 0
		wire[2], wire[3] = 0x0f, 0xfd
		wire[4] = byte(protocol.TypeClientHello)
		writeDone := make(chan error, 1)
		go func() {
			_, err := browser.Write(wire)
			writeDone <- err
		}()
		response, err := protocol.ReadFrame(t.Context(), browser, protocol.PeerBrowser, protocol.StateAwaitServerWelcome)
		if err != nil || response.Type != protocol.TypeError {
			t.Fatal("byte budget did not return a bounded protocol rejection", err)
		}
		if code, _ := protocol.ErrorCodeOf(protocol.DecodeError(response)); code != protocol.CodeBadFrame {
			t.Fatalf("byte budget rejection = %s", code)
		}
		_ = browser.Close()
		<-writeDone
		waitForNoConnections(t, host)
		if host.InspectMetrics().BytesRX > authenticationByteLimit {
			t.Fatal("pre-admission stream exceeded its receive budget")
		}
		_ = host.Close("local_revoke")
	})

	t.Run("time", func(t *testing.T) {
		synctest.Test(t, func(t *testing.T) {
			host, err := NewHost(t.Context(), Config{Mode: "leash", SessionID: testHostID}, time.Now(), nil)
			if err != nil {
				t.Fatal(err)
			}
			if err := host.Listen("official", "relay.example.com", time.Now()); err != nil {
				t.Fatal(err)
			}
			server, browser := net.Pipe()
			if !host.Accept(server) {
				t.Fatal("Host rejected the timeout test stream")
			}
			synctest.Wait()
			time.Sleep(authenticationLimit - time.Nanosecond)
			host.mu.Lock()
			before := len(host.connections)
			host.mu.Unlock()
			if before != 1 {
				t.Fatal("authentication stream ended before its deadline")
			}
			time.Sleep(time.Nanosecond)
			synctest.Wait()
			var one [1]byte
			if _, err := browser.Read(one[:]); !errors.Is(err, io.EOF) {
				t.Fatal("authentication deadline did not close the stream")
			}
			host.mu.Lock()
			after := len(host.connections)
			host.mu.Unlock()
			if after != 0 {
				t.Fatal("timed-out authentication retained connection state")
			}
			if _, ok := host.AccessCodeForDisplay(); !ok {
				t.Fatal("connection timeout revoked the live share credential")
			}
			if err := host.Close("local_revoke"); err != nil {
				t.Fatal(err)
			}
		})
	})
}

func TestAuthenticationCooldownIsShareWideFiniteAndNonExtending(t *testing.T) {
	host := &Host{}
	now := time.Unix(1_788_500_000, 0)
	var failed, throttled atomic.Int32
	var group sync.WaitGroup
	for range 32 {
		group.Go(func() {
			err := host.authenticationFailure(now)
			code, _ := protocol.ErrorCodeOf(err)
			switch code {
			case protocol.CodeAuthFailed:
				failed.Add(1)
			case protocol.CodeAuthThrottled:
				throttled.Add(1)
			default:
				t.Errorf("unexpected authentication result %s", code)
			}
		})
	}
	group.Wait()
	if failed.Load() != authenticationFailures || throttled.Load() != 22 {
		t.Fatalf("failures=%d throttled=%d", failed.Load(), throttled.Load())
	}
	host.mu.Lock()
	deadline := host.authCooldownUntil
	host.mu.Unlock()
	if !deadline.Equal(now.Add(authenticationCooldown)) {
		t.Fatal("cooldown did not start at the exact shared threshold")
	}
	for _, elapsed := range []time.Duration{0, 15 * time.Second, authenticationCooldown - time.Nanosecond} {
		err := host.authenticationThrottle(now.Add(elapsed))
		var throttledError *protocol.ProtocolError
		if !errors.As(err, &throttledError) || throttledError.Code != protocol.CodeAuthThrottled {
			t.Fatal("cooldown ended before its boundary")
		}
		host.mu.Lock()
		unchanged := host.authCooldownUntil.Equal(deadline)
		host.mu.Unlock()
		if !unchanged {
			t.Fatal("rejected attempt extended the cooldown")
		}
	}
	if err := host.authenticationThrottle(deadline); err != nil {
		t.Fatal("cooldown did not reset at its exact boundary")
	}
	host.mu.Lock()
	failures, cooldown := host.authFailures, host.authCooldownUntil
	host.mu.Unlock()
	if failures != 0 || !cooldown.IsZero() {
		t.Fatal("completed cooldown left a permanent lock")
	}
}

func TestProtectedProofAttemptsUseFreshChallengesAndResetFailures(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		host, err := NewHost(t.Context(), Config{
			Mode: "leash", SessionID: testHostID, ReconnectGrace: time.Minute,
			entropy: bytes.NewReader(sequentialEntropy(1024)),
		}, time.Now(), nil)
		if err != nil {
			t.Fatal(err)
		}
		if err := host.Listen("official", "relay.example.com", time.Now()); err != nil {
			t.Fatal(err)
		}
		var firstChallenge [32]byte
		for attempt := 0; attempt < authenticationFailures; attempt++ {
			challenge, response := authenticationAttempt(t, host, [32]byte{})
			if attempt == 0 {
				firstChallenge = challenge
			} else if attempt == 1 && challenge == firstChallenge {
				t.Fatal("two streams reused one challenge")
			}
			if code, _ := protocol.ErrorCodeOf(protocol.DecodeError(response)); code != protocol.CodeAuthFailed {
				t.Fatalf("wrong proof %d returned %s", attempt+1, code)
			}
		}
		_, response := authenticationAttempt(t, host, [32]byte{})
		throttle := protocol.DecodeError(response)
		var protocolError *protocol.ProtocolError
		if !errors.As(throttle, &protocolError) || protocolError.Code != protocol.CodeAuthThrottled || protocolError.RetryAfterMS != 30_000 {
			t.Fatalf("cooldown rejection = %#v", protocolError)
		}
		time.Sleep(authenticationCooldown)
		code, _ := host.AccessCodeForDisplay()
		challenge, response := authenticationAttemptWithCode(t, host, code)
		clear(code[:])
		clear(challenge[:])
		if response.Type != protocol.TypeServerWelcome {
			t.Fatal("valid proof after cooldown was not admitted")
		}
		host.mu.Lock()
		failures, cooldown := host.authFailures, host.authCooldownUntil
		host.mu.Unlock()
		if failures != 0 || !cooldown.IsZero() {
			t.Fatal("successful proof did not reset share-wide failures")
		}
		if err := host.Close("local_revoke"); err != nil {
			t.Fatal(err)
		}
	})
}

func authenticationAttempt(t *testing.T, host *Host, proof [32]byte) ([32]byte, protocol.Frame) {
	t.Helper()
	server, browser := net.Pipe()
	if !host.Accept(server) {
		t.Fatal("Host rejected authentication attempt")
	}
	writeTestHello(t, browser, "leash", testHostID, 2)
	response, err := protocol.ReadFrame(t.Context(), browser, protocol.PeerBrowser, protocol.StateAwaitServerWelcome)
	if err != nil {
		t.Fatal(err)
	}
	if response.Type == protocol.TypeError {
		_ = browser.Close()
		synctest.Wait()
		return [32]byte{}, response
	}
	challenge, err := protocol.DecodeAuthChallenge(response)
	clear(response.Payload)
	if err != nil {
		t.Fatal(err)
	}
	proofFrame, err := protocol.AuthProofFrame(proof)
	if err != nil {
		t.Fatal(err)
	}
	if err := protocol.WriteFrame(t.Context(), browser, protocol.PeerBrowser, protocol.StateAwaitAuthProof, proofFrame); err != nil {
		t.Fatal(err)
	}
	clear(proofFrame.Payload)
	response, err = protocol.ReadFrame(t.Context(), browser, protocol.PeerBrowser, protocol.StateAwaitServerWelcome)
	if err != nil {
		t.Fatal(err)
	}
	_ = browser.Close()
	synctest.Wait()
	return challenge, response
}

func authenticationAttemptWithCode(t *testing.T, host *Host, code AccessCode) ([32]byte, protocol.Frame) {
	t.Helper()
	server, browser := net.Pipe()
	if !host.Accept(server) {
		t.Fatal("Host rejected authentication attempt")
	}
	writeTestHello(t, browser, "leash", testHostID, 2)
	challengeFrame, err := protocol.ReadFrame(t.Context(), browser, protocol.PeerBrowser, protocol.StateAwaitServerWelcome)
	if err != nil {
		t.Fatal(err)
	}
	challenge, err := protocol.DecodeAuthChallenge(challengeFrame)
	clear(challengeFrame.Payload)
	if err != nil {
		t.Fatal(err)
	}
	proof := AccessProof(code, testHostID, challenge)
	proofFrame, err := protocol.AuthProofFrame(proof)
	clear(proof[:])
	if err != nil {
		t.Fatal(err)
	}
	if err := protocol.WriteFrame(t.Context(), browser, protocol.PeerBrowser, protocol.StateAwaitAuthProof, proofFrame); err != nil {
		t.Fatal(err)
	}
	clear(proofFrame.Payload)
	response, err := protocol.ReadFrame(t.Context(), browser, protocol.PeerBrowser, protocol.StateAwaitServerWelcome)
	if err != nil {
		t.Fatal(err)
	}
	_ = browser.Close()
	synctest.Wait()
	return challenge, response
}

func sequentialEntropy(length int) []byte {
	values := make([]byte, length)
	for index := range values {
		values[index] = byte(index)
	}
	return values
}

func waitForNoConnections(t *testing.T, host *Host) {
	t.Helper()
	deadline := time.NewTimer(time.Second)
	defer deadline.Stop()
	for {
		host.mu.Lock()
		remaining := len(host.connections)
		host.mu.Unlock()
		if remaining == 0 {
			return
		}
		select {
		case <-host.changed:
		case <-deadline.C:
			host.mu.Lock()
			remaining = len(host.connections)
			if remaining == 0 {
				host.mu.Unlock()
				return
			}
			pending, active := 0, 0
			for connection := range host.connections {
				if connection.lease == 0 {
					pending++
				} else {
					active++
				}
			}
			host.mu.Unlock()
			t.Fatalf("Host retained %d connection-local states (%d pending, %d active)", remaining, pending, active)
		}
	}
}
