package escape

import (
	"errors"
	"math"
	"strings"
	"testing"
	"time"
)

func TestEngineConstantsMatchPRD(t *testing.T) {
	if SimulationHz != 30 || MouseSpeed != 6.0 || CatBaseSpeed != 5.3 || CatMaxSpeed != 6.2 ||
		CaptureDistance != 0.55 || DashMultiplier != 2.2 || DashDuration != 350*time.Millisecond ||
		DashCooldown != 5*time.Second || Countdown != 3*time.Second || MinRound != 30*time.Second ||
		DefaultRound != 45*time.Second || MaxRound != 45*time.Second {
		t.Fatal("product tuning differs from the PRD")
	}
}

func TestCountdownHasExactlyNinetyStepsAndDoesNotSpendRoundOrDash(t *testing.T) {
	engine, err := New("pantry", 42, DefaultRound)
	if err != nil {
		t.Fatal(err)
	}
	initial := engine.Inspect()
	layout := engine.Map()
	layout.Rows[1], layout.Mouse = "mutated", Point{}
	if engine.Map().Rows[1] == "mutated" || engine.Map().Mouse == (Point{}) {
		t.Fatal("map snapshot aliases engine state")
	}
	for tick := uint32(1); tick <= 90; tick++ {
		update := mustStep(t, engine, Input{Direction: Point{X: 1}, Dash: true}, time.Second)
		state := update.State
		if state.Tick != tick || state.Mouse != initial.Mouse || state.Cat != initial.Cat ||
			state.Elapsed != 0 || state.Remaining != DefaultRound || update.DashStarted ||
			update.Result != "" || state.DashCooldown != 0 || state.DashRemaining != 0 ||
			state.CountdownRemaining != Countdown-time.Duration(tick)*time.Second/SimulationHz {
			t.Fatalf("countdown advanced gameplay at tick %d: %+v", tick, update)
		}
		wantPhase := CountingDown
		if tick == 90 {
			wantPhase = Running
		}
		if state.Phase != wantPhase {
			t.Fatalf("phase at tick %d: %s", tick, state.Phase)
		}
	}
	update := mustStep(t, engine, Input{Direction: Point{X: 1}, Dash: true}, 0)
	if !update.DashStarted || update.State.Elapsed != time.Second/SimulationHz {
		t.Fatalf("first active tick did not start the round: %+v", update)
	}
	near(t, update.State.Mouse.X-initial.Mouse.X, float32(MouseSpeed*DashMultiplier/SimulationHz), 0.00001)
}

func TestConstructorAndInputFailBeforeMutation(t *testing.T) {
	for _, duration := range []time.Duration{-1, 0, MinRound - 1, MaxRound + 1} {
		engine, err := New("pantry", 0, duration)
		if engine != nil || !errors.Is(err, ErrInvalidRound) {
			t.Fatalf("accepted round %v: %v", duration, err)
		}
	}
	if engine, err := New("unknown", 0, DefaultRound); engine != nil || !errors.Is(err, ErrInvalidMap) {
		t.Fatalf("accepted unknown map: %v", err)
	}
	engine := newIsolatedEngine(t)
	before := *engine
	for _, direction := range []Point{
		{X: float32(math.NaN())}, {Y: float32(math.NaN())}, {X: float32(math.Inf(1))},
		{Y: float32(math.Inf(-1))}, {X: 1.001}, {X: -1.001}, {Y: 1.001}, {Y: -1.001},
	} {
		update, err := engine.Step(Input{Direction: direction, Dash: true}, 0)
		if !errors.Is(err, ErrInvalidInput) || update != (Update{}) || *engine != before {
			t.Fatalf("invalid direction changed state: %v", err)
		}
	}
	if _, err := engine.Step(Input{}, -1); !errors.Is(err, ErrInvalidInput) || *engine != before {
		t.Fatal("negative RTT changed state")
	}
}

func TestAnalogMovementAndDiagonalNormalization(t *testing.T) {
	for _, test := range []struct {
		name         string
		input        Point
		wantDistance float32
	}{
		{"stationary", Point{}, 0}, {"half speed", Point{X: 0.5}, 0.1},
		{"full speed", Point{Y: -1}, 0.2}, {"normalized diagonal", Point{X: 1, Y: 1}, 0.2},
		{"negative diagonal", Point{X: -1, Y: -1}, 0.2},
	} {
		t.Run(test.name, func(t *testing.T) {
			engine := newIsolatedEngine(t)
			before := engine.Inspect().Mouse
			after := mustStep(t, engine, Input{Direction: test.input}, 0).State.Mouse
			near(t, pointDistance(before, after), test.wantDistance, 0.000001)
		})
	}
}

func TestDashPartialTickAndExactCooldown(t *testing.T) {
	engine := newIsolatedEngine(t)
	start := engine.Inspect().Mouse
	for tick := 0; tick < 30; tick++ {
		// Repeated requests during cooldown are deterministically ignored.
		update := mustStep(t, engine, Input{Direction: Point{X: 1}, Dash: true}, 0)
		if update.DashStarted != (tick == 0) {
			t.Fatalf("dash event at tick %d: %+v", tick, update)
		}
		if tick == 9 && update.State.DashRemaining != DashDuration-time.Second/3 {
			t.Fatalf("partial dash remainder: %v", update.State.DashRemaining)
		}
		if tick == 10 && update.State.DashRemaining != 0 {
			t.Fatal("dash lasted eleven full ticks")
		}
	}
	near(t, engine.Inspect().Mouse.X-start.X, float32(MouseSpeed+MouseSpeed*(DashMultiplier-1)*0.35), 0.0001)
	if engine.Inspect().Elapsed != time.Second || engine.Inspect().DashCooldown != 4*time.Second {
		t.Fatal("tick rounding drifted after one second")
	}
	for tick := 30; tick < 150; tick++ {
		if mustStep(t, engine, Input{Dash: true}, 0).DashStarted {
			t.Fatalf("dash accepted before five seconds at tick %d", tick)
		}
	}
	if engine.Inspect().Elapsed != DashCooldown || engine.Inspect().DashCooldown != 0 {
		t.Fatal("cooldown did not reach zero at five seconds")
	}
	if !mustStep(t, engine, Input{Dash: true}, 0).DashStarted {
		t.Fatal("dash rejected at exact cooldown boundary")
	}
}

func TestWallSweepsAndAxisSliding(t *testing.T) {
	layout := isolatedArena()
	for _, test := range []struct {
		name              string
		from, delta, want Point
	}{
		{"right outer wall", Point{X: 40.5, Y: 3.5}, Point{X: 100}, Point{X: math.Nextafter32(47, 0), Y: 3.5}},
		{"left outer wall", Point{X: 3.5, Y: 3.5}, Point{X: -100}, Point{X: math.Nextafter32(1, 2), Y: 3.5}},
		{"bottom outer wall", Point{X: 3.5, Y: 3.5}, Point{Y: 100}, Point{X: 3.5, Y: math.Nextafter32(17, 0)}},
		{"top outer wall", Point{X: 3.5, Y: 3.5}, Point{Y: -100}, Point{X: 3.5, Y: math.Nextafter32(1, 2)}},
		{"interior wall", Point{X: 23.9, Y: 3.5}, Point{X: 1}, Point{X: math.Nextafter32(24, 0), Y: 3.5}},
		{"interior reverse", Point{X: 25.1, Y: 3.5}, Point{X: -1}, Point{X: math.Nextafter32(25, 26), Y: 3.5}},
		{"wall slide", Point{X: 23.9, Y: 3.5}, Point{X: 1, Y: 1}, Point{X: math.Nextafter32(24, 0), Y: 4.5}},
		{"within cell", Point{X: 3.5, Y: 3.5}, Point{X: 0.1, Y: -0.2}, Point{X: 3.6, Y: 3.3}},
	} {
		t.Run(test.name, func(t *testing.T) {
			if got := move(layout, test.from, test.delta); got != test.want {
				t.Fatalf("move: got %+v, want %+v", got, test.want)
			}
		})
	}
	engine := newIsolatedEngine(t)
	engine.state.Mouse = Point{X: 23.9, Y: 3.5}
	for range 30 {
		state := mustStep(t, engine, Input{Direction: Point{X: 1, Y: 1}, Dash: true}, 0).State
		if state.Mouse.X >= 24 || !engine.layout.Walkable(int(state.Mouse.X), int(state.Mouse.Y)) {
			t.Fatal("dash tunneled through a wall")
		}
	}
}

func TestCheeseUnlockAndExactlyOneResult(t *testing.T) {
	engine := newIsolatedEngine(t)
	engine.state.Mouse = engine.layout.Exit
	if update := mustStep(t, engine, Input{}, 0); update.Result != "" || update.State.ExitOpen() {
		t.Fatal("locked exit completed the round")
	}
	for index, position := range engine.layout.Cheese {
		// Entering the cell, not its exact center, is the contact rule.
		engine.state.Mouse = Point{X: position.X - 0.49, Y: position.Y + 0.49}
		update := mustStep(t, engine, Input{}, 0)
		if update.CheeseMask != 1<<index || !update.State.Cheese[index] || update.Result != "" || update.State.ExitOpen() != (index == 1) {
			t.Fatalf("cheese %d: %+v", index, update)
		}
		if mustStep(t, engine, Input{}, 0).CheeseMask != 0 {
			t.Fatal("cheese collected twice")
		}
	}
	engine.state.Mouse = engine.layout.Exit
	update := mustStep(t, engine, Input{}, 0)
	if update.Result != Escaped || update.State.Outcome != Escaped || update.State.Phase != Finished {
		t.Fatalf("open exit did not win: %+v", update)
	}
	assertTerminalStable(t, engine)
}

func TestCaptureThresholdCrossingsAndOutcomePriority(t *testing.T) {
	for _, test := range []struct {
		name                                         string
		mouseBefore, mouseAfter, catBefore, catAfter Point
		want                                         bool
	}{
		{"same center", Point{}, Point{}, Point{}, Point{}, true},
		{"strict boundary", Point{}, Point{}, Point{X: CaptureDistance}, Point{X: CaptureDistance}, false},
		{"just inside", Point{}, Point{}, Point{X: 0.5499}, Point{X: 0.5499}, true},
		{"just outside", Point{}, Point{}, Point{X: 0.5501}, Point{X: 0.5501}, false},
		{"crossing", Point{X: -0.6}, Point{X: 0.6}, Point{}, Point{}, true},
		{"crossing with offset", Point{X: -0.6, Y: 0.6}, Point{X: 0.6, Y: 0.6}, Point{}, Point{}, false},
		{"moving apart", Point{X: -1}, Point{X: -2}, Point{}, Point{X: 1}, false},
		{"both moving", Point{X: 1}, Point{X: 0.2}, Point{}, Point{X: 0.2}, true},
	} {
		t.Run(test.name, func(t *testing.T) {
			if got := captured(test.mouseBefore, test.mouseAfter, test.catBefore, test.catAfter); got != test.want {
				t.Fatalf("capture got %v, want %v", got, test.want)
			}
		})
	}
	engine := newIsolatedEngine(t)
	engine.state.Mouse, engine.state.Cat = engine.layout.Exit, engine.layout.Exit
	engine.state.Cheese = [2]bool{true, true}
	engine.state.Remaining = time.Nanosecond
	update := mustStep(t, engine, Input{}, 0)
	if update.Result != Caught || update.State.Outcome != Caught || update.State.Phase != Finished {
		t.Fatalf("capture must win a simultaneous outcome: %+v", update)
	}
	assertTerminalStable(t, engine)
	engine = newIsolatedEngine(t)
	engine.state.Mouse, engine.state.Cheese, engine.state.Remaining = engine.layout.Exit, [2]bool{true, true}, time.Nanosecond
	if update := mustStep(t, engine, Input{}, 0); update.Result != Escaped {
		t.Fatal("open exit at the last step lost to timeout")
	}
}

func TestDiagonalContactsKeepPickupAndExitOrder(t *testing.T) {
	input := Input{Direction: Point{X: 1, Y: 1}}
	engine := newIsolatedEngine(t)
	engine.state.Mouse = Point{X: 3.9, Y: 3.9}
	engine.layout.Cheese[0] = Point{X: 4.5, Y: 3.5}
	update := mustStep(t, engine, input, 0)
	if update.CheeseMask != 1 || sameCell(update.State.Mouse, engine.layout.Cheese[0]) {
		t.Fatal("diagonal movement skipped the intermediate cheese cell")
	}
	engine = newIsolatedEngine(t)
	engine.state.Mouse, engine.state.Cheese = Point{X: 3.9, Y: 3.9}, [2]bool{true, true}
	engine.layout.Exit = Point{X: 4.5, Y: 3.5}
	if update := mustStep(t, engine, input, 0); update.Result != Escaped {
		t.Fatal("diagonal movement skipped an open intermediate exit")
	}
	engine = newIsolatedEngine(t)
	engine.state.Mouse, engine.state.Cheese = Point{X: 3.9, Y: 3.9}, [2]bool{true, false}
	engine.layout.Exit = Point{X: 4.5, Y: 3.5}
	engine.layout.Cheese[1] = Point{X: 4.5, Y: 4.5}
	update = mustStep(t, engine, input, 0)
	if update.Result != "" || !update.State.ExitOpen() || update.CheeseMask != 2 {
		t.Fatal("collecting a later cheese retroactively opened an earlier exit contact")
	}
}

func TestRoundTimeoutHasNoAccumulatedTickDrift(t *testing.T) {
	for _, duration := range []time.Duration{MinRound, 30*time.Second + 1, 31*time.Second + 17*time.Millisecond, MaxRound} {
		engine := newIsolatedEngine(t)
		engine.state.Remaining = duration
		steps := int((duration*time.Duration(SimulationHz) + time.Second - 1) / time.Second)
		for tick := 1; tick <= steps; tick++ {
			update := mustStep(t, engine, Input{}, 0)
			if tick < steps && (update.Result != "" || update.State.Remaining <= 0) {
				t.Fatalf("early result at tick %d for %v", tick, duration)
			}
			if tick == steps && (update.Result != TimedOut || update.State.Elapsed != duration || update.State.Remaining != 0) {
				t.Fatalf("timeout for %v: %+v", duration, update)
			}
		}
		assertTerminalStable(t, engine)
	}
}

func TestRealMapSimulationReplaysAndNeverLeavesFloor(t *testing.T) {
	names := MapNames()
	directions := []Point{{X: 1}, {Y: 1}, {X: -1}, {Y: -1}, {X: 1, Y: 1}, {}, {X: -0.4, Y: 0.7}}
	rtts := []time.Duration{0, 20 * time.Millisecond, 80 * time.Millisecond, 150 * time.Millisecond, 300 * time.Millisecond, time.Second}
	for _, name := range append(names[:], "random") {
		for _, seed := range []int64{math.MinInt64, -1, 0, 42, math.MaxInt64} {
			first, err := New(name, seed, DefaultRound)
			if err != nil {
				t.Fatal(err)
			}
			second, err := New(name, seed, DefaultRound)
			if err != nil || first.Map() != second.Map() {
				t.Fatal("identical selection changed the initial map")
			}
			results := 0
			for tick := 0; tick < 1440; tick++ {
				before := first.Inspect()
				input := Input{Direction: directions[(tick/17)%len(directions)], Dash: tick%151 == 0}
				rtt := rtts[(tick/13)%len(rtts)]
				left, right := mustStep(t, first, input, rtt), mustStep(t, second, input, rtt)
				if left != right {
					t.Fatalf("replay diverged for %s seed %d tick %d", name, seed, tick)
				}
				for _, position := range []Point{left.State.Mouse, left.State.Cat, left.State.CatTarget} {
					if !first.layout.Walkable(int(math.Floor(float64(position.X))), int(math.Floor(float64(position.Y)))) {
						t.Fatalf("entity left legal floor on %s at tick %d: %+v", name, tick, left.State)
					}
				}
				if pointDistance(before.Mouse, left.State.Mouse) > MouseSpeed*DashMultiplier/SimulationHz+0.00001 ||
					pointDistance(before.Cat, left.State.Cat) > CatMaxSpeed/SimulationHz+0.00001 {
					t.Fatalf("movement exceeded a fixed step: %+v", left.State)
				}
				if left.Result != "" {
					results++
				}
			}
			if results != 1 || first.Inspect().Phase != Finished {
				t.Fatalf("expected one authoritative outcome on %s: %d", name, results)
			}
		}
	}
}

func assertTerminalStable(t *testing.T, engine *Engine) {
	t.Helper()
	before := *engine
	for range 100 {
		update := mustStep(t, engine, Input{Direction: Point{X: 1, Y: -1}, Dash: true}, time.Second)
		if update.State != before.state || update.Result != "" || update.DashStarted || update.CheeseMask != 0 || *engine != before {
			t.Fatal("terminal engine emitted a duplicate event or changed state")
		}
	}
}

func mustStep(t *testing.T, engine *Engine, input Input, rtt time.Duration) Update {
	t.Helper()
	update, err := engine.Step(input, rtt)
	if err != nil {
		t.Fatal(err)
	}
	return update
}

// The divider isolates the cat for clock/dash/outcome unit tests. Production
// maps have no disconnected floor; real-map pursuit is tested separately.
func isolatedArena() Map {
	layout := Map{Name: "test arena", Mouse: Point{X: 3.5, Y: 3.5}, Cat: Point{X: 40.5, Y: 15.5},
		Cheese: [2]Point{{X: 15.5, Y: 12.5}, {X: 20.5, Y: 12.5}}, Exit: Point{X: 22.5, Y: 12.5}}
	for y := range MapHeight {
		row := []byte(strings.Repeat(".", MapWidth))
		for x := range MapWidth {
			if x == 0 || x == 24 || x == MapWidth-1 || y == 0 || y == MapHeight-1 {
				row[x] = '#'
			}
		}
		layout.Rows[y] = string(row)
	}
	return layout
}

func newIsolatedEngine(t *testing.T) *Engine {
	t.Helper()
	engine, err := New("courtyard", 0, DefaultRound)
	if err != nil {
		t.Fatal(err)
	}
	engine.layout = isolatedArena()
	engine.state.Phase, engine.state.CountdownRemaining = Running, 0
	engine.state.Mouse, engine.state.Cat = engine.layout.Mouse, engine.layout.Cat
	engine.scent.append(ScentPoint{At: 0, Position: engine.state.Mouse})
	return engine
}

func near(t *testing.T, got, want, tolerance float32) {
	t.Helper()
	if math.IsNaN(float64(got)) || math.Abs(float64(got-want)) > float64(tolerance) {
		t.Fatalf("got %v, want %v (tolerance %v)", got, want, tolerance)
	}
}

func pointDistance(left, right Point) float32 {
	return float32(math.Hypot(float64(left.X-right.X), float64(left.Y-right.Y)))
}
