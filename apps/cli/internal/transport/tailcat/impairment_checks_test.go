//go:build tailcatintegration

package tailcat

import (
	"bufio"
	"bytes"
	"io"
	"net"
	"testing"
	"time"

	"tailscale.com/derp"
)

func TestImpairmentSchedule(t *testing.T) {
	now := time.Now()
	for _, loss := range []int{0, 1, 5} {
		link := &relayImpairment{}
		link.configure(impairmentProfile{RTTMS: 150, Loss: loss, Kbit: 64})
		for side := range 2 {
			delivered := 0
			for range 100 {
				arrival, ok := link.schedule(side, 800, now)
				if !ok {
					continue
				}
				delivered++
				want := now.Add(75*time.Millisecond + time.Duration(delivered)*100*time.Millisecond)
				if !arrival.Equal(want) {
					t.Fatal("bandwidth serialization or propagation delay changed")
				}
			}
			if delivered != 100-loss {
				t.Fatal("loss did not discard the configured fraction of whole packets")
			}
		}
		link.pause(time.Second)
		if _, ok := link.schedule(0, 800, now); ok {
			t.Fatal("outage forwarded a packet")
		}
	}
	link := &relayImpairment{}
	link.configure(impairmentProfile{RTTMS: 150, JitterMS: 30})
	seen := make(map[time.Duration]bool)
	for range 50 {
		arrival, ok := link.schedule(1, 10, now)
		delay := arrival.Sub(now)
		if !ok || delay < 60*time.Millisecond || delay > 90*time.Millisecond {
			t.Fatal("jitter exceeded its explicit one-way envelope")
		}
		seen[delay] = true
	}
	if len(seen) < 20 {
		t.Fatal("jitter did not actually vary delivery time")
	}
}

func TestImpairmentRestorePreservesEvidence(t *testing.T) {
	network := NewLocalTestNetwork(TestNetworkProfile{RTTMS: 150, Loss: 50, Kbit: 64})
	now := time.Now()
	for side := range 2 {
		arrival, ok := network.link.schedule(side, 800, now)
		if !ok || !arrival.Equal(now.Add(175*time.Millisecond)) {
			t.Fatal("shared fixture did not apply its configured link")
		}
		if _, ok := network.link.schedule(side, 800, now); ok {
			t.Fatal("shared fixture did not apply loss")
		}
	}
	network.Pause(15 * time.Second)
	if _, ok := network.link.schedule(0, 800, now); ok {
		t.Fatal("shared fixture did not apply its pause")
	}
	before := network.Inspect()
	network.Restore()
	after := network.Inspect()
	for side := range 2 {
		want := before[side]
		want.next = time.Time{}
		if after[side] != want {
			t.Fatal("restoration erased or changed measured evidence")
		}
		for range 4 {
			arrival, ok := network.link.schedule(side, 800, now)
			if !ok || !arrival.Equal(now) {
				t.Fatal("restoration retained a pause, loss, bandwidth or delay")
			}
		}
	}
}

func TestImpairmentFramesAndCancellation(t *testing.T) {
	for _, rebuilt := range []bool{false, true} {
		name := "hijacked-reader"
		if rebuilt {
			name = "rebuilt-reader"
		}
		t.Run(name, func(t *testing.T) { testImpairmentFramesAndCancellation(t, rebuilt) })
	}
}

func testImpairmentFramesAndCancellation(t *testing.T, rebuilt bool) {
	link := &relayImpairment{}
	link.configure(impairmentProfile{RTTMS: 40, Loss: 5, Kbit: 1024})
	source, destination := net.Pipe()
	shaped, reader := link.connection(destination, bufio.NewReader(destination), 0)
	if rebuilt {
		// The updated DERP HTTP handler replaces the hijacked reader. Its
		// underlying connection must still read exclusively through shaping.
		reader = bufio.NewReaderSize(shaped, 1024)
	}
	deadline := time.AfterFunc(2*time.Second, func() { _ = source.Close(); _ = shaped.Close() })
	t.Cleanup(func() { deadline.Stop() })
	t.Cleanup(func() { _ = source.Close(); _ = shaped.Close() })
	wrote := make(chan error, 1)
	go func() {
		writer := bufio.NewWriter(source)
		if err := derp.WriteFrame(writer, derp.FrameNotePreferred, []byte{1}); err != nil {
			wrote <- err
			return
		}
		for index := range 20 {
			payload := bytes.Repeat([]byte{byte(index)}, 40)
			if err := derp.WriteFrame(writer, derp.FrameSendPacket, payload); err != nil {
				wrote <- err
				return
			}
		}
		wrote <- nil
	}()
	for index := range 20 {
		kind, size, err := derp.ReadFrameHeader(reader)
		if err != nil {
			t.Fatal(err)
		}
		if size > 40 {
			t.Fatal("invalid synthetic frame size")
		}
		payload := make([]byte, size)
		if _, err := io.ReadFull(reader, payload); err != nil {
			t.Fatal(err)
		}
		if index == 0 {
			if kind != derp.FrameNotePreferred || !bytes.Equal(payload, []byte{1}) {
				t.Fatal("control frame changed")
			}
		} else if kind != derp.FrameSendPacket || !bytes.Equal(payload, bytes.Repeat([]byte{byte(index - 1)}, 40)) {
			t.Fatal("packet bytes or ordering changed")
		}
	}
	if err := <-wrote; err != nil {
		t.Fatal(err)
	}
	stats := link.inspect()[0]
	if stats.Packets != 20 || stats.Dropped != 1 || stats.DelayMinMS < 20 || stats.MaxQueue > 128 {
		t.Fatalf("impairment did not match its measured envelope: %+v", stats)
	}
	closed := make(chan struct{})
	go func() { _ = shaped.Close(); close(closed) }()
	select {
	case <-closed:
	case <-time.After(time.Second):
		t.Fatal("cancel did not join impairment workers")
	}
}

func TestImpairmentDisconnectClosesBothUnderlyingTransports(t *testing.T) {
	link := &relayImpairment{}
	if err := link.disconnect(); err == nil {
		t.Fatal("disconnect without both transports succeeded")
	}
	var peers [2]net.Conn
	var connections [2]*impairedConnection
	for side := range 2 {
		local, peer := net.Pipe()
		if err := peer.SetReadDeadline(time.Now().Add(time.Second)); err != nil {
			t.Fatal(err)
		}
		peers[side] = peer
		connections[side], _ = link.connection(local, bufio.NewReader(local), side)
		t.Cleanup(func() { _ = peer.Close(); _ = connections[side].Close() })
	}
	if err := link.disconnect(); err != nil {
		t.Fatal(err)
	}
	for side, peer := range peers {
		select {
		case <-connections[side].done:
		default:
			t.Fatal("disconnect retained a packet worker")
		}
		if _, err := peer.Read(make([]byte, 1)); err != io.EOF {
			t.Fatal("disconnect did not close the underlying peer")
		}
		if link.inspect()[side].Connections != 1 {
			t.Fatal("transport connection count changed")
		}
	}
	if err := link.disconnect(); err == nil {
		t.Fatal("closed transports remained available for another disconnect")
	}
}
