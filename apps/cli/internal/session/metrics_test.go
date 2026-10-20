package session

import (
	"bytes"
	"context"
	"strconv"
	"testing"

	"tailmouse/apps/cli/internal/leash"
	"tailmouse/apps/cli/internal/protocol"
)

func TestLeashMetricsTrackBoundedHistoryAndGeneration(t *testing.T) {
	for _, size := range []int{0, 1, 64 << 10, 3 << 20} {
		t.Run(strconv.Itoa(size), func(t *testing.T) {
			host, _, pump := terminalFixture(t, Config{}, bytes.Repeat([]byte{'x'}, size))
			metrics := host.InspectMetrics()
			if metrics.OutputRingUsed != min(size, 64<<10) || metrics.OutputDroppedBytes != uint64(max(0, size-(64<<10))) || metrics.ProcessGeneration != 1 {
				t.Fatalf("history metrics = %+v", metrics)
			}

			if allocations := testing.AllocsPerRun(100, func() { _ = pump.RetainedOutputBytes() }); allocations != 0 {
				t.Fatalf("history measurement allocated %v times", allocations)
			}
			next, err := leash.NewPump(&terminalFixturePTY{output: bytes.NewReader(nil), done: make(chan struct{})}, 64<<10, func(context.Context, []byte) error { return nil })
			if err != nil {
				t.Fatal(err)
			}
			if err := host.PublishLeash(protocol.ProcessState{Generation: 2, State: "running"}, next); err != nil {
				t.Fatal(err)
			}
			metrics = host.InspectMetrics()
			if metrics.ProcessGeneration != 2 || metrics.OutputRingUsed != 0 || metrics.OutputDroppedBytes != 0 {
				t.Fatalf("new generation retained old history metrics: %+v", metrics)
			}
		})
	}
}
