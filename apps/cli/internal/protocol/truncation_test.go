package protocol

import (
	"bytes"
	"context"
	"errors"
	"io"
	"strings"
	"testing"
)

func TestTruncationProvenancePreservesCodecRejection(t *testing.T) {
	for _, tail := range []io.Reader{bytes.NewReader(nil), interruptedFrameReader{}} {
		for _, prefix := range [][]byte{{0}, {0, 0, 0, 5}, {0, 0, 0, 5, byte(TypeTermInput)}, {0, 0, 0, 5, byte(TypeTermInput), 0}, {0, 0, 0, 5, byte(TypeTermInput), 0, 'o', 'l'}} {
			reader := io.NopCloser(io.MultiReader(bytes.NewReader(prefix), tail))
			frame, err := ReadFrame(t.Context(), reader, PeerHost, StateActiveLeash)
			if code, _ := ErrorCodeOf(err); code != CodeBadFrame || !IsTruncatedFrame(err) || frame.Type != 0 || len(frame.Payload) != 0 {
				t.Fatal("incomplete frame was dispatched or lost its local transport classification")
			}
			if strings.Contains(err.Error(), "private") {
				t.Fatal("read failure disclosed its underlying text")
			}
		}
	}
	for _, wire := range [][]byte{
		{0, 0, 0, 1},                                      // Invalid declared length.
		{0, 0x10, 0, 1},                                   // Global bound, before metadata/body.
		{0, 0, 0, 3, byte(TypeTermInput), 1},              // Invalid flags, before body.
		{0, 0, 0, 3, 0xff, 0},                             // Unknown type, before body.
		{0, 0, 0, 3, byte(TypeTermOutput), 0},             // Illegal direction, before body.
		{0, 0, 0x80, 1, byte(TypeTermInput), 0},           // Terminal bound, before body.
		{0, 0, 0, 6, byte(TypeTermResize), 0, 0, 1, 0, 1}, // Complete invalid payload.
	} {
		_, err := ReadFrame(t.Context(), io.NopCloser(bytes.NewReader(wire)), PeerHost, StateActiveLeash)
		if _, ok := ErrorCodeOf(err); !ok || IsTruncatedFrame(err) {
			t.Fatal("invalid input acquired a transport-recovery classification")
		}
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	_, canceled := ReadFrame(ctx, io.NopCloser(bytes.NewReader([]byte{0})), PeerHost, StateActiveLeash)
	for _, err := range []error{nil, canceled, &ProtocolError{Code: CodeBadFrame}, io.EOF} {
		if IsTruncatedFrame(err) {
			t.Fatal("cancellation, peer-style error or clean EOF acquired truncation provenance")
		}
	}
}

type interruptedFrameReader struct{}

func (interruptedFrameReader) Read([]byte) (int, error) {
	return 0, errors.New("synthetic private stream failure")
}
