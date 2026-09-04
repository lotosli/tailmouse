package escape

import (
	"errors"
	"math"
	"strings"
	"testing"
)

func TestFivePrebuiltMapsHaveLegalDistinctReachableEntities(t *testing.T) {
	names := MapNames()
	if len(names) != 5 || MapWidth != 48 || MapHeight != 18 {
		t.Fatal("PRD map count or dimensions changed")
	}
	unique := make(map[[MapHeight]string]bool)
	for _, name := range names {
		t.Run(name, func(t *testing.T) {
			layout, err := SelectMap(name, 0)
			if err != nil || layout.Name != name {
				t.Fatal("prebuilt map selection failed")
			}
			if unique[layout.Rows] {
				t.Fatal("two named maps have the same layout")
			}
			unique[layout.Rows] = true
			entities := []Point{layout.Mouse, layout.Cat, layout.Cheese[0], layout.Cheese[1], layout.Exit}
			seen := make(map[Point]bool)
			for _, position := range entities {
				if seen[position] || !layout.Walkable(int(position.X), int(position.Y)) ||
					position.X-float32(int(position.X)) != 0.5 || position.Y-float32(int(position.Y)) != 0.5 {
					t.Fatal("entity is not at a distinct legal cell center")
				}
				seen[position] = true
			}
			visited := reachable(layout, int(layout.Mouse.X), int(layout.Mouse.Y))
			for _, position := range entities {
				if !visited[int(position.Y)*MapWidth+int(position.X)] {
					t.Fatal("an entity is unreachable from the mouse spawn")
				}
			}
			floor, wall := 0, 0
			for y, row := range layout.Rows {
				if len(row) != MapWidth {
					t.Fatal("map row width changed")
				}
				for x, cell := range row {
					if cell != '#' && cell != '.' {
						t.Fatal("entity marker leaked into the floor grid")
					}
					if x == 0 || x == MapWidth-1 || y == 0 || y == MapHeight-1 {
						if cell != '#' {
							t.Fatal("map border is open")
						}
					}
					if layout.Walkable(x, y) {
						floor++
						if !visited[y*MapWidth+x] {
							t.Fatal("map contains an isolated floor cell")
						}
					} else {
						wall++
					}
				}
			}
			if floor == 0 || wall <= 2*MapWidth+2*MapHeight-4 {
				t.Fatal("prebuilt map contains no useful interior geometry")
			}
		})
	}
}

func TestMapSelectionIsDeterministicAndDoesNotAliasSharedState(t *testing.T) {
	for _, seed := range []int64{math.MinInt64, -1, 0, 1, 42, math.MaxInt64} {
		first, err := SelectMap("random", seed)
		second, again := SelectMap("random", seed)
		if err != nil || again != nil || first != second {
			t.Fatal("same seed did not reproduce the complete map snapshot")
		}
		first.Rows[0] = strings.Repeat(".", MapWidth)
		first.Mouse.X = -100
		third, err := SelectMap("random", seed)
		if err != nil || second != third {
			t.Fatal("caller mutation changed a prebuilt map")
		}
	}
	selected := make(map[string]bool)
	for seed := int64(-256); seed < 256; seed++ {
		layout, err := SelectMap("random", seed)
		if err != nil {
			t.Fatal(err)
		}
		selected[layout.Name] = true
	}
	for _, name := range MapNames() {
		if !selected[name] {
			t.Fatal("a prebuilt map cannot be reached by seed selection")
		}
		first, err := SelectMap(name, math.MinInt64)
		second, again := SelectMap(name, math.MaxInt64)
		if err != nil || again != nil || first != second {
			t.Fatal("explicit map selection depends on a random seed")
		}
	}
	for _, name := range []string{"", "unknown", "RANDOM", "../courtyard"} {
		layout, err := SelectMap(name, 0)
		if !errors.Is(err, ErrInvalidMap) || layout != (Map{}) {
			t.Fatal("unknown map selection did not fail closed")
		}
	}
	var empty Map
	if empty.Walkable(0, 0) {
		t.Fatal("zero map exposed floor")
	}
	layout, _ := SelectMap("courtyard", 0)
	for _, cell := range [][2]int{{-1, 0}, {0, -1}, {MapWidth, 0}, {0, MapHeight}, {math.MaxInt, math.MinInt}} {
		if layout.Walkable(cell[0], cell[1]) {
			t.Fatal("out-of-bounds map cell is walkable")
		}
	}
}

func TestMapAssetValidationRejectsCorruptGeometryAndSpawnMarkers(t *testing.T) {
	rows := strings.Split(courtyard, "\n")
	wrongWidth := append([]string(nil), rows...)
	wrongWidth[1] += "."
	wrongWidth[2] = wrongWidth[2][1:]
	for _, invalid := range []string{
		"", courtyard + "\n", courtyard[:len(courtyard)-1],
		strings.Replace(courtyard, "\n", ".", 1), strings.Join(wrongWidth, "\n"),
		strings.Replace(courtyard, "#", ".", 1),
		strings.Replace(courtyard, "M", "?", 1),
		strings.Replace(courtyard, "M", ".", 1),
		strings.Replace(courtyard, ".", "M", 1),
	} {
		layout, err := parseMap("synthetic", invalid)
		if !errors.Is(err, ErrInvalidMap) || layout != (Map{}) {
			t.Fatal("corrupt map asset was accepted")
		}
	}
}

// Exhaustive flood fill covers every traversable cell, not only a hand-picked path.
func reachable(layout Map, startX, startY int) [MapWidth * MapHeight]bool {
	var visited [MapWidth * MapHeight]bool
	var queue [MapWidth * MapHeight]int
	start := startY*MapWidth + startX
	queue[0], visited[start] = start, true
	count := 1
	for next := 0; next < count; next++ {
		cell := queue[next]
		x, y := cell%MapWidth, cell/MapWidth
		for _, step := range [][2]int{{1, 0}, {-1, 0}, {0, 1}, {0, -1}} {
			nx, ny := x+step[0], y+step[1]
			if !layout.Walkable(nx, ny) {
				continue
			}
			index := ny*MapWidth + nx
			if !visited[index] {
				visited[index], queue[count] = true, index
				count++
			}
		}
	}
	return visited
}
