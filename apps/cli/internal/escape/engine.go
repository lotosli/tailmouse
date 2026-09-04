package escape

import (
	"errors"
	"math"
	"time"
)

const (
	SimulationHz    = 30
	MouseSpeed      = 6.0
	CatBaseSpeed    = 5.3
	CatMaxSpeed     = 6.2
	CaptureDistance = 0.55
	DashMultiplier  = 2.2
	DashDuration    = 350 * time.Millisecond
	DashCooldown    = 5 * time.Second
	Countdown       = 3 * time.Second
	MinRound        = 30 * time.Second
	DefaultRound    = 45 * time.Second
	MaxRound        = DefaultRound
)

var (
	ErrInvalidRound = errors.New("invalid escape round duration")
	ErrInvalidInput = errors.New("invalid escape input")
)

type Phase string

const (
	CountingDown Phase = "countdown"
	Running      Phase = "running"
	Finished     Phase = "finished"
)

type Outcome string

const (
	Escaped  Outcome = "escaped"
	Caught   Outcome = "caught"
	TimedOut Outcome = "timeout"
)

// Input is intent, never a client-supplied world position. Dash is one event.
type Input struct {
	Direction Point
	Dash      bool
}

// State is an immutable value snapshot in simulation time, not a wire payload.
type State struct {
	Tick               uint32
	Phase              Phase
	Elapsed            time.Duration
	Remaining          time.Duration
	CountdownRemaining time.Duration
	Mouse              Point
	Cat                Point
	CatTarget          Point
	CatSpeed           float32
	Cheese             [2]bool
	DashRemaining      time.Duration
	DashCooldown       time.Duration
	Outcome            Outcome
}

func (state State) ExitOpen() bool { return state.Cheese[0] && state.Cheese[1] }

// Update contains only transitions from this step. A completed engine never
// emits a second Result, cheese collection, or dash event.
type Update struct {
	State       State
	CheeseMask  uint8
	DashStarted bool
	Result      Outcome
}

// Engine has one owner. It performs bounded work with no wall clock, timers,
// goroutines, I/O or transport dependency. The host schedules Step at 30 Hz.
type Engine struct {
	layout      Map
	state       State
	dashUntil   time.Duration
	dashReadyAt time.Duration
	scent       scentHistory
	pursuit     catPursuit
}

func New(name string, seed int64, round time.Duration) (*Engine, error) {
	if round < MinRound || round > MaxRound {
		return nil, ErrInvalidRound
	}
	layout, err := SelectMap(name, seed)
	if err != nil {
		return nil, err
	}
	return &Engine{
		layout: layout,
		state: State{
			Phase: CountingDown, Remaining: round, CountdownRemaining: Countdown,
			Mouse: layout.Mouse, Cat: layout.Cat, CatTarget: layout.Mouse, CatSpeed: CatBaseSpeed,
		},
	}, nil
}

func (engine *Engine) Inspect() State { return engine.state }
func (engine *Engine) Map() Map       { return engine.layout }

// Step advances exactly one rational 1/30-second interval. Invalid intent is
// rejected before time, positions or events change. Calls after completion are
// idempotent; external scheduling pauses do not silently fast-forward physics.
func (engine *Engine) Step(input Input, rtt time.Duration) (Update, error) {
	if !validDirection(input.Direction) || rtt < 0 {
		return Update{}, ErrInvalidInput
	}
	if engine.state.Phase == Finished {
		return Update{State: engine.state}, nil
	}
	state := &engine.state
	step := time.Duration(state.Tick+1)*time.Second/SimulationHz - time.Duration(state.Tick)*time.Second/SimulationHz
	state.Tick++
	if state.Phase == CountingDown {
		state.CountdownRemaining = max(0, state.CountdownRemaining-step)
		if state.CountdownRemaining == 0 {
			state.Phase = Running
			engine.scent.append(ScentPoint{At: 0, Position: state.Mouse})
		}
		return Update{State: *state}, nil
	}

	step = min(step, state.Remaining)
	update := Update{}
	if input.Dash && state.Elapsed >= engine.dashReadyAt {
		engine.dashUntil = state.Elapsed + DashDuration
		engine.dashReadyAt = state.Elapsed + DashCooldown
		update.DashStarted = true
	}
	dashing := max(0, min(step, engine.dashUntil-state.Elapsed))
	distance := float32(MouseSpeed*step.Seconds() + MouseSpeed*(DashMultiplier-1)*dashing.Seconds())
	direction := normalized(input.Direction)
	previousMouse, previousCat := state.Mouse, state.Cat
	state.Mouse = move(engine.layout, state.Mouse, Point{X: direction.X * distance, Y: direction.Y * distance})
	state.Elapsed += step
	state.Remaining -= step
	state.DashRemaining = max(0, engine.dashUntil-state.Elapsed)
	state.DashCooldown = max(0, engine.dashReadyAt-state.Elapsed)
	engine.scent.append(ScentPoint{At: state.Elapsed, Position: state.Mouse})
	state.CatTarget, _ = engine.scent.target(engine.layout, state.Elapsed, rtt)
	state.CatSpeed = speedForRTT(rtt)
	state.Cat = engine.pursuit.advance(engine.layout, state.Cat, state.CatTarget, state.CatSpeed*float32(step.Seconds()))
	// A step travels less than one cell per axis. These ordered endpoints
	// include every entered tile, including the intermediate wall-slide tile.
	reachedExit := false
	for _, contact := range [3]Point{previousMouse, {X: state.Mouse.X, Y: previousMouse.Y}, state.Mouse} {
		for index, cheese := range engine.layout.Cheese {
			if !state.Cheese[index] && sameCell(contact, cheese) {
				state.Cheese[index] = true
				update.CheeseMask |= 1 << index
			}
		}
		if state.ExitOpen() && sameCell(contact, engine.layout.Exit) {
			reachedExit = true
		}
	}
	switch {
	case captured(previousMouse, state.Mouse, previousCat, state.Cat):
		state.Outcome = Caught
	case reachedExit:
		state.Outcome = Escaped
	case state.Remaining == 0:
		state.Outcome = TimedOut
	}
	if state.Outcome != "" {
		state.Phase = Finished
		update.Result = state.Outcome
	}
	update.State = *state
	return update, nil
}

func validDirection(direction Point) bool {
	return !math.IsNaN(float64(direction.X)) && !math.IsNaN(float64(direction.Y)) &&
		direction.X >= -1 && direction.X <= 1 && direction.Y >= -1 && direction.Y <= 1
}

func normalized(direction Point) Point {
	length := math.Hypot(float64(direction.X), float64(direction.Y))
	if length > 1 {
		direction.X /= float32(length)
		direction.Y /= float32(length)
	}
	return direction
}

func sameCell(left, right Point) bool {
	return math.Floor(float64(left.X)) == math.Floor(float64(right.X)) &&
		math.Floor(float64(left.Y)) == math.Floor(float64(right.Y))
}

// move sweeps each axis through grid boundaries. Clipping just outside a wall
// allows sliding without tunneling, including the faster dash displacement.
func move(layout Map, from, delta Point) Point {
	from.X = moveAxis(layout, from, delta.X, true)
	from.Y = moveAxis(layout, from, delta.Y, false)
	return from
}

func moveAxis(layout Map, from Point, delta float32, horizontal bool) float32 {
	coordinate, fixed := from.X, int(math.Floor(float64(from.Y)))
	if !horizontal {
		coordinate, fixed = from.Y, int(math.Floor(float64(from.X)))
	}
	end := coordinate + delta
	startCell, endCell := int(math.Floor(float64(coordinate))), int(math.Floor(float64(end)))
	sign := 1
	if delta < 0 {
		sign = -1
	}
	for cell := startCell; cell != endCell; {
		cell += sign
		x, y := cell, fixed
		if !horizontal {
			x, y = fixed, cell
		}
		if !layout.Walkable(x, y) {
			boundary := float32(cell)
			if sign < 0 {
				boundary++
			}
			return math.Nextafter32(boundary, coordinate)
		}
	}
	return end
}

// Test the minimum relative center distance over the step as well as its
// endpoints, so a fast crossing cannot jump across the capture threshold.
func captured(mouseBefore, mouseAfter, catBefore, catAfter Point) bool {
	x, y := float64(mouseBefore.X-catBefore.X), float64(mouseBefore.Y-catBefore.Y)
	dx := float64(mouseAfter.X-catAfter.X) - x
	dy := float64(mouseAfter.Y-catAfter.Y) - y
	fraction := 0.0
	if lengthSquared := dx*dx + dy*dy; lengthSquared > 0 {
		fraction = max(0, min(1, -(x*dx+y*dy)/lengthSquared))
	}
	x, y = x+fraction*dx, y+fraction*dy
	radius := float64(float32(CaptureDistance))
	return x*x+y*y < radius*radius
}
