package session

import (
	"context"
	"errors"
	"math"
	"net"
	"sync"
	"testing"
	"testing/synctest"
	"time"

	"tailmouse/apps/cli/internal/escape"
	"tailmouse/apps/cli/internal/protocol"
)

func liveGameHost(t *testing.T, once bool) (*Host, <-chan Outcome) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	host, err := NewHost(ctx, Config{Mode: "escape", SessionID: testHostID, TTL: 90 * time.Second, ReconnectGrace: 30 * time.Second}, time.Now(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := host.ConfigureEscape(EscapeConfig{Map: "courtyard", Seed: -42, Round: escape.DefaultRound, Once: once, Control: "touch", PhoneRender: true, ShowNet: true}); err != nil {
		t.Fatal(err)
	}
	if err := host.Listen("custom-host", "relay.example.test", time.Now()); err != nil {
		t.Fatal(err)
	}
	done := make(chan Outcome, 1)
	joined := make(chan struct{})
	go func() {
		defer close(joined)
		outcome := host.Wait(ctx)
		reason := "mode_complete"
		if outcome == GraceExpired || outcome == TTLExpired {
			reason = "expired"
		}
		_ = host.Close(reason)
		done <- outcome
	}()
	t.Cleanup(func() { cancel(); _ = host.Close("local_revoke"); <-joined })
	return host, done
}

type gameTestPeer struct {
	conn         net.Conn
	mu           sync.Mutex
	writeMu      sync.Mutex
	frames       []protocol.Frame
	done         chan struct{}
	result       chan protocol.GameResult
	withholdPong bool
}

func gamePeer(t *testing.T, host *Host) *gameTestPeer {
	t.Helper()
	conn, welcome := connectTestHost(t, host, "escape", testHostID, 1)
	if welcome.Type != protocol.TypeServerWelcome {
		t.Fatal("game negotiation failed")
	}
	_ = conn.SetDeadline(time.Time{})
	peer := &gameTestPeer{conn: conn, done: make(chan struct{}), result: make(chan protocol.GameResult, 2)}
	go func() {
		defer close(peer.done)
		defer conn.Close()
		for {
			frame, err := protocol.ReadFrame(context.Background(), conn, protocol.PeerBrowser, protocol.StateActiveEscape)
			if err != nil {
				return
			}
			peer.mu.Lock()
			if len(peer.frames) >= 1024 {
				peer.mu.Unlock()
				t.Error("test peer exceeded its bounded frame capture")
				return
			}
			peer.frames = append(peer.frames, frame)
			peer.mu.Unlock()
			switch frame.Type {
			case protocol.TypePing:
				peer.mu.Lock()
				withhold := peer.withholdPong
				peer.mu.Unlock()
				if withhold {
					continue
				}
				if peer.send(protocol.Frame{Type: protocol.TypePong, Payload: frame.Payload}) != nil {
					return
				}
			case protocol.TypeGameResult:
				result, err := protocol.DecodeGameResult(frame)
				if err != nil {
					t.Error(err)
					return
				}
				peer.result <- result
			case protocol.TypeClose:
				ack, _ := protocol.CloseFrame("normal")
				_ = peer.send(ack)
				return
			}
		}
	}()
	t.Cleanup(func() { _ = conn.Close(); <-peer.done })
	synctest.Wait()
	return peer
}

func TestEscapeSpectatorValuesAndRestartBarrier(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		host, _ := liveGameHost(t, false)
		if view := host.InspectEscapeView(); view.Started || view.CanRestart {
			t.Fatal("unconnected round is visible")
		}
		if host.RestartEscape() == nil {
			t.Fatal("restart accepted without a result")
		}
		peer := gamePeer(t, host)
		peer.mu.Lock()
		peer.withholdPong = true
		peer.mu.Unlock()
		expiry := host.Authority.Inspect(time.Now()).ExpiresAt
		initial := host.InspectEscapeView()
		stop := keepGameInput(t, peer)
		<-peer.result
		stop()
		synctest.Wait()
		before := host.InspectEscapeView()
		if !before.CanRestart || before.Result.Outcome == "" || before.Round != 1 || before.Inputs == 0 || before.Snapshots == 0 || before.ScentCount == 0 {
			t.Fatal("spectator snapshot omitted live game data")
		}
		before.State.Mouse.X = -1
		before.Scent[0].Position.X = -1
		before.Map.Rows[1] = "mutated"
		if current := host.InspectEscapeView(); current.State.Mouse.X < 0 || current.Scent[0].Position.X < 0 || current.Map.Rows[1] == "mutated" {
			t.Fatal("spectator values alias game state")
		}
		if err := host.RestartEscape(); err != nil {
			t.Fatal(err)
		}
		if err := host.RestartEscape(); err != nil {
			t.Fatal(err)
		}
		if view := host.InspectEscapeView(); !view.RestartPending || view.Round != 1 {
			t.Fatal("restart skipped the previous-round stream barrier")
		}
		oldSequence := host.InspectEscapeView().State.AcceptedSequence + 1
		peer.movement(t, oldSequence, 1, 0, true)
		time.Sleep(time.Second)
		synctest.Wait()
		var ping protocol.Frame
		peer.mu.Lock()
		for _, frame := range peer.frames {
			if frame.Type == protocol.TypePing {
				ping = frame
			}
		}
		peer.mu.Unlock()
		if len(ping.Payload) != 16 {
			t.Fatal("regular post-result ping missing")
		}
		// Only a validated post-result ping is a barrier; unsolicited data and
		// stale connection callbacks must have no effect.
		host.game.mu.Lock()
		payload := append([]byte(nil), host.game.resultPing[:]...)
		host.game.mu.Unlock()
		bad := append([]byte(nil), payload...)
		bad[15] ^= 1
		if err := host.game.pong(&hostConnection{}, payload); err != nil {
			t.Fatal(err)
		}
		if err := peer.send(protocol.Frame{Type: protocol.TypePong, Payload: bad}); err != nil {
			t.Fatal(err)
		}
		synctest.Wait()
		if !host.InspectEscapeView().RestartPending {
			t.Fatal("invalid pong released restart")
		}
		if err := peer.send(protocol.Frame{Type: protocol.TypePong, Payload: payload}); err != nil {
			t.Fatal(err)
		}
		synctest.Wait()
		after := host.InspectEscapeView()
		if after.RestartPending || after.Round != 2 || after.Result.Outcome != "" || after.State.AcceptedSequence != 0 || after.State.PendingDash != 0 || after.State.Tick != 0 || after.Map != initial.Map || after.State.Mouse != initial.State.Mouse || after.ScentCount != 0 || after.Inputs != before.Inputs {
			t.Fatal("restart retained old input or changed deterministic configuration")
		}
		if host.Authority.Inspect(time.Now()).ExpiresAt != expiry {
			t.Fatal("restart extended session TTL")
		}
		if peer.count(protocol.TypeGameInit) != 2 {
			t.Fatal("repeated restart queued multiple rounds")
		}
		peer.mu.Lock()
		lastInit := 0
		for index, frame := range peer.frames {
			if frame.Type == protocol.TypeGameInit {
				lastInit = index
			}
		}
		ordered := len(peer.frames) > lastInit+2 && peer.frames[lastInit+1].Type == protocol.TypeGameSnapshot && peer.frames[lastInit+2].Type == protocol.TypeGameEvent
		peer.mu.Unlock()
		if !ordered {
			t.Fatal("new initialization did not precede state and countdown")
		}
		peer.movement(t, oldSequence+1, 0, 0, false)
		time.Sleep(100 * time.Millisecond)
		synctest.Wait()
		if host.InspectEscapeView().State.Tick != 3 {
			t.Fatal("restart did not resume the host ticker")
		}
	})
}

func TestEscapeRestartAfterAcknowledgementOrDisconnect(t *testing.T) {
	for _, disconnect := range []bool{false, true} {
		synctest.Test(t, func(t *testing.T) {
			host, _ := liveGameHost(t, false)
			peer := gamePeer(t, host)
			stop := keepGameInput(t, peer)
			<-peer.result
			stop()
			synctest.Wait()
			if disconnect {
				peer.mu.Lock()
				peer.withholdPong = true
				peer.mu.Unlock()
				if err := host.RestartEscape(); err != nil {
					t.Fatal(err)
				}
				_ = peer.conn.Close()
				<-peer.done
				synctest.Wait()
				if view := host.InspectEscapeView(); view.Started || view.Result.Outcome != "" || view.RestartPending {
					t.Fatal("disconnected restart retained old round")
				}
				gamePeer(t, host)
			} else {
				time.Sleep(time.Second)
				synctest.Wait()
				if err := host.RestartEscape(); err != nil {
					t.Fatal(err)
				}
				synctest.Wait()
			}
			if view := host.InspectEscapeView(); !view.Started || view.Round != 2 || view.Result.Outcome != "" {
				t.Fatal("retained session did not start its next round")
			}
		})
	}
}

func TestEscapePendingRestartAfterHeartbeatLossRequiresFreshConnection(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		host, _ := liveGameHost(t, false)
		peer := gamePeer(t, host)
		started := time.Now()
		peer.mu.Lock()
		peer.withholdPong = true
		peer.mu.Unlock()
		stop := keepGameInput(t, peer)
		<-peer.result
		stop()
		if err := host.RestartEscape(); err != nil {
			t.Fatal(err)
		}
		synctest.Wait()
		if !host.InspectEscapeView().RestartPending {
			t.Fatal("restart did not await its ordered PONG boundary")
		}
		// PRD 7.4 now closes a silent peer before the 60-sample ping window
		// can age out. A pending restart must cross a new connection instead.
		time.Sleep(time.Until(started.Add(30 * time.Second)))
		synctest.Wait()
		if host.Authority.Inspect(time.Now()).State != ReconnectGrace {
			t.Fatal("heartbeat loss did not enter reconnect grace")
		}
		<-peer.done
		peer.mu.Lock()
		var latest []byte
		for _, frame := range peer.frames {
			if frame.Type == protocol.TypePing {
				latest = frame.Payload
			}
		}
		peer.mu.Unlock()
		if err := peer.send(protocol.Frame{Type: protocol.TypePong, Payload: latest}); err == nil {
			t.Fatal("lost stream still accepted a late PONG")
		}
		gamePeer(t, host)
		synctest.Wait()
		if view := host.InspectEscapeView(); view.RestartPending || view.Round != 2 {
			t.Fatal("fresh connection did not complete the pending restart")
		}
	})
}

func (peer *gameTestPeer) send(frame protocol.Frame) error {
	peer.writeMu.Lock()
	defer peer.writeMu.Unlock()
	return protocol.WriteFrame(context.Background(), peer.conn, protocol.PeerBrowser, protocol.StateActiveEscape, frame)
}

func (peer *gameTestPeer) count(kind protocol.MessageType) int {
	peer.mu.Lock()
	defer peer.mu.Unlock()
	count := 0
	for _, frame := range peer.frames {
		if frame.Type == kind {
			count++
		}
	}
	return count
}

func (peer *gameTestPeer) movement(t *testing.T, sequence uint32, x, y float32, dash bool) {
	t.Helper()
	frame, err := protocol.GameInputFrame(protocol.GameInput{Sequence: sequence, VelocityX: x, VelocityY: y, Dash: dash})
	if err != nil {
		t.Fatal(err)
	}
	if err := peer.send(frame); err != nil {
		t.Fatal(err)
	}
	synctest.Wait()
}

func keepGameInput(t *testing.T, peer *gameTestPeer) func() {
	t.Helper()
	stop, done := make(chan struct{}), make(chan struct{})
	go func() {
		defer close(done)
		timer := time.NewTicker(50 * time.Millisecond)
		defer timer.Stop()
		var sequence uint32
		for {
			select {
			case <-stop:
				return
			case <-peer.done:
				return
			case <-timer.C:
				sequence++
				frame, _ := protocol.GameInputFrame(protocol.GameInput{Sequence: sequence})
				if peer.send(frame) != nil {
					return
				}
			}
		}
	}()
	var once sync.Once
	finish := func() { once.Do(func() { close(stop); <-done }) }
	t.Cleanup(finish)
	return finish
}

func TestEscapeConfigurationAndInitialization(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		host, err := NewHost(context.Background(), Config{Mode: "escape", SessionID: testHostID}, time.Now(), nil)
		if err != nil {
			t.Fatal(err)
		}
		if _, ok := host.InspectEscape(); ok {
			t.Fatal("unconfigured game exists")
		}
		if err := host.ConfigureEscape(EscapeConfig{Map: "invalid", Round: escape.DefaultRound}); !errors.Is(err, escape.ErrInvalidMap) {
			t.Fatal(err)
		}
		config := EscapeConfig{Map: "pantry", Seed: math.MinInt64, Round: 30*time.Second + time.Nanosecond, Control: "tilt"}
		invalid := config
		invalid.Control = "unsupported"
		if err := host.ConfigureEscape(invalid); !errors.Is(err, ErrInvalidConfig) {
			t.Fatal("invalid control accepted")
		}
		if err := host.ConfigureEscape(config); err != nil {
			t.Fatal(err)
		}
		if err := host.ConfigureEscape(config); !errors.Is(err, ErrInvalidTransition) {
			t.Fatal("duplicate configuration accepted")
		}
		if _, ok := host.InspectEscape(); ok {
			t.Fatal("round started before negotiation")
		}
		if err := host.Listen("official", "official", time.Now()); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = host.Close("local_revoke") })
		peer := gamePeer(t, host)
		peer.mu.Lock()
		frames := append([]protocol.Frame(nil), peer.frames...)
		peer.mu.Unlock()
		if len(frames) != 3 || frames[0].Type != protocol.TypeGameInit || frames[1].Type != protocol.TypeGameSnapshot || frames[2].Type != protocol.TypeGameEvent {
			t.Fatal("initial game frame order changed")
		}
		init, err := protocol.DecodeGameInit(frames[0])
		if err != nil || init.Seed != "-9223372036854775808" || init.Map.Name != "pantry" || init.RoundDurationMS != 30001 || init.Presentation != (protocol.GamePresentation{Control: "tilt"}) {
			t.Fatal("CLI policy did not reach initialization", err)
		}
		snapshot, err := protocol.DecodeGameSnapshot(frames[1])
		if err != nil || snapshot.Sequence != 1 || snapshot.AcceptedInputSequence != 0 || snapshot.RemainingMS != 30001 {
			t.Fatal("initial snapshot invalid", err)
		}
		if err := host.ConfigureEscape(config); !errors.Is(err, ErrInvalidTransition) {
			t.Fatal("live reconfiguration accepted")
		}
	})
}

func TestEscapeLiveSchedulerInputSnapshotsPingAndResult(t *testing.T) {
	for _, once := range []bool{false, true} {
		synctest.Test(t, func(t *testing.T) {
			host, done := liveGameHost(t, once)
			peer := gamePeer(t, host)
			stopInput := keepGameInput(t, peer)
			time.Sleep(3 * time.Second)
			synctest.Wait()
			state, _ := host.InspectEscape()
			if state.Phase != escape.Running || state.Tick != 90 || state.AcceptedSequence != 60 {
				t.Fatalf("scheduler state: phase=%s tick=%d accepted=%d", state.Phase, state.Tick, state.AcceptedSequence)
			}
			if snapshots := peer.count(protocol.TypeGameSnapshot); snapshots < 29 || snapshots > 31 {
				t.Fatalf("snapshot cadence = %d", snapshots)
			}
			if peer.count(protocol.TypePing) != 3 {
				t.Fatal("game traffic changed one-hertz ping")
			}
			select {
			case result := <-peer.result:
				if result.Outcome != "caught" && result.Outcome != "timeout" {
					t.Fatal("unexpected authoritative outcome")
				}
				if result.Relay != "relay.example.test" || result.ElapsedMS <= 0 || result.ElapsedMS > 45000 || result.JitterMS == nil {
					t.Fatal("result omitted authoritative summary")
				}
			case <-time.After(46 * time.Second):
				t.Fatal("round never completed")
			}
			stopInput()
			synctest.Wait()
			if once {
				if outcome := <-done; outcome != ModeComplete {
					t.Fatal(outcome)
				}
				if peer.count(protocol.TypeClose) != 1 {
					t.Fatal("once omitted close after result")
				}
			} else {
				before, _ := host.InspectEscape()
				time.Sleep(time.Second)
				synctest.Wait()
				after, _ := host.InspectEscape()
				if before != after || host.Authority.Inspect(time.Now()).State != Active {
					t.Fatal("retained result changed or closed")
				}
				select {
				case <-done:
					t.Fatal("non-once session ended at round completion")
				default:
				}
			}
			if peer.count(protocol.TypeGameResult) != 1 {
				t.Fatal("round result emitted more than once")
			}
		})
	}
}

func TestEscapeDisconnectPauseReconnectAndSilenceGrace(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		host, done := liveGameHost(t, false)
		peer := gamePeer(t, host)
		stop := keepGameInput(t, peer)
		time.Sleep(3 * time.Second)
		synctest.Wait()
		stop()
		peer.movement(t, 61, 1, 0, false)
		time.Sleep(500 * time.Millisecond)
		synctest.Wait()
		stopped, _ := host.InspectEscape()
		time.Sleep(time.Second)
		synctest.Wait()
		later, _ := host.InspectEscape()
		if later.Mouse != stopped.Mouse || later.Elapsed <= stopped.Elapsed {
			t.Fatal("mouse failed to stop independently of world clock")
		}
		// Duplicate input and PING/PONG do not reset receipt time.
		peer.movement(t, 61, -1, 0, true)
		time.Sleep(2 * time.Second)
		synctest.Wait()
		paused, _ := host.InspectEscape()
		if !paused.Paused || paused.AcceptedSequence != 61 {
			t.Fatal("silence did not pause")
		}
		time.Sleep(time.Second)
		synctest.Wait()
		frozen, _ := host.InspectEscape()
		if frozen.State != paused.State {
			t.Fatal("paused world changed")
		}
		_ = peer.conn.Close()
		<-peer.done
		synctest.Wait()
		if host.Authority.Inspect(time.Now()).State != ReconnectGrace {
			t.Fatal("disconnect lost grace")
		}
		replacement := gamePeer(t, host)
		replacement.mu.Lock()
		firstSnapshot, err := protocol.DecodeGameSnapshot(replacement.frames[1])
		replacement.mu.Unlock()
		if err != nil || firstSnapshot.AcceptedInputSequence != 61 || firstSnapshot.Phase != 2 {
			t.Fatal("reconnect lost paused authority", err)
		}
		replacement.movement(t, 62, 0, 0, false)
		time.Sleep(40 * time.Millisecond)
		synctest.Wait()
		resumed, _ := host.InspectEscape()
		if resumed.Paused || resumed.Elapsed <= paused.Elapsed || resumed.Elapsed-paused.Elapsed > 70*time.Millisecond {
			t.Fatal("resume replayed lost time")
		}
		// Keep the transport open: the application silence deadline must still end it.
		if outcome := <-done; outcome != GraceExpired {
			t.Fatal("silence grace did not use expiry outcome", outcome)
		}
		if result := <-replacement.result; result.Outcome != "connection_lost" {
			t.Fatal("silence result missing")
		}
		if replacement.count(protocol.TypeGameResult) != 1 {
			t.Fatal("silence emitted duplicate result")
		}
	})
}

func TestEscapeSlowWriterDoesNotBlockSimulationOrGrowSnapshotBacklog(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		host, _ := liveGameHost(t, false)
		browser, _ := connectTestHost(t, host, "escape", testHostID, 1)
		_ = browser.SetDeadline(time.Time{})
		synctest.Wait()
		time.Sleep(time.Second)
		synctest.Wait()
		state, _ := host.InspectEscape()
		if state.Tick != 30 {
			t.Fatal("blocked socket stalled simulation")
		}
		func() {
			host.game.mu.Lock()
			defer host.game.mu.Unlock()
			count, newest := 0, uint32(0)
			for _, frame := range host.game.queue {
				if frame.Type == protocol.TypeGameSnapshot {
					count++
					snapshot, _ := protocol.DecodeGameSnapshot(frame)
					newest = snapshot.Sequence
				}
			}
			if count != 1 || newest < 9 || len(host.game.queue) > maxGameOutput {
				t.Fatal("snapshot backlog was not coalesced")
			}
			if host.game.queue[0].Type != protocol.TypeGameSnapshot {
				t.Fatal("coalescing reordered initialization")
			}
			connection := host.game.connection
			for range maxGameOutput + 1 {
				if err := host.game.event("dash_rejected", 100, false); err != nil {
					t.Fatal(err)
				}
			}
			if len(host.game.queue) > maxGameOutput || connection.ctx.Err() == nil {
				t.Fatal("overflow did not cancel bounded delivery")
			}
		}()
		synctest.Wait()
		if host.Authority.Inspect(time.Now()).State != ReconnectGrace {
			t.Fatal("slow connection retained ownership")
		}
	})
}

func TestEscapeRejectsStaleLeasesAndHonorsCapabilitiesBeforeInput(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		host, done := liveGameHost(t, false)
		peer := gamePeer(t, host)
		host.Authority.mu.Lock()
		host.Authority.capabilities = []string{"game_input", "game_view"}
		host.Authority.mu.Unlock()
		peer.movement(t, 1, 1, 0, true)
		state, _ := host.InspectEscape()
		if state.AcceptedSequence != 0 || peer.count(protocol.TypeError) != 1 {
			t.Fatal("unauthorized dash had an effect")
		}
		frame, _ := protocol.GameInputFrame(protocol.GameInput{Sequence: 2})
		if err := host.game.input(&hostConnection{lease: 99}, frame); err == nil {
			t.Fatal("old lease accepted")
		}
		peer.movement(t, 2, 0, 0, false)
		exit, _ := protocol.GameEventFrame(protocol.GameEvent{Sequence: 1, Event: "exit_requested"}, protocol.PeerBrowser)
		if err := peer.send(exit); err != nil {
			t.Fatal(err)
		}
		if outcome := <-done; outcome != ModeComplete {
			t.Fatal("exit request did not end owner session", outcome)
		}
	})
}
