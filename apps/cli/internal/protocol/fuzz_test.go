package protocol

import (
	"bytes"
	"context"
	"io"
	"testing"
)

func FuzzReadFrame(f *testing.F) {
	_, corpus := loadFixtureCorpus(f)
	for _, fixture := range corpus.Cases {
		wire := materializeFixture(f, fixture.Wire)
		if len(wire) <= 4096 {
			f.Add(wire)
		}
	}
	f.Fuzz(func(t *testing.T, wire []byte) {
		if len(wire) > MaxFrameLength+frameHeaderBytes {
			t.Skip()
		}
		// A fixed Escape receiver rejects terminal/handshake frames before
		// their payload decoders. Exercise every receiving phase so all shared
		// seeds and mutations reach their actual untrusted-value boundary.
		for _, receiver := range []struct {
			peer  Peer
			state State
		}{
			{PeerHost, StateAwaitClientHello}, {PeerBrowser, StateAwaitServerWelcome},
			{PeerHost, StateActiveLeash}, {PeerBrowser, StateActiveLeash},
			{PeerHost, StateActiveLeash}, {PeerBrowser, StateActiveLeash},
		} {
			frame, err := ReadFrame(context.Background(), io.NopCloser(bytes.NewReader(wire)), receiver.peer, receiver.state)
			if err == nil {
				if len(frame.Payload) > maxFramePayloadBytes {
					t.Fatal("decoder returned an oversized payload")
				}
				erase(frame.Payload)
			}
		}
	})
}
