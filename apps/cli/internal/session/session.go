// Package session owns host authority and browser-slot transitions. Time is an
// explicit input; the composition root owns timers, streams and platform work.
package session

import (
	"crypto/subtle"
	"errors"
	"slices"
	"sync"
	"time"

	"tailmouse/apps/cli/internal/protocol"
)

type State string

const (
	Creating       State = "creating"
	Listening      State = "listening"
	Connecting     State = "connecting"
	Active         State = "active"
	ReconnectGrace State = "reconnect-grace"
	Expired        State = "expired"
	Closed         State = "closed"
)

type Outcome string

const (
	ModeComplete     Outcome = "mode_complete"
	LocalRevoke      Outcome = "local_revoke"
	TTLExpired       Outcome = "expired"
	GraceExpired     Outcome = "grace_expired"
	ProtocolFailure  Outcome = "protocol_error"
	TransportFailure Outcome = "transport_error"
	InternalFailure  Outcome = "internal_error"
)

var ErrInvalidConfig = errors.New("invalid session configuration")
var ErrInvalidTransition = errors.New("invalid session transition")

type Config struct {
	Mode           string
	SessionID      [16]byte
	TTL            time.Duration
	ReconnectGrace time.Duration
	Readonly       bool
	NoRestart      bool
	NoTerminate    bool
}

// Lease is a host-local connection generation, not a reconnect credential.
// Every connection-local queue carries it so an old stream cannot regain access.
type Lease uint64

type Snapshot struct {
	State         State
	Outcome       Outcome
	Owner         Lease
	ExpiresAt     time.Time
	GraceDeadline time.Time
	Reconnects    uint64
}

type Session struct {
	mu             sync.Mutex
	mode           string
	identifier     [16]byte
	readonly       bool
	noRestart      bool
	noTerminate    bool
	capabilities   []string
	grace          time.Duration
	nextLease      Lease
	cleanupStarted bool
	snapshot       Snapshot
}

func New(config Config, now time.Time) (*Session, error) {
	if (config.Mode != "escape" && config.Mode != "leash") || config.SessionID == [16]byte{} || config.TTL < 0 || config.ReconnectGrace < 0 {
		return nil, ErrInvalidConfig
	}
	session := &Session{
		mode: config.Mode, identifier: config.SessionID, readonly: config.Readonly,
		noRestart: config.NoRestart, noTerminate: config.NoTerminate, grace: config.ReconnectGrace,
		snapshot: Snapshot{State: Creating},
	}
	if config.TTL > 0 {
		session.snapshot.ExpiresAt = now.Add(config.TTL)
	}
	if config.Mode == "escape" {
		session.capabilities = []string{"dash", "game_input", "game_view"}
	} else {
		session.capabilities = []string{"terminal_output"}
		if !config.Readonly {
			session.capabilities = append(session.capabilities, "interrupt", "resize", "terminal_input")
			if !config.NoRestart {
				session.capabilities = append(session.capabilities, "restart")
			}
			if !config.NoTerminate {
				session.capabilities = append(session.capabilities, "terminate")
			}
		}
		slices.Sort(session.capabilities)
	}
	return session, nil
}

func (session *Session) Listen(now time.Time) error {
	session.mu.Lock()
	defer session.mu.Unlock()
	session.expire(now)
	if session.snapshot.State != Creating {
		return ErrInvalidTransition
	}
	session.snapshot.State = Listening
	return nil
}

// BeginConnect records transport establishment without reserving the active
// slot. Only Acquire after a valid HELLO may select the first owner.
func (session *Session) BeginConnect(now time.Time) error {
	session.mu.Lock()
	defer session.mu.Unlock()
	session.expire(now)
	switch session.snapshot.State {
	case Listening:
		session.snapshot.State = Connecting
	case Connecting, ReconnectGrace:
	case Active:
		return sessionError(protocol.CodeSessionBusy)
	case Expired, Closed:
		return sessionError(protocol.CodeExpired)
	default:
		return ErrInvalidTransition
	}
	return nil
}

func (session *Session) ConnectFailed() {
	session.mu.Lock()
	defer session.mu.Unlock()
	if session.snapshot.State == Connecting {
		session.snapshot.State = Listening
	}
}

func (session *Session) Acquire(identifier [16]byte, mode string, now time.Time) (Lease, error) {
	session.mu.Lock()
	defer session.mu.Unlock()
	session.expire(now)
	if session.terminal() {
		return 0, sessionError(protocol.CodeExpired)
	}
	if subtle.ConstantTimeCompare(identifier[:], session.identifier[:]) != 1 {
		return 0, sessionError(protocol.CodeBadMouseCard)
	}
	if mode != session.mode {
		return 0, sessionError(protocol.CodeModeMismatch)
	}
	if session.snapshot.State == Active {
		return 0, sessionError(protocol.CodeSessionBusy)
	}
	if session.snapshot.State != Connecting && session.snapshot.State != Listening && session.snapshot.State != ReconnectGrace {
		return 0, ErrInvalidTransition
	}
	if session.snapshot.State == ReconnectGrace {
		session.snapshot.Reconnects++
	}
	session.nextLease++
	session.snapshot.Owner = session.nextLease
	session.snapshot.State = Active
	session.snapshot.GraceDeadline = time.Time{}
	return session.snapshot.Owner, nil
}

// Disconnect ignores stale or repeated notifications from a superseded stream.
func (session *Session) Disconnect(lease Lease, now time.Time) bool {
	session.mu.Lock()
	defer session.mu.Unlock()
	session.expire(now)
	if session.snapshot.State != Active || lease == 0 || session.snapshot.Owner != lease {
		return false
	}
	session.snapshot.State = ReconnectGrace
	session.snapshot.Owner = 0
	session.snapshot.GraceDeadline = now.Add(session.grace)
	session.expire(now)
	return true
}

// Authorize is checked immediately before a mode accepts work. Queued work must
// also carry the lease and be checked by its consumer before a side effect.
func (session *Session) Authorize(lease Lease, capability string, now time.Time) error {
	session.mu.Lock()
	defer session.mu.Unlock()
	session.expire(now)
	if session.terminal() {
		return sessionError(protocol.CodeExpired)
	}
	if session.snapshot.State != Active || lease == 0 || lease != session.snapshot.Owner {
		return sessionError(protocol.CodeUnauthorized)
	}
	if slices.Contains(session.capabilities, capability) {
		return nil
	}
	if session.mode == "leash" {
		if session.readonly && slices.Contains([]string{"interrupt", "resize", "restart", "terminal_input", "terminate"}, capability) {
			return sessionError(protocol.CodeReadonly)
		}
		if capability == "restart" && session.noRestart {
			return sessionError(protocol.CodeRestartDisabled)
		}
		if capability == "terminate" && session.noTerminate {
			return sessionError(protocol.CodeTerminateDisabled)
		}
	}
	return sessionError(protocol.CodeUnauthorized)
}

func (session *Session) Capabilities() []string {
	session.mu.Lock()
	defer session.mu.Unlock()
	return slices.Clone(session.capabilities)
}

func (session *Session) Inspect(now time.Time) Snapshot {
	session.mu.Lock()
	defer session.mu.Unlock()
	session.expire(now)
	return session.snapshot
}

// Finish selects a terminal outcome at most once. TakeCleanup arbitrates actual
// resource cleanup, including when a clock check already selected expiry.
func (session *Session) Finish(outcome Outcome) (bool, error) {
	session.mu.Lock()
	defer session.mu.Unlock()
	switch outcome {
	case ModeComplete, LocalRevoke, ProtocolFailure, TransportFailure, InternalFailure, GraceExpired:
	default:
		return false, ErrInvalidTransition
	}
	if session.terminal() {
		return false, nil
	}
	session.finish(Closed, outcome)
	return true, nil
}

func (session *Session) TakeCleanup() bool {
	session.mu.Lock()
	defer session.mu.Unlock()
	if !session.terminal() || session.cleanupStarted {
		return false
	}
	session.cleanupStarted = true
	return true
}

func (session *Session) expire(now time.Time) {
	if session.terminal() {
		return
	}
	if !session.snapshot.ExpiresAt.IsZero() && !now.Before(session.snapshot.ExpiresAt) {
		session.finish(Expired, TTLExpired)
	} else if session.snapshot.State == ReconnectGrace && !now.Before(session.snapshot.GraceDeadline) {
		session.finish(Closed, GraceExpired)
	}
}

func (session *Session) finish(state State, outcome Outcome) {
	session.snapshot.State, session.snapshot.Outcome = state, outcome
	session.snapshot.Owner = 0
	session.snapshot.GraceDeadline = time.Time{}
	session.identifier = [16]byte{}
	session.capabilities = nil
}

func (session *Session) terminal() bool {
	return session.snapshot.State == Expired || session.snapshot.State == Closed
}
func sessionError(code protocol.ErrorCode) error { return &protocol.ProtocolError{Code: code} }
