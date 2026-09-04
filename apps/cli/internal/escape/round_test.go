package escape

import (
	"errors"
	"math"
	"testing"
	"time"
)

var roundTestTime = time.Unix(1_700_000_000, 0)

func testRound(t *testing.T) *Round {
	t.Helper()
	round, err := NewRound("courtyard", 42, DefaultRound, roundTestTime)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { round.ForgetConnection() })
	return round
}

func acceptRound(t *testing.T, round *Round, now time.Time, sequence uint32, input Input) {
	t.Helper()
	if accepted, err := round.Accept(now, sequence, input); !accepted || err != nil {
		t.Fatalf("input rejected: %t %v", accepted, err)
	}
}

func tickRound(t *testing.T, round *Round, now time.Time) RoundUpdate {
	t.Helper()
	update, err := round.Tick(now, 40*time.Millisecond)
	if err != nil {
		t.Fatal(err)
	}
	return update
}

func runningRound(t *testing.T) (*Round, time.Time, uint32) {
	t.Helper()
	round := testRound(t)
	for tick := uint32(1); tick <= 90; tick++ {
		now := roundTestTime.Add(time.Duration(tick) * time.Second / SimulationHz)
		acceptRound(t, round, now, tick, Input{})
		tickRound(t, round, now)
	}
	if round.Inspect().Phase != Running {
		t.Fatal("countdown did not finish")
	}
	return round, roundTestTime.Add(Countdown), 90
}

func TestRoundInputValidationAndReceiptClock(t *testing.T) {
	if _, err := NewRound("missing", 0, DefaultRound, roundTestTime); !errors.Is(err, ErrInvalidMap) {
		t.Fatal(err)
	}
	round := testRound(t)
	if round.Map() != round.engine.Map() {
		t.Fatal("map copy changed")
	}
	before := round.Inspect()
	for _, input := range []struct {
		now   time.Time
		seq   uint32
		input Input
	}{
		{roundTestTime, 0, Input{}}, {roundTestTime.Add(-time.Nanosecond), 1, Input{}},
		{roundTestTime, 1, Input{Direction: Point{X: float32(math.NaN())}}},
	} {
		if ok, err := round.Accept(input.now, input.seq, input.input); ok || !errors.Is(err, ErrInvalidInput) {
			t.Fatalf("invalid input: %t %v", ok, err)
		}
		if round.Inspect() != before {
			t.Fatal("invalid input mutated state")
		}
	}
	acceptRound(t, round, roundTestTime, 2, Input{Direction: Point{X: 1, Y: 1}})
	if math.Abs(float64(round.direction.X)-math.Sqrt(.5)) > 1e-6 {
		t.Fatal("diagonal not normalized")
	}
	for _, sequence := range []uint32{1, 2} {
		if ok, err := round.Accept(roundTestTime.Add(2*time.Second), sequence, Input{}); ok || err != nil {
			t.Fatalf("stale input accepted: %t %v", ok, err)
		}
	}
	if round.lastInput != roundTestTime || round.accepted != 2 {
		t.Fatal("stale input refreshed receipt clock")
	}
	for _, test := range []struct {
		now time.Time
		rtt time.Duration
	}{
		{roundTestTime.Add(-1), 0}, {roundTestTime, -1},
	} {
		if _, err := round.Tick(test.now, test.rtt); !errors.Is(err, ErrInvalidInput) {
			t.Fatal(err)
		}
	}
}

func TestRoundLinearDecayStopAndPauseFreeze(t *testing.T) {
	for _, test := range []struct {
		age  time.Duration
		want float32
	}{
		{0, 1}, {InputDecayAfter, 1}, {325 * time.Millisecond, .5}, {InputStopAfter, 0}, {time.Second, 0},
	} {
		got := decayedDirection(Point{X: 1, Y: -.5}, test.age)
		if got != (Point{X: test.want, Y: -.5 * test.want}) {
			t.Fatalf("decay %v: %+v", test.age, got)
		}
	}
	round, now, seq := runningRound(t)
	acceptRound(t, round, now, seq+1, Input{Direction: Point{X: 1}})
	before := round.Inspect()
	first := tickRound(t, round, now.Add(InputDecayAfter))
	if first.State.Mouse == before.Mouse {
		t.Fatal("fresh movement did not advance")
	}
	stopped := tickRound(t, round, now.Add(InputStopAfter))
	if stopped.State.Mouse != first.State.Mouse || stopped.State.Elapsed <= first.State.Elapsed {
		t.Fatal("500 ms must stop only the mouse, not simulation time")
	}
	paused := tickRound(t, round, now.Add(InputPauseAfter))
	if !paused.Paused || !paused.PauseChanged || paused.State != stopped.State {
		t.Fatal("three-second pause did not freeze the world")
	}
	for _, age := range []time.Duration{4 * time.Second, 10 * time.Second, InputGrace - time.Nanosecond} {
		update := tickRound(t, round, now.Add(age))
		if !update.Paused || update.PauseChanged || update.State != paused.State || update.Result != "" {
			t.Fatal("paused world changed or finished early")
		}
	}
	acceptRound(t, round, now.Add(InputGrace-time.Nanosecond), seq+2, Input{})
	resumed := tickRound(t, round, now.Add(InputGrace-time.Nanosecond))
	if resumed.Paused || !resumed.PauseChanged || resumed.State.Elapsed <= paused.State.Elapsed {
		t.Fatal("fresh input did not resume one step")
	}
	if resumed.State.Elapsed-paused.State.Elapsed > 34*time.Millisecond {
		t.Fatal("resume replayed missed simulation ticks")
	}
}

func TestRoundGraceExpiresBeforeLateInputAndOnlyOneResult(t *testing.T) {
	for _, age := range []time.Duration{InputGrace, InputGrace + time.Second} {
		round := testRound(t)
		acceptRound(t, round, roundTestTime, 1, Input{Dash: true})
		if ok, err := round.Accept(roundTestTime.Add(age), 2, Input{}); ok || err != nil {
			t.Fatalf("late input extended grace: %t %v", ok, err)
		}
		ended := tickRound(t, round, roundTestTime.Add(age))
		if ended.Result != ConnectionLost || ended.State.Phase != Finished || round.Inspect().PendingDash != 0 {
			t.Fatal("round did not terminate")
		}
		for index := range 100 {
			update := tickRound(t, round, roundTestTime.Add(age+time.Duration(index)*time.Second))
			if update.State != ended.State || update.Result != "" || update.SnapshotDue {
				t.Fatal("completed round changed or emitted twice")
			}
		}
		if ok, err := round.Accept(round.now, 3, Input{}); ok || err != nil {
			t.Fatal("completed round accepted input")
		}
	}
}

func TestRoundSnapshotCadenceAndNoBacklog(t *testing.T) {
	round := testRound(t)
	snapshots := 0
	for tick := uint32(1); tick <= 90; tick++ {
		now := roundTestTime.Add(time.Duration(tick) * time.Second / SimulationHz)
		acceptRound(t, round, now, tick, Input{})
		if tickRound(t, round, now).SnapshotDue {
			snapshots++
		}
	}
	if snapshots != 30 {
		t.Fatalf("snapshot rate: %d in three seconds", snapshots)
	}
	late := roundTestTime.Add(10 * time.Second)
	if !tickRound(t, round, late).SnapshotDue {
		t.Fatal("late snapshot missing")
	}
	if tickRound(t, round, late).SnapshotDue {
		t.Fatal("snapshot backlog replayed")
	}
}

func TestRoundSnapshotCadenceDoesNotDriftWithSchedulerJitter(t *testing.T) {
	round := testRound(t)
	snapshots := 0
	for tick := uint32(1); tick <= 300; tick++ {
		now := roundTestTime.Add(time.Duration(tick)*time.Second/SimulationHz + time.Duration(tick%2)*2*time.Millisecond)
		acceptRound(t, round, now, tick, Input{})
		if tickRound(t, round, now).SnapshotDue {
			snapshots++
		}
	}
	if snapshots != 100 {
		t.Fatalf("jitter caused snapshot drift: %d in ten seconds", snapshots)
	}
}

func TestRoundBoundedOrderedDashAndConnectionRevocation(t *testing.T) {
	round, now, seq := runningRound(t)
	for index := range MaxPendingDash {
		acceptRound(t, round, now, seq+uint32(index)+1, Input{Dash: true, Direction: Point{X: float32(index) / 8}})
	}
	before := round.Inspect()
	if ok, err := round.Accept(now.Add(time.Millisecond), seq+9, Input{Dash: true}); ok || !errors.Is(err, ErrInputBackpressure) {
		t.Fatalf("queue overflow: %t %v", ok, err)
	}
	if round.Inspect() != before || round.lastInput != now {
		t.Fatal("rejected dash mutated state")
	}
	acceptRound(t, round, now, seq+9, Input{Direction: Point{Y: -1}})
	for index := range MaxPendingDash {
		if round.dashes[0].direction.X != float32(index)/8 {
			t.Fatal("dash order changed")
		}
		update := tickRound(t, round, now.Add(time.Duration(index+1)*time.Second/SimulationHz))
		if index == 0 && (!update.DashStarted || update.DashRejected) {
			t.Fatal("first dash rejected")
		}
		if index != 0 && (!update.DashRejected || update.DashStarted) {
			t.Fatal("cooldown dash not rejected")
		}
	}
	if round.dashCount != 0 || round.dashes != [MaxPendingDash]pendingDash{} {
		t.Fatal("consumed queue retained data")
	}
	now = round.now
	acceptRound(t, round, now, seq+10, Input{Dash: true})
	round.ForgetConnection()
	if round.Inspect().PendingDash != 0 || round.Inspect().AcceptedSequence != seq+10 || round.lastInput != now {
		t.Fatal("disconnect revoked the wrong state")
	}
}

func TestRoundRejectsExpiredOrCountdownDashAndClearsOnOutcome(t *testing.T) {
	round := testRound(t)
	acceptRound(t, round, roundTestTime, 1, Input{Dash: true})
	if update := tickRound(t, round, roundTestTime.Add(time.Millisecond)); !update.DashRejected || update.DashStarted {
		t.Fatal("countdown dash was accepted")
	}
	active, now, seq := runningRound(t)
	acceptRound(t, active, now, seq+1, Input{Dash: true})
	if update := tickRound(t, active, now.Add(InputStopAfter)); !update.DashRejected || update.DashStarted {
		t.Fatal("expired dash was replayed")
	}
	// Exercise the actual engine completion path without needing a live timer.
	active.engine.state.Mouse, active.engine.state.Cat = Point{X: 3.5, Y: 3.5}, Point{X: 3.5, Y: 3.5}
	acceptRound(t, active, active.now, seq+2, Input{Dash: true})
	acceptRound(t, active, active.now, seq+3, Input{Dash: true})
	update := tickRound(t, active, active.now.Add(time.Second/SimulationHz))
	if update.Result != Caught || active.Inspect().PendingDash != 0 {
		t.Fatal("completion retained discrete work")
	}
}
