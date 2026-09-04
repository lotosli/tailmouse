package session

import (
	"testing"
	"testing/synctest"
	"time"

	"tailmouse/apps/cli/internal/protocol"
)

func TestEscapeInputStreamDrainBoundary(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		host, _ := liveGameHost(t, false)
		type boundaryState struct {
			last, drained time.Time
			blocked       bool
		}
		boundary := func() boundaryState {
			host.game.mu.Lock()
			defer host.game.mu.Unlock()
			return boundaryState{host.game.lastInput, host.game.inputDrained, host.game.inputBlocked}
		}
		peer := gamePeer(t, host)
		peer.mu.Lock()
		peer.withholdPong = true
		peer.mu.Unlock()
		stop := keepGameInput(t, peer)
		time.Sleep(3 * time.Second)
		synctest.Wait()
		stop()
		peer.movement(t, 61, 1, 0, false)
		time.Sleep(200 * time.Millisecond)
		synctest.Wait()
		before := host.InspectEscapeView()
		lastInput := boundary().last
		if !boundary().blocked || before.State.AcceptedSequence != 61 {
			t.Fatal("input gap did not establish a stream boundary")
		}
		lastPing := func() []byte {
			peer.mu.Lock()
			defer peer.mu.Unlock()
			for index := len(peer.frames) - 1; index >= 0; index-- {
				if peer.frames[index].Type == protocol.TypePing {
					return append([]byte(nil), peer.frames[index].Payload...)
				}
			}
			t.Fatal("expected ordinary ping missing")
			return nil
		}
		oldPing := lastPing()
		peer.movement(t, 62, 0, 1, false)
		peer.movement(t, 63, 0, 1, true)
		if err := peer.send(protocol.Frame{Type: protocol.TypePong, Payload: oldPing}); err != nil {
			t.Fatal(err)
		}
		synctest.Wait()
		if boundary().last != lastInput || !boundary().blocked {
			t.Fatal("stale data or a pre-gap pong refreshed input")
		}
		if current := host.InspectEscapeView(); current.State.AcceptedSequence != 61 || current.State.PendingDash != 0 {
			t.Fatal("old buffered input crossed the boundary")
		}
		rejected := 0
		peer.mu.Lock()
		for _, frame := range peer.frames {
			if frame.Type == protocol.TypeGameEvent {
				event, err := protocol.DecodeGameEvent(frame, protocol.PeerHost)
				if err == nil && event.Event == "dash_rejected" {
					rejected++
				}
			}
		}
		peer.mu.Unlock()
		if rejected != 1 {
			t.Fatal("stale dash was not explicitly rejected exactly once")
		}
		time.Sleep(800 * time.Millisecond)
		synctest.Wait()
		freshPing := lastPing()
		invalid := append([]byte(nil), freshPing...)
		invalid[15] ^= 1
		if err := peer.send(protocol.Frame{Type: protocol.TypePong, Payload: invalid}); err != nil {
			t.Fatal(err)
		}
		synctest.Wait()
		if !boundary().blocked {
			t.Fatal("unvalidated pong opened the input boundary")
		}
		if err := peer.send(protocol.Frame{Type: protocol.TypePong, Payload: freshPing}); err != nil {
			t.Fatal(err)
		}
		synctest.Wait()
		if boundary().blocked || boundary().drained.IsZero() || boundary().last != lastInput {
			t.Fatal("validated boundary failed or refreshed the silence deadline")
		}
		// A second outage before the first fresh input must not inherit an
		// indefinitely valid drain confirmation from the first outage.
		time.Sleep(200 * time.Millisecond)
		synctest.Wait()
		peer.movement(t, 64, 0, 1, false)
		if !boundary().blocked || host.InspectEscapeView().State.AcceptedSequence != 61 {
			t.Fatal("an expired drain confirmation admitted another old backlog")
		}
		// The next 30 Hz tick observes the exact three-second silence boundary.
		time.Sleep(1840 * time.Millisecond)
		synctest.Wait()
		paused := host.InspectEscapeView()
		if !paused.State.Paused || paused.State.Mouse.Y != before.State.Mouse.Y {
			t.Fatal("old direction replayed or pong prevented the three-second pause")
		}
		if err := peer.send(protocol.Frame{Type: protocol.TypePong, Payload: lastPing()}); err != nil {
			t.Fatal(err)
		}
		synctest.Wait()
		peer.movement(t, 65, 0, 0, false)
		time.Sleep(40 * time.Millisecond)
		synctest.Wait()
		if state := host.InspectEscapeView().State; state.Paused || state.AcceptedSequence != 65 || state.Mouse.Y != before.State.Mouse.Y {
			t.Fatal("fresh input failed to resume without replay")
		}
		time.Sleep(200 * time.Millisecond)
		synctest.Wait()
		if !boundary().blocked {
			t.Fatal("a later gap reused the previous drained boundary")
		}
		_ = peer.conn.Close()
		<-peer.done
		synctest.Wait()
		replacement := gamePeer(t, host)
		replacement.movement(t, 66, 0, 0, false)
		if state := host.InspectEscapeView().State; state.AcceptedSequence != 66 || boundary().blocked {
			t.Fatal("fresh connection retained the old transport backlog")
		}
	})
}
