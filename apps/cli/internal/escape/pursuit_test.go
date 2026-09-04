package escape

import (
	"math"
	"testing"
	"time"
)

func TestScentInterpolationClampAndUnevenSamples(t *testing.T) {
	layout := isolatedArena()
	history := scentHistory{}
	for _, milliseconds := range []int64{0, 80, 170, 300} {
		history.append(ScentPoint{At: time.Duration(milliseconds) * time.Millisecond,
			Position: Point{X: 3 + float32(milliseconds)*0.0125, Y: 3}})
	}
	for _, test := range []struct {
		rtt, wantMilliseconds int64
	}{
		{0, 260}, {20, 260}, {40, 260}, {80, 220}, {130, 170}, {150, 150}, {250, 50}, {300, 50}, {10000, 50},
	} {
		target, found := history.target(layout, 300*time.Millisecond, time.Duration(test.rtt)*time.Millisecond)
		if !found {
			t.Fatal("missing scent sample")
		}
		near(t, target.X, 3+float32(test.wantMilliseconds)*0.0125, 0.000001)
		if target.Y != 3 {
			t.Fatal("interpolated Y changed")
		}
	}
}

func TestScentStartupFutureExclusionAndCornerSafety(t *testing.T) {
	layout := isolatedArena()
	history := scentHistory{}
	if _, found := history.target(layout, 0, 0); found {
		t.Fatal("empty history returned a point")
	}
	history.append(ScentPoint{At: 0, Position: Point{X: 3, Y: 3}})
	if point, found := history.target(layout, 0, 0); !found || point != (Point{X: 3, Y: 3}) {
		t.Fatal("startup did not clamp to the first actual sample")
	}
	history.append(ScentPoint{At: time.Second, Position: Point{X: 10, Y: 10}})
	if point, found := history.target(layout, 200*time.Millisecond, 0); !found || point != (Point{X: 3, Y: 3}) {
		t.Fatal("future sample influenced the target")
	}
	if _, found := history.target(layout, -time.Second, 0); found {
		t.Fatal("history entirely in the future produced a target")
	}
	row := []byte(layout.Rows[4])
	row[3] = '#'
	layout.Rows[4] = string(row)
	before, after := Point{X: 3.9, Y: 3.95}, Point{X: 4.05, Y: 4.2}
	if got := move(layout, before, Point{X: after.X - before.X, Y: after.Y - before.Y}); got != after {
		t.Fatal("corner fixture is not a legal axis-sliding move")
	}
	history = scentHistory{}
	history.append(ScentPoint{At: 0, Position: before})
	history.append(ScentPoint{At: 100 * time.Millisecond, Position: after})
	if point, found := history.target(layout, 100*time.Millisecond, 50*time.Millisecond); !found || point != before {
		t.Fatalf("wall-corner interpolant must keep the older legal sample: %+v", point)
	}
}

func TestScentRingWrapRetainsTheEntireDelayWindow(t *testing.T) {
	if ScentCapacity != 16 || MinScentDelay != 40*time.Millisecond || MaxScentDelay != 250*time.Millisecond {
		t.Fatal("scent bounds differ from the accepted design")
	}
	history := scentHistory{}
	layout := isolatedArena()
	for tick := 0; tick < 2000; tick++ {
		now := time.Duration(tick) * time.Second / SimulationHz
		history.append(ScentPoint{At: now, Position: Point{X: 3 + float32(now.Seconds()*0.05), Y: 3}})
		if history.count > ScentCapacity || history.next < 0 || history.next >= ScentCapacity {
			t.Fatal("scent history exceeded its fixed storage")
		}
		if tick < ScentCapacity {
			continue
		}
		oldest := history.points[(history.next-history.count+ScentCapacity)%ScentCapacity]
		if oldest.At > now-MaxScentDelay {
			t.Fatal("history discarded a required delay sample")
		}
		// A changing EWMA models jitter without advancing or inventing samples.
		rtt := time.Duration((tick*73)%500) * time.Millisecond
		point, found := history.target(layout, now, rtt)
		wanted := now - max(MinScentDelay, min(MaxScentDelay, rtt))
		if !found {
			t.Fatal("wrapped scent history lost its target")
		}
		near(t, point.X, 3+float32(wanted.Seconds()*0.05), 0.000001)
		if point.X > 3+float32(now.Seconds()*0.05) {
			t.Fatal("scent target moved ahead of its latest sample")
		}
	}
	if history.count != ScentCapacity {
		t.Fatal("history did not fill its fixed capacity")
	}
}

func TestRTTSpeedCompensationHasThePRDMaximum(t *testing.T) {
	for _, test := range []struct {
		rtt  time.Duration
		want float32
	}{
		{0, 5.3}, {20 * time.Millisecond, 5.36}, {80 * time.Millisecond, 5.54},
		{150 * time.Millisecond, 5.75}, {250 * time.Millisecond, 6.05},
		{300 * time.Millisecond, 6.2}, {time.Second, 6.2}, {time.Duration(math.MaxInt64), 6.2},
	} {
		near(t, speedForRTT(test.rtt), test.want, 0.000001)
	}
}

func TestCatRoutesToEveryEntityOnEveryMapWithoutCuttingWalls(t *testing.T) {
	for _, name := range MapNames() {
		layout, err := SelectMap(name, 0)
		if err != nil {
			t.Fatal(err)
		}
		for _, target := range []Point{layout.Mouse, layout.Cheese[0], layout.Cheese[1], layout.Exit} {
			position, pursuit := layout.Cat, catPursuit{}
			for tick := 0; tick < 3000 && position != target; tick++ {
				previous := position
				position = pursuit.advance(layout, position, target, CatMaxSpeed/SimulationHz)
				if pointDistance(previous, position) > CatMaxSpeed/SimulationHz+0.00001 {
					t.Fatal("cat exceeded its per-step movement budget")
				}
				for part := 0; part <= 10; part++ {
					fraction := float32(part) / 10
					point := Point{X: previous.X + fraction*(position.X-previous.X), Y: previous.Y + fraction*(position.Y-previous.Y)}
					if !layout.Walkable(int(math.Floor(float64(point.X))), int(math.Floor(float64(point.Y)))) {
						t.Fatalf("cat crossed a wall on %s: %+v -> %+v", name, previous, position)
					}
				}
			}
			if position != target {
				t.Fatalf("cat failed to route around obstacles on %s to %+v", name, target)
			}
		}
	}
}

func TestCatPathBoundsAndNoTeleportOnTargetChanges(t *testing.T) {
	layout := isolatedArena()
	if _, found := nextWaypoint(layout, Point{}, layout.Mouse); found {
		t.Fatal("wall start accepted")
	}
	if _, found := nextWaypoint(layout, layout.Mouse, Point{X: -1, Y: 3}); found {
		t.Fatal("out-of-bounds target accepted")
	}
	if _, found := nextWaypoint(layout, layout.Mouse, layout.Cat); found {
		t.Fatal("unreachable target produced a path")
	}
	if point, found := nextWaypoint(layout, layout.Mouse, layout.Mouse); !found || point != layout.Mouse {
		t.Fatal("within-cell target was not direct")
	}
	pursuit := catPursuit{}
	if got := pursuit.advance(layout, layout.Cat, layout.Mouse, 0.2); got != layout.Cat {
		t.Fatal("unreachable target teleported the cat")
	}
	if got := pursuit.advance(layout, layout.Mouse, layout.Exit, 0); got != layout.Mouse {
		t.Fatal("zero time moved the cat")
	}
	position := layout.Mouse
	for tick := 0; tick < 300; tick++ {
		target := layout.Exit
		if tick%2 == 0 {
			target = Point{X: 2.5, Y: 2.5}
		}
		previous := position
		position = pursuit.advance(layout, position, target, 0.2)
		if pointDistance(previous, position) > 0.20001 || !layout.Walkable(int(position.X), int(position.Y)) {
			t.Fatal("target changes teleported the cat or cut a wall")
		}
	}
}
