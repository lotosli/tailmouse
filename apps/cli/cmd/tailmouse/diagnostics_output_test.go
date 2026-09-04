package main

import (
	"bytes"
	"strings"
	"testing"

	"tailmouse/apps/cli/internal/config"
	"tailmouse/apps/cli/internal/protocol"
	"tailmouse/apps/cli/internal/session"
)

func TestOutputDropDiagnosticsPreserveBoundsAndZero(t *testing.T) {
	var output bytes.Buffer
	log := newDiagnostics(config.Options{JSON: true}, &output)
	for _, count := range []uint64{0, 23, 1<<53 - 1} {
		event := session.Event{Kind: session.TerminalOutputDropped, Dropped: protocol.OutputDropped{Generation: 1<<32 - 1, Bytes: count}}
		if err := log.observe(event); err != nil {
			t.Fatal(err)
		}
	}
	events := decodeDiagnostics(t, output.String())
	if len(events) != 3 || !strings.Contains(output.String(), `"bytes":0`) {
		t.Fatal("drop events do not preserve the documented JSON field and zero value")
	}
	for index, event := range events {
		if event.Event != "output_dropped" || event.Generation != 1<<32-1 || event.DroppedBytes == nil || *event.DroppedBytes != []uint64{0, 23, 1<<53 - 1}[index] {
			t.Fatal("drop event lost its exact generation or cumulative count")
		}
	}
	assertSafeDiagnostics(t, output.String())
	output.Reset()
	for _, dropped := range []protocol.OutputDropped{{}, {Generation: 1, Bytes: 1 << 53}} {
		if err := log.observe(session.Event{Kind: session.TerminalOutputDropped, Dropped: dropped}); err == nil || output.Len() != 0 {
			t.Fatal("invalid drop count reached the diagnostic sink")
		}
	}
	failing := newDiagnostics(config.Options{JSON: true}, failingWriter{})
	event := session.Event{Kind: session.TerminalOutputDropped, Dropped: protocol.OutputDropped{Generation: 1, Bytes: 1}}
	first := failing.observe(event)
	if first == nil || failing.observe(event) != first {
		t.Fatal("drop diagnostic failure was ignored or replaced")
	}
}
