package escape

import (
	"errors"
	"time"
)

const (
	InputDecayAfter          = 150 * time.Millisecond
	InputStopAfter           = 500 * time.Millisecond
	InputPauseAfter          = 3 * time.Second
	InputGrace               = 30 * time.Second
	SnapshotInterval         = 100 * time.Millisecond
	MaxPendingDash           = 8
	ConnectionLost   Outcome = "connection_lost"
)

var ErrInputBackpressure = errors.New("escape discrete input queue is full")

type pendingDash struct {
	direction Point
	received  time.Time
}

// Round adds receipt-time policy to the fixed-step core. Its single owner calls
// Tick at 30 Hz and serializes Accept with it; it owns no worker, timer or I/O.
// Creation is deferred until the first authorized player has connected.
type Round struct {
	engine                       *Engine
	now, lastInput, lastSnapshot time.Time
	direction                    Point
	accepted                     uint32
	paused                       bool
	dashes                       [MaxPendingDash]pendingDash
	dashCount                    int
}

type RoundState struct {
	State
	AcceptedSequence uint32
	Paused           bool
	PendingDash      int
}

type RoundUpdate struct {
	Update
	Paused       bool
	PauseChanged bool
	DashRejected bool
	SnapshotDue  bool
}

func NewRound(name string, seed int64, duration time.Duration, now time.Time) (*Round, error) {
	engine, err := New(name, seed, duration)
	if err != nil {
		return nil, err
	}
	return &Round{engine: engine, now: now, lastInput: now, lastSnapshot: now}, nil
}

func (round *Round) Inspect() RoundState {
	return RoundState{State: round.engine.Inspect(), AcceptedSequence: round.accepted, Paused: round.paused, PendingDash: round.dashCount}
}

func (round *Round) Map() Map { return round.engine.Map() }

func (round *Round) Scent() ([ScentCapacity]ScentPoint, int) { return round.engine.Scent() }

// Accept is called only after the session verifies the active connection lease
// and capability. Duplicate/stale input cannot refresh the silence deadline.
// Client timestamps are deliberately absent from this API.
func (round *Round) Accept(now time.Time, sequence uint32, input Input) (bool, error) {
	if sequence == 0 || !validDirection(input.Direction) || now.Before(round.now) {
		return false, ErrInvalidInput
	}
	if sequence <= round.accepted || round.engine.state.Phase == Finished || now.Sub(round.lastInput) >= InputGrace {
		return false, nil
	}
	if input.Dash && round.dashCount == MaxPendingDash {
		return false, ErrInputBackpressure
	}
	round.now, round.lastInput, round.accepted = now, now, sequence
	round.direction = normalized(input.Direction)
	if input.Dash {
		round.dashes[round.dashCount] = pendingDash{direction: round.direction, received: now}
		round.dashCount++
	}
	return true, nil
}

// ForgetConnection revokes queued discrete work; the last accepted movement
// still follows the PRD decay/stop deadline rather than moving indefinitely.
// The next lease continues the accepted sequence advertised in its snapshot.
func (round *Round) ForgetConnection() {
	clear(round.dashes[:])
	round.dashCount = 0
}

func (round *Round) Tick(now time.Time, rtt time.Duration) (RoundUpdate, error) {
	if now.Before(round.now) || rtt < 0 {
		return RoundUpdate{}, ErrInvalidInput
	}
	round.now = now
	output := RoundUpdate{Update: Update{State: round.engine.Inspect()}, Paused: round.paused}
	if output.State.Phase == Finished {
		return output, nil
	}
	if elapsed := now.Sub(round.lastSnapshot); elapsed >= SnapshotInterval {
		output.SnapshotDue = true
		// Preserve cadence across tick jitter without replaying missed snapshots.
		round.lastSnapshot = now.Add(-(elapsed % SnapshotInterval))
	}
	age := now.Sub(round.lastInput)
	if age >= InputGrace {
		round.engine.state.Phase, round.engine.state.Outcome = Finished, ConnectionLost
		round.ForgetConnection()
		output.State, output.Result = round.engine.Inspect(), ConnectionLost
		return output, nil
	}
	paused := age >= InputPauseAfter
	output.PauseChanged, output.Paused, round.paused = paused != round.paused, paused, paused
	if paused {
		return output, nil
	}
	input := Input{Direction: decayedDirection(round.direction, age)}
	if round.dashCount > 0 {
		dash := round.dashes[0]
		copy(round.dashes[:], round.dashes[1:round.dashCount])
		round.dashCount--
		round.dashes[round.dashCount] = pendingDash{}
		if now.Sub(dash.received) < InputStopAfter {
			input.Direction, input.Dash = decayedDirection(dash.direction, now.Sub(dash.received)), true
		}
		output.DashRejected = true
	}
	update, err := round.engine.Step(input, rtt)
	if err != nil {
		return RoundUpdate{}, err
	}
	output.Update = update
	output.DashRejected = output.DashRejected && !update.DashStarted
	if update.Result != "" {
		round.ForgetConnection()
	}
	return output, nil
}

func decayedDirection(direction Point, age time.Duration) Point {
	if age <= InputDecayAfter {
		return direction
	}
	factor := float32(max(0, InputStopAfter-age)) / float32(InputStopAfter-InputDecayAfter)
	return Point{X: direction.X * factor, Y: direction.Y * factor}
}
