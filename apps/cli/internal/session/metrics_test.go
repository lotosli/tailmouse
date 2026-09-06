package session

import (
	"bytes"
	"context"
	"strconv"
	"testing"
	"testing/synctest"
	"time"

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
			if metrics.EscapeInputRate != 0 || metrics.EscapeSnapshotRate != 0 {
				t.Fatal("Leash reported Escape activity")
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

func TestEscapeMetricsUseActualElapsedWindowAndDeliveredSnapshots(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		host, _ := liveGameHost(t, false)
		if metrics := host.InspectMetrics(); metrics.EscapeInputRate != 0 || metrics.EscapeSnapshotRate != 0 || metrics.ProcessGeneration != 0 {
			t.Fatal("idle game reported activity")
		}
		peer := gamePeer(t, host)
		stop := keepGameInput(t, peer)
		time.Sleep(time.Second)
		synctest.Wait()
		first := host.InspectMetrics()
		firstSnapshots := peer.count(protocol.TypeGameSnapshot)
		if first.EscapeInputRate != 20 || first.EscapeSnapshotRate != float64(firstSnapshots) || firstSnapshots < 10 {
			t.Fatalf("one-second rates = %v/%v; delivered snapshots = %d", first.EscapeInputRate, first.EscapeSnapshotRate, firstSnapshots)
		}
		time.Sleep(500 * time.Millisecond)
		synctest.Wait()
		cached := host.InspectMetrics()
		if cached.EscapeInputRate != first.EscapeInputRate || cached.EscapeSnapshotRate != first.EscapeSnapshotRate {
			t.Fatal("subsecond inspection reset the measurement window")
		}
		time.Sleep(time.Second)
		synctest.Wait()
		second := host.InspectMetrics()
		wantSnapshots := float64(peer.count(protocol.TypeGameSnapshot)-firstSnapshots) / 1.5
		if second.EscapeInputRate != 20 || second.EscapeSnapshotRate != wantSnapshots {
			t.Fatalf("1.5-second rates = %v/%v, want 20/%v", second.EscapeInputRate, second.EscapeSnapshotRate, wantSnapshots)
		}
		stop()
		time.Sleep(time.Second)
		synctest.Wait()
		if metrics := host.InspectMetrics(); metrics.EscapeInputRate != 0 || metrics.OutputRingUsed != 0 || metrics.OutputDroppedBytes != 0 {
			t.Fatal("idle input or Escape mode retained unrelated activity")
		}
	})
}

func TestLeashDropDiagnosticsRepeatCumulativeSnapshotAndResetGeneration(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		events := make(chan Event, 1)
		host, err := NewHost(t.Context(), Config{Mode: "leash", SessionID: testHostID, ReconnectGrace: time.Minute}, time.Now(), func(event Event) error {
			if event.Kind == TerminalOutputDropped {
				events <- event
			}
			return nil
		})
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = host.Close("local_revoke") })
		if err := host.ConfigureLeash(); err != nil {
			t.Fatal(err)
		}
		if err := host.Listen("official", "relay.example.test", time.Now()); err != nil {
			t.Fatal(err)
		}
		for index, size := range []int{128 << 10, (64 << 10) + 1} {
			generation := uint32(index + 1)
			process := &terminalFixturePTY{output: bytes.NewReader(bytes.Repeat([]byte{'x'}, size)), done: make(chan struct{})}
			pump, err := leash.NewPump(process, 64<<10, func(context.Context, []byte) error { return nil })
			if err != nil {
				t.Fatal(err)
			}
			if err := pump.Run(t.Context()); err != nil {
				t.Fatal(err)
			}
			if err := host.PublishLeash(protocol.ProcessState{Generation: generation, State: "exited"}, pump); err != nil {
				t.Fatal(err)
			}
			for range 2 {
				browser, _ := connectTestHost(t, host, "leash", testHostID, 2)
				var count uint64
				for {
					frame, err := protocol.ReadFrame(t.Context(), browser, protocol.PeerBrowser, protocol.StateActiveLeash)
					if err != nil {
						t.Fatal(err)
					}
					if frame.Type == protocol.TypeOutputDropped {
						dropped, err := protocol.DecodeOutputDropped(frame)
						if err != nil {
							t.Fatal(err)
						}
						count = dropped.Bytes
					}
					if frame.Type == protocol.TypeProcessState {
						break
					}
				}
				synctest.Wait()
				select {
				case event := <-events:
					if count != uint64(size-(64<<10)) || event.Dropped.Generation != generation || event.Dropped.Bytes != count || event.Metrics.OutputDroppedBytes != count || event.Metrics.ProcessGeneration != generation {
						t.Fatal("reconnect accumulated the same loss twice or restart retained the old generation")
					}
				default:
					t.Fatal("snapshot drop event missing")
				}
				if err := browser.Close(); err != nil {
					t.Fatal(err)
				}
				synctest.Wait()
			}
		}
	})
}
