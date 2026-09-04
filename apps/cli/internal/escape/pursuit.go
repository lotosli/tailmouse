package escape

import (
	"math"
	"time"
)

const (
	MinScentDelay = 40 * time.Millisecond
	MaxScentDelay = 250 * time.Millisecond
	ScentCapacity = 16
)

type ScentPoint struct {
	At       time.Duration
	Position Point
}

type scentHistory struct {
	points [ScentCapacity]ScentPoint
	next   int
	count  int
}

// Scent returns a bounded chronological value copy for the local spectator.
func (engine *Engine) Scent() ([ScentCapacity]ScentPoint, int) {
	var points [ScentCapacity]ScentPoint
	for index := 0; index < engine.scent.count; index++ {
		points[index] = engine.scent.points[(engine.scent.next-engine.scent.count+index+ScentCapacity)%ScentCapacity]
	}
	return points, engine.scent.count
}

func (history *scentHistory) append(point ScentPoint) {
	history.points[history.next] = point
	history.next = (history.next + 1) % ScentCapacity
	history.count = min(ScentCapacity, history.count+1)
}

func (history *scentHistory) target(layout Map, now, rtt time.Duration) (Point, bool) {
	wanted := now - max(MinScentDelay, min(MaxScentDelay, rtt))
	var previous ScentPoint
	found := false
	for offset := 0; offset < history.count; offset++ {
		index := (history.next - history.count + offset + ScentCapacity) % ScentCapacity
		point := history.points[index]
		if point.At > now {
			break
		}
		if point.At >= wanted {
			if !found {
				return point.Position, true
			}
			fraction := float32(float64(wanted-previous.At) / float64(point.At-previous.At))
			position := Point{
				X: previous.Position.X + fraction*(point.Position.X-previous.Position.X),
				Y: previous.Position.Y + fraction*(point.Position.Y-previous.Position.Y),
			}
			if !layout.Walkable(int(math.Floor(float64(position.X))), int(math.Floor(float64(position.Y)))) {
				return previous.Position, true
			}
			return position, true
		}
		previous, found = point, true
	}
	return previous.Position, found
}

func speedForRTT(rtt time.Duration) float32 {
	return float32(min(CatMaxSpeed, CatBaseSpeed+float64(rtt)/float64(time.Millisecond)*0.003))
}

// Fixed cell-center waypoints prevent a turn from cutting a blocked corner.
// A moving target can change the next waypoint, not teleport the current cat.
type catPursuit struct {
	waypoint Point
	active   bool
}

func (pursuit *catPursuit) advance(layout Map, position, target Point, distance float32) Point {
	// At maximum speed a step covers less than one cell: at most one partial
	// waypoint, one adjacent center, and the final within-cell target are needed.
	for count := 0; count < 3 && distance > 0; count++ {
		goal := target
		if sameCell(position, target) {
			pursuit.active = false
		} else {
			if !pursuit.active {
				var found bool
				pursuit.waypoint, found = nextWaypoint(layout, position, target)
				if !found {
					return position
				}
				pursuit.active = true
			}
			goal = pursuit.waypoint
		}
		dx, dy := goal.X-position.X, goal.Y-position.Y
		remaining := float32(math.Hypot(float64(dx), float64(dy)))
		if remaining <= distance {
			position = goal
			distance -= remaining
			pursuit.active = false
			if goal == target {
				return position
			}
			continue
		}
		return Point{X: position.X + dx/remaining*distance, Y: position.Y + dy/remaining*distance}
	}
	return position
}

// nextWaypoint uses at most 864 queue entries and visits each tile once. Search
// order is fixed, so equal shortest paths resolve identically for a replay.
func nextWaypoint(layout Map, from, target Point) (Point, bool) {
	fx, fy := int(math.Floor(float64(from.X))), int(math.Floor(float64(from.Y)))
	tx, ty := int(math.Floor(float64(target.X))), int(math.Floor(float64(target.Y)))
	if !layout.Walkable(fx, fy) || !layout.Walkable(tx, ty) {
		return Point{}, false
	}
	start, end := fy*MapWidth+fx, ty*MapWidth+tx
	if start == end {
		return target, true
	}
	var queue [MapWidth * MapHeight]int
	var seen [MapWidth * MapHeight]bool
	queue[0], seen[end] = end, true
	tail := 1
	for head := 0; head < tail; head++ {
		cell := queue[head]
		x, y := cell%MapWidth, cell/MapWidth
		for _, offset := range [4][2]int{{-1, 0}, {1, 0}, {0, -1}, {0, 1}} {
			nx, ny := x+offset[0], y+offset[1]
			if !layout.Walkable(nx, ny) {
				continue
			}
			next := ny*MapWidth + nx
			if seen[next] {
				continue
			}
			seen[next] = true
			if next == start {
				return Point{X: float32(cell%MapWidth) + 0.5, Y: float32(cell/MapWidth) + 0.5}, true
			}
			queue[tail], tail = next, tail+1
		}
	}
	return Point{}, false
}
