//go:build darwin || linux

package main

import (
	"bytes"
	"os"
	"slices"
	"testing"
)

func TestLeashCLIEmitsOrderedProcessDiagnostics(t *testing.T) {
	input, writer, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	var diagnostics bytes.Buffer
	fixture := startLeashCLIWithInput(t, "wait", input, writer, &diagnostics,
		"--json", "--start-on=now", "--title=tcSyntheticPrivateCommandTitle")
	fixture.awaitText(t, "child-ready")
	if _, err := writer.Write([]byte{'x'}); err != nil {
		t.Fatal(err)
	}
	fixture.result(t, 37)

	events := decodeDiagnostics(t, diagnostics.String())
	if len(events) == 0 {
		t.Fatal("process diagnostics are missing")
	}
	last := events[len(events)-1]
	// Existing final diagnostics classify a nonzero command status as a
	// terminal_failure while retaining mode_complete and the child exit code.
	if events[0].Event != "session_created" || last.Event != "terminal_failure" || last.Code != 37 || last.Reason != "mode_complete" {
		t.Fatalf("process diagnostic boundaries: first %s, last %s, code %d, reason %s", events[0].Event, last.Event, last.Code, last.Reason)
	}
	var states []string
	var pid uint64
	for _, event := range events {
		if event.Event != "process_state" {
			continue
		}
		states = append(states, event.State)
		if event.Generation != 1 || event.Session == "" {
			t.Fatal("process event lost its generation or session identity")
		}
		if event.State == "running" {
			if event.PID == nil || *event.PID == 0 {
				t.Fatal("running process diagnostic omitted the child PID")
			}
			pid = *event.PID
		}
		if event.State == "exited" && (event.PID == nil || *event.PID != pid || event.ExitCode == nil || *event.ExitCode != 37) {
			t.Fatal("exit diagnostic did not retain the same child result")
		}
	}
	if !slices.Equal(states, []string{"waiting", "starting", "running", "exited"}) {
		t.Fatal("CLI process diagnostic order is incomplete")
	}
	assertSafeDiagnostics(t, diagnostics.String(), "tcSyntheticPrivateCommandTitle", "child-ready")
}
