package session

import (
	"errors"
	"reflect"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"tailmouse/apps/cli/internal/protocol"
)

func TestSessionTransitionsAndReconnectDropsOldAuthority(t *testing.T) {
	now := time.Unix(1_788_400_000, 0)
	session := newTestSession(t, "escape", now)
	if session.Inspect(now).State != Creating {
		t.Fatal("missing Creating state")
	}
	if _, err := session.Acquire([16]byte{7}, "escape", now); !errors.Is(err, ErrInvalidTransition) {
		t.Fatal("acquired before listening")
	}
	if err := session.BeginConnect(now); !errors.Is(err, ErrInvalidTransition) {
		t.Fatal("connected before listening")
	}
	if err := session.Listen(now); err != nil {
		t.Fatal(err)
	}
	if err := session.Listen(now); !errors.Is(err, ErrInvalidTransition) {
		t.Fatal("listened twice")
	}
	if err := session.BeginConnect(now); err != nil {
		t.Fatal(err)
	}
	if err := session.BeginConnect(now); err != nil {
		t.Fatal(err)
	}
	if session.Inspect(now).State != Connecting {
		t.Fatal("missing Connecting state")
	}
	session.ConnectFailed()
	if session.Inspect(now).State != Listening {
		t.Fatal("failed HELLO retained Connecting state")
	}
	first, err := session.Acquire([16]byte{7}, "escape", now)
	if err != nil || first == 0 {
		t.Fatalf("acquire: %v", err)
	}
	session.ConnectFailed()
	if session.Inspect(now).Owner != first {
		t.Fatal("unrelated handshake failure removed the owner")
	}
	assertCode(t, session.BeginConnect(now), protocol.CodeSessionBusy)
	if err := session.Authorize(first, "game_input", now); err != nil {
		t.Fatal(err)
	}
	assertCode(t, session.Authorize(0, "game_input", now), protocol.CodeUnauthorized)
	if !session.Disconnect(first, now) || session.Disconnect(first, now) {
		t.Fatal("disconnect was not generation-specific and idempotent")
	}
	assertCode(t, session.Authorize(first, "game_input", now), protocol.CodeUnauthorized)
	if session.Inspect(now).State != ReconnectGrace {
		t.Fatal("missing grace state")
	}
	if err := session.BeginConnect(now); err != nil {
		t.Fatal(err)
	}
	second, err := session.Acquire([16]byte{7}, "escape", now.Add(29*time.Second))
	if err != nil || second == first {
		t.Fatalf("replacement: %v", err)
	}
	if session.Disconnect(first, now.Add(29*time.Second)) {
		t.Fatal("old stream disconnected replacement")
	}
	assertCode(t, session.Authorize(first, "game_input", now.Add(29*time.Second)), protocol.CodeUnauthorized)
	if err := session.Authorize(second, "game_input", now.Add(29*time.Second)); err != nil {
		t.Fatal(err)
	}
	state := session.Inspect(now.Add(29 * time.Second))
	if state.State != Active || state.Reconnects != 1 || !state.GraceDeadline.IsZero() {
		t.Fatal("incorrect replacement state")
	}
}

func TestOnlyOneValidHelloAcquiresEachGeneration(t *testing.T) {
	now := time.Unix(1_788_400_000, 0)
	session := newTestSession(t, "leash", now)
	if err := session.Listen(now); err != nil {
		t.Fatal(err)
	}
	for generation := range 2 {
		var successes atomic.Int32
		var wait sync.WaitGroup
		for range 32 {
			wait.Go(func() {
				lease, err := session.Acquire([16]byte{7}, "leash", now)
				if err == nil {
					if lease != Lease(generation+1) {
						t.Error("unexpected owner generation")
					}
					successes.Add(1)
					return
				}
				code, ok := protocol.ErrorCodeOf(err)
				if !ok || code != protocol.CodeSessionBusy {
					t.Error("race loser did not receive SESSION_BUSY")
				}
			})
		}
		wait.Wait()
		if successes.Load() != 1 {
			t.Fatal("slot did not have exactly one owner")
		}
		if !session.Disconnect(session.Inspect(now).Owner, now) {
			t.Fatal("owner could not disconnect")
		}
		state := session.Inspect(now)
		if state.State != Listening || state.Owner != 0 || !state.GraceDeadline.IsZero() {
			t.Fatal("Leash disconnect did not return the share directly to listening")
		}
	}
	if session.Inspect(now).Reconnects != 1 {
		t.Fatal("Leash replacement was not counted exactly once")
	}
}

func TestHostIdentityAndCapabilitiesAreAuthoritative(t *testing.T) {
	now := time.Unix(1_788_400_000, 0)
	for _, test := range []struct {
		name    string
		config  Config
		allowed []string
		denied  map[string]protocol.ErrorCode
	}{
		{"escape", Config{Mode: "escape"}, []string{"dash", "game_input", "game_view"}, map[string]protocol.ErrorCode{"terminal_input": protocol.CodeUnauthorized}},
		{"full leash", Config{Mode: "leash"}, []string{"interrupt", "resize", "restart", "terminal_input", "terminal_output", "terminate"}, map[string]protocol.ErrorCode{"game_input": protocol.CodeUnauthorized}},
		{"readonly", Config{Mode: "leash", Readonly: true}, []string{"terminal_output"}, map[string]protocol.ErrorCode{"interrupt": protocol.CodeReadonly, "resize": protocol.CodeReadonly, "restart": protocol.CodeReadonly, "terminal_input": protocol.CodeReadonly, "terminate": protocol.CodeReadonly, "unknown": protocol.CodeUnauthorized}},
		{"disabled controls", Config{Mode: "leash", NoRestart: true, NoTerminate: true}, []string{"interrupt", "resize", "terminal_input", "terminal_output"}, map[string]protocol.ErrorCode{"restart": protocol.CodeRestartDisabled, "terminate": protocol.CodeTerminateDisabled}},
	} {
		t.Run(test.name, func(t *testing.T) {
			test.config.SessionID = [16]byte{7}
			session, err := New(test.config, now)
			if err != nil {
				t.Fatal(err)
			}
			if err := session.Listen(now); err != nil {
				t.Fatal(err)
			}
			_, err = session.Acquire([16]byte{8}, test.config.Mode, now)
			assertCode(t, err, protocol.CodeBadMouseCard)
			_, err = session.Acquire([16]byte{7}, "wrong", now)
			assertCode(t, err, protocol.CodeModeMismatch)
			lease, err := session.Acquire([16]byte{7}, test.config.Mode, now)
			if err != nil {
				t.Fatal(err)
			}
			caps := session.Capabilities()
			if !reflect.DeepEqual(caps, test.allowed) {
				t.Fatal("capability manifest mismatch")
			}
			caps[0] = "mutated"
			if !reflect.DeepEqual(session.Capabilities(), test.allowed) {
				t.Fatal("caller modified host capability authority")
			}
			for _, capability := range test.allowed {
				if err := session.Authorize(lease, capability, now); err != nil {
					t.Fatal(err)
				}
			}
			for capability, code := range test.denied {
				assertCode(t, session.Authorize(lease, capability, now), code)
			}
		})
	}
}

func TestExpiryAndGraceBoundariesPreserveFirstOutcome(t *testing.T) {
	now := time.Unix(1_788_400_000, 0)
	for _, setup := range []string{"creating", "listening", "active", "grace"} {
		t.Run(setup, func(t *testing.T) {
			session := newTestSession(t, "escape", now)
			var lease Lease
			if setup != "creating" {
				if err := session.Listen(now); err != nil {
					t.Fatal(err)
				}
			}
			if setup == "active" || setup == "grace" {
				var err error
				lease, err = session.Acquire([16]byte{7}, "escape", now)
				if err != nil {
					t.Fatal(err)
				}
			}
			if setup == "grace" {
				session.Disconnect(lease, now.Add(590*time.Second))
			}
			if session.Inspect(now.Add(600*time.Second-time.Nanosecond)).State == Expired {
				t.Fatal("expired before deadline")
			}
			state := session.Inspect(now.Add(600 * time.Second))
			if state.State != Expired || state.Outcome != TTLExpired || state.Owner != 0 {
				t.Fatal("did not expire at TTL boundary")
			}
			assertCode(t, session.Authorize(lease, "game_input", now.Add(600*time.Second)), protocol.CodeExpired)
			_, err := session.Acquire([16]byte{7}, "escape", now.Add(600*time.Second))
			assertCode(t, err, protocol.CodeExpired)
			assertCode(t, session.BeginConnect(now.Add(600*time.Second)), protocol.CodeExpired)
			if changed, err := session.Finish(ProtocolFailure); err != nil || changed {
				t.Fatal("late failure replaced expiry")
			}
			if session.identifier != [16]byte{} || len(session.Capabilities()) != 0 {
				t.Fatal("terminal state retained authority")
			}
			if !session.TakeCleanup() || session.TakeCleanup() {
				t.Fatal("expiry cleanup did not have exactly one owner")
			}
		})
	}
	session := newTestSession(t, "escape", now)
	if err := session.Listen(now); err != nil {
		t.Fatal(err)
	}
	lease, err := session.Acquire([16]byte{7}, "escape", now)
	if err != nil {
		t.Fatal(err)
	}
	session.Disconnect(lease, now)
	_, err = session.Acquire([16]byte{7}, "escape", now.Add(30*time.Second))
	assertCode(t, err, protocol.CodeExpired)
	if session.Inspect(now.Add(30*time.Second)).Outcome != GraceExpired {
		t.Fatal("grace boundary outcome mismatch")
	}
}

func TestHostLifetimeAndIdempotentTerminalTransitions(t *testing.T) {
	now := time.Unix(1_788_400_000, 0)
	for _, reason := range []Outcome{ModeComplete, LocalRevoke, ProtocolFailure, TransportFailure} {
		session, err := New(Config{Mode: "leash", SessionID: [16]byte{7}}, now)
		if err != nil {
			t.Fatal(err)
		}
		if session.TakeCleanup() {
			t.Fatal("cleaned up a live session")
		}
		if !session.Inspect(now.Add(1000*time.Hour)).ExpiresAt.IsZero() || session.Inspect(now.Add(1000*time.Hour)).State != Creating {
			t.Fatal("zero TTL was not host lifetime")
		}
		if changed, err := session.Finish(reason); err != nil || !changed {
			t.Fatal("first finish failed")
		}
		var cleanups atomic.Int32
		var wait sync.WaitGroup
		for range 16 {
			wait.Go(func() {
				if changed, err := session.Finish(reason); err != nil || changed {
					t.Error("finish was not idempotent")
				}
				if session.TakeCleanup() {
					cleanups.Add(1)
				}
			})
		}
		wait.Wait()
		if cleanups.Load() != 1 || session.Inspect(now).Outcome != reason || session.Inspect(now).State != Closed {
			t.Fatal("terminal outcome or cleanup count changed")
		}
	}
}

func TestInvalidConfigurationAndZeroGrace(t *testing.T) {
	now := time.Unix(1_788_400_000, 0)
	for _, config := range []Config{{}, {Mode: "other", SessionID: [16]byte{7}}, {Mode: "escape"}, {Mode: "escape", SessionID: [16]byte{7}, TTL: -1}, {Mode: "leash", SessionID: [16]byte{7}, ReconnectGrace: -1}} {
		if _, err := New(config, now); !errors.Is(err, ErrInvalidConfig) {
			t.Fatal("invalid configuration accepted")
		}
	}
	session, err := New(Config{Mode: "escape", SessionID: [16]byte{7}}, now)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := session.Finish("unknown"); !errors.Is(err, ErrInvalidTransition) {
		t.Fatal("unknown outcome accepted")
	}
	if err := session.Listen(now); err != nil {
		t.Fatal(err)
	}
	lease, err := session.Acquire([16]byte{7}, "escape", now)
	if err != nil {
		t.Fatal(err)
	}
	session.Disconnect(lease, now)
	if session.Inspect(now).State != Closed || session.Inspect(now).Outcome != GraceExpired {
		t.Fatal("zero grace did not close immediately")
	}
}

func newTestSession(t *testing.T, mode string, now time.Time) *Session {
	t.Helper()
	session, err := New(Config{Mode: mode, SessionID: [16]byte{7}, TTL: 10 * time.Minute, ReconnectGrace: 30 * time.Second}, now)
	if err != nil {
		t.Fatal(err)
	}
	return session
}

func assertCode(t *testing.T, err error, expected protocol.ErrorCode) {
	t.Helper()
	code, ok := protocol.ErrorCodeOf(err)
	if !ok || code != expected {
		t.Fatalf("code = %q, expected %q", code, expected)
	}
}
