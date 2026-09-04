package escape

import (
	"testing"
	"time"
)

func TestSpectatorScentIsChronologicalBoundedAndIndependent(t *testing.T) {
	round, err := NewRound("courtyard", 42, DefaultRound, time.Unix(1, 0))
	if err != nil {
		t.Fatal(err)
	}
	if _, count := round.Scent(); count != 0 {
		t.Fatal("unstarted round has scent")
	}
	for index := 0; index < ScentCapacity*3; index++ {
		round.engine.scent.append(ScentPoint{At: time.Duration(index), Position: Point{X: float32(index), Y: 2}})
	}
	points, count := round.Scent()
	if count != ScentCapacity {
		t.Fatal("scent copy is not bounded")
	}
	for index := range count {
		if points[index].At != time.Duration(ScentCapacity*2+index) {
			t.Fatal("scent copy is not chronological")
		}
	}
	points[0].Position.X = -1
	next, _ := round.Scent()
	if next[0].Position.X < 0 {
		t.Fatal("spectator mutated scent")
	}
}
