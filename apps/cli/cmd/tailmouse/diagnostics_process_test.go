package main

import (
	"bytes"
	"strings"
	"testing"

	"tailmouse/apps/cli/internal/config"
	"tailmouse/apps/cli/internal/protocol"
)

func TestProcessDiagnosticsPreserveStateWithoutPrivateTitle(t *testing.T) {
	for _, mode := range []string{"human", "json", "quiet", "verbose", "json-verbose"} {
		t.Run(mode, func(t *testing.T) {
			var output bytes.Buffer
			options := config.Options{JSON: strings.Contains(mode, "json"), Quiet: mode == "quiet", Verbose: strings.Contains(mode, "verbose")}
			log := newDiagnostics(options, &output)
			pid, code, signal := uint64(42), int(0xC000013A), "SIGTERM"
			states := []protocol.ProcessState{
				{Generation: 1, State: "waiting"},
				{Generation: 1, State: "starting"},
				{Generation: 1, State: "running", PID: &pid},
				{Generation: 1, State: "interrupting", PID: &pid},
				{Generation: 1, State: "terminating", PID: &pid},
				{Generation: 1, State: "exited", PID: &pid, ExitCode: &code, Signal: &signal},
				{Generation: 2, State: "restarting"},
				{Generation: 2, State: "failed"},
				{Generation: 2, State: "closing"},
			}
			for _, state := range states {
				state.Title = "tcSyntheticPrivateCommandTitle"
				if err := log.processState(state); err != nil {
					t.Fatal(err)
				}
			}
			assertSafeDiagnostics(t, output.String(), "tcSyntheticPrivateCommandTitle")
			if options.Quiet {
				if output.Len() != 0 {
					t.Fatal("quiet emitted nonessential process events")
				}
				return
			}
			if options.JSON {
				events := decodeDiagnostics(t, output.String())
				if len(events) != len(states) {
					t.Fatal("process events were lost or combined")
				}
				for index, event := range events {
					state := states[index]
					if event.Event != "process_state" || event.State != state.State || event.Generation != state.Generation || event.TS == "" {
						t.Fatal("process event lost its typed identity")
					}
					if (event.PID == nil) != (state.PID == nil) || state.PID != nil && *event.PID != *state.PID ||
						(event.ExitCode == nil) != (state.ExitCode == nil) || state.ExitCode != nil && *event.ExitCode != *state.ExitCode ||
						(event.Signal == nil) != (state.Signal == nil) || state.Signal != nil && *event.Signal != *state.Signal {
						t.Fatal("process event changed its optional values")
					}
				}
			} else {
				for _, text := range []string{"process    waiting; generation 1", "process    running; generation 1; pid 42", "exit 3221225786; signal SIGTERM", "process    closing; generation 2"} {
					if !strings.Contains(output.String(), text) {
						t.Fatal("human process diagnostic omitted safe state")
					}
				}
			}
		})
	}
}

func TestProcessDiagnosticsRejectInvalidStateAndPreserveSinkFailure(t *testing.T) {
	var output bytes.Buffer
	log := newDiagnostics(config.Options{JSON: true}, &output)
	for _, state := range []protocol.ProcessState{{Generation: 0, State: "running"}, {Generation: 1, State: "tcSyntheticPrivateState"}} {
		if err := log.processState(state); err == nil || output.Len() != 0 {
			t.Fatal("invalid process state reached the diagnostic sink")
		}
	}
	code := 0
	if err := log.processState(protocol.ProcessState{Generation: 1, State: "exited", ExitCode: &code}); err != nil {
		t.Fatal(err)
	}
	if event := decodeDiagnostics(t, output.String())[0]; event.ExitCode == nil || *event.ExitCode != 0 {
		t.Fatal("zero child status disappeared from JSON")
	}
	failing := newDiagnostics(config.Options{JSON: true}, failingWriter{})
	first := failing.processState(protocol.ProcessState{Generation: 1, State: "waiting"})
	if first == nil || failing.processState(protocol.ProcessState{Generation: 1, State: "starting"}) != first {
		t.Fatal("process diagnostic sink failure was replaced or ignored")
	}
}
