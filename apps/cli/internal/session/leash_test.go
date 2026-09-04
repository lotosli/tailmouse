package session

import (
	"bytes"
	"context"
	"encoding/binary"
	"fmt"
	"slices"
	"testing"
	"time"

	"tailmouse/apps/cli/internal/leash"
	"tailmouse/apps/cli/internal/protocol"
)

type terminalFixturePTY struct {
	output *bytes.Reader
	done   chan struct{}
}

func (process *terminalFixturePTY) Read(_ context.Context, data []byte) (int, error) {
	return process.output.Read(data)
}
func (process *terminalFixturePTY) Write(ctx context.Context, _ []byte) error { return ctx.Err() }
func (process *terminalFixturePTY) Done() <-chan struct{}                     { return process.done }

func terminalFixture(t *testing.T, config Config, output []byte) (*Host, *hostConnection, *leash.Pump) {
	t.Helper()
	config.Mode, config.SessionID = "leash", testHostID
	config.ReconnectGrace = time.Minute
	host, err := NewHost(t.Context(), config, time.Now(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := host.ConfigureLeash(); err != nil {
		t.Fatal(err)
	}
	if err := host.Listen("official", "relay.example.com", time.Now()); err != nil {
		t.Fatal(err)
	}
	lease, err := host.Authority.Acquire(testHostID, "leash", time.Now())
	if err != nil {
		t.Fatal(err)
	}
	process := &terminalFixturePTY{output: bytes.NewReader(output), done: make(chan struct{})}
	pump, err := leash.NewPump(process, 64<<10, func(context.Context, []byte) error { return nil })
	if err != nil {
		t.Fatal(err)
	}
	if output != nil {
		if err := pump.Run(t.Context()); err != nil {
			t.Fatal(err)
		}
	}
	if err := host.PublishLeash(protocol.ProcessState{Generation: 1, State: "running"}, pump); err != nil {
		t.Fatal(err)
	}
	connection := &hostConnection{host: host, ctx: t.Context(), lease: lease, leashWake: make(chan struct{}, 1)}
	host.terminal.attach(connection)
	t.Cleanup(func() { host.terminal.detach(connection) })
	return host, connection, pump
}

func assertTerminalCode(t *testing.T, err error, want protocol.ErrorCode) {
	t.Helper()
	if code, ok := protocol.ErrorCodeOf(err); !ok || code != want {
		t.Fatalf("terminal error = %v, want %s", err, want)
	}
}

func TestLeashPublishesFullWidthExitStatus(t *testing.T) {
	for _, want := range []int{259, 0xC000013A, 0xFFFFFFFF} {
		t.Run(fmt.Sprint(want), func(t *testing.T) {
			host, connection, pump := terminalFixture(t, Config{}, []byte("retained output"))
			code := want
			if err := host.PublishLeash(protocol.ProcessState{Generation: 1, State: "exited", ExitCode: &code}, pump); err != nil {
				t.Fatal(err)
			}
			code = 0 // Publication owns a copy, not the caller's mutable pointer.
			for range 10 {
				frame, ok, err := host.terminal.next(connection)
				if err != nil || !ok {
					t.Fatalf("exit state was not delivered: %v", err)
				}
				if frame.Type != protocol.TypeProcessState {
					continue
				}
				value, err := protocol.DecodeProcessState(frame)
				if err != nil || value.State != "exited" || value.ExitCode == nil || *value.ExitCode != want {
					t.Fatalf("exit state changed: %+v, %v", value, err)
				}
				return
			}
			t.Fatal("exit state exceeded the bounded frame sequence")
		})
	}
}

func TestLeashHostChecksPermissionsBeforeEffects(t *testing.T) {
	for _, test := range []struct {
		name   string
		config Config
		action string
		code   protocol.ErrorCode
	}{
		{"readonly input", Config{Readonly: true}, "input", protocol.CodeReadonly},
		{"readonly resize", Config{Readonly: true}, "resize", protocol.CodeReadonly},
		{"readonly interrupt", Config{Readonly: true}, "interrupt", protocol.CodeReadonly},
		{"disabled restart", Config{NoRestart: true}, "restart", protocol.CodeRestartDisabled},
		{"disabled terminate", Config{NoTerminate: true}, "terminate", protocol.CodeTerminateDisabled},
	} {
		t.Run(test.name, func(t *testing.T) {
			host, connection, pump := terminalFixture(t, test.config, nil)
			frame, _ := protocol.ProcessControlFrame(protocol.ProcessControl{Generation: 1, Action: test.action})
			if test.action == "input" {
				frame = protocol.Frame{Type: protocol.TypeTermInput, Payload: []byte("q")}
			}
			if test.action == "resize" {
				frame = protocol.Frame{Type: protocol.TypeTermResize, Payload: []byte{0, 80, 0, 24}}
			}
			assertTerminalCode(t, host.terminal.input(connection, frame), test.code)
			if pump.PendingInput() != 0 || host.terminal.control != nil || host.terminal.size != nil {
				t.Fatal("denied request caused a terminal effect")
			}
		})
	}
}

func TestLeashHostInputAndControlBounds(t *testing.T) {
	host, connection, pump := terminalFixture(t, Config{}, nil)
	input := protocol.Frame{Type: protocol.TypeTermInput, Payload: bytes.Repeat([]byte{1}, leash.TerminalChunkBytes)}
	for index := 0; index < 8; index++ {
		if err := host.terminal.input(connection, input); err != nil {
			t.Fatal(err)
		}
	}
	assertTerminalCode(t, host.terminal.input(connection, input), protocol.CodeBackpressure)
	if pump.PendingInput() != 8*leash.TerminalChunkBytes {
		t.Fatal("overflow mutated the accepted input queue")
	}
	wrong, _ := protocol.ProcessControlFrame(protocol.ProcessControl{Generation: 2, Action: "restart"})
	assertTerminalCode(t, host.terminal.input(connection, wrong), protocol.CodeUnauthorized)
	for _, action := range []string{"interrupt", "terminate", "restart"} {
		host.terminal.state.State = "running"
		frame, _ := protocol.ProcessControlFrame(protocol.ProcessControl{Generation: 1, Action: action})
		if err := host.terminal.input(connection, frame); err != nil {
			t.Fatal(err)
		}
		assertTerminalCode(t, host.terminal.input(connection, frame), protocol.CodeBackpressure)
		select {
		case <-host.LeashControls():
		default:
			t.Fatal("process owner was not woken")
		}
		request, ok := host.TakeLeashControl()
		if !ok || request.Action != action {
			t.Fatal("control did not reach the process owner")
		}
	}
	if _, ok := host.TakeLeashControl(); ok {
		t.Fatal("control replayed")
	}
	host.terminal.state.State = "waiting"
	assertTerminalCode(t, host.terminal.input(connection, input), protocol.CodeProcessNotRunning)
	frame, _ := protocol.ProcessControlFrame(protocol.ProcessControl{Generation: 1, Action: "restart"})
	assertTerminalCode(t, host.terminal.input(connection, frame), protocol.CodeProcessNotRunning)
	host.terminal.state.State = "running"
	if err := host.terminal.input(connection, frame); err != nil {
		t.Fatal(err)
	}
	host.Authority.Disconnect(connection.lease, time.Now())
	if _, ok := host.TakeLeashControl(); ok {
		t.Fatal("disconnected lease retained a queued process control")
	}
	assertTerminalCode(t, host.terminal.input(connection, input), protocol.CodeUnauthorized)
}

func TestLeashResetSnapshotAndGenerationBarrier(t *testing.T) {
	data := bytes.Repeat([]byte("raw\x1b[31m\x00"), 20000)
	host, connection, pump := terminalFixture(t, Config{}, data)
	var output []byte
	var dropped uint64
	for index := 0; ; index++ {
		frame, ok, err := host.terminal.next(connection)
		if err != nil {
			t.Fatal(err)
		}
		if !ok {
			break
		}
		if index == 0 && frame.Type != protocol.TypeTermReset {
			t.Fatal("snapshot did not start with reset")
		}
		switch frame.Type {
		case protocol.TypeTermOutput:
			output = append(output, frame.Payload...)
		case protocol.TypeOutputDropped:
			value, _ := protocol.DecodeOutputDropped(frame)
			dropped = value.Bytes
		case protocol.TypeProcessState:
			value, _ := protocol.DecodeProcessState(frame)
			if value.State != "running" {
				t.Fatal("wrong process state")
			}
		}
	}
	if !bytes.Equal(output, data[len(data)-(64<<10):]) || dropped != uint64(len(data)-(64<<10)) {
		t.Fatal("reconnect snapshot/drop boundary changed bytes")
	}
	if host.terminal.history != nil {
		t.Fatal("drained snapshot retained its copied buffer")
	}
	if host.leashOutput(connection) == nil {
		t.Fatal("subscription wakeup missing")
	}
	if err := host.PublishLeash(protocol.ProcessState{Generation: 2, State: "running"}, pump); err != nil {
		t.Fatal(err)
	}
	input := protocol.Frame{Type: protocol.TypeTermInput, Payload: []byte("old input")}
	assertTerminalCode(t, host.terminal.input(connection, input), protocol.CodeBackpressure)
	ping := protocol.Frame{Type: protocol.TypePing, Payload: make([]byte, 16)}
	binary.BigEndian.PutUint64(ping.Payload, 42)
	host.terminal.ping(connection, ping)
	if host.terminal.barrierPing != nil {
		t.Fatal("drain ping preceded reset/history/state")
	}
	for {
		_, ok, err := host.terminal.next(connection)
		if err != nil {
			t.Fatal(err)
		}
		if !ok {
			break
		}
	}
	host.terminal.ping(connection, ping)
	host.terminal.pong(connection, make([]byte, 16))
	if !host.terminal.barrier {
		t.Fatal("unmatched PONG released old input")
	}
	host.terminal.pong(connection, ping.Payload)
	if host.terminal.barrier {
		t.Fatal("ordered PONG failed to release new generation")
	}
	host.terminal.detach(connection)
	if host.leashOutput(connection) != nil {
		t.Fatal("detached reader remained subscribed")
	}
	if _, ok, err := host.terminal.next(connection); ok || err != nil {
		t.Fatal("detached reader retained output")
	}
	assertTerminalCode(t, host.terminal.input(connection, input), protocol.CodeUnauthorized)
}

func terminalStates(t *testing.T, host *Host, connection *hostConnection) []protocol.ProcessState {
	t.Helper()
	var states []protocol.ProcessState
	for range 8 {
		frame, ok, err := host.terminal.next(connection)
		if err != nil {
			t.Fatal(err)
		}
		if !ok {
			return states
		}
		if frame.Type == protocol.TypeProcessState {
			state, err := protocol.DecodeProcessState(frame)
			if err != nil {
				t.Fatal(err)
			}
			states = append(states, state)
		}
	}
	t.Fatal("small terminal fixture exceeded its bounded frame sequence")
	return nil
}

func TestLeashInterruptAcknowledgmentSurvivesCoalescedRunningState(t *testing.T) {
	for _, drainFirst := range []bool{false, true} {
		t.Run(fmt.Sprintf("drainFirst=%t", drainFirst), func(t *testing.T) {
			host, connection, pump := terminalFixture(t, Config{}, nil)
			terminalStates(t, host, connection)
			control, err := protocol.ProcessControlFrame(protocol.ProcessControl{Generation: 1, Action: "interrupt"})
			if err != nil {
				t.Fatal(err)
			}
			if err := host.terminal.input(connection, control); err != nil {
				t.Fatal("fixture could not request interrupt", err)
			}
			if _, ok := host.TakeLeashControl(); !ok {
				t.Fatal("authorized interrupt did not reach the owner")
			}
			var states []protocol.ProcessState
			if drainFirst {
				states = terminalStates(t, host, connection)
			}
			if err := host.PublishLeash(protocol.ProcessState{Generation: 1, State: "running"}, pump); err != nil {
				t.Fatal(err)
			}
			states = append(states, terminalStates(t, host, connection)...)
			var names []string
			for _, state := range states {
				if state.Generation != 1 {
					t.Fatal("interrupt changed generation")
				}
				names = append(names, state.State)
			}
			if !slices.Equal(names, []string{"interrupting", "running"}) {
				t.Fatalf("interrupt acknowledgment was lost or repeated: %v", names)
			}
			if err := host.terminal.input(connection, protocol.Frame{Type: protocol.TypeTermInput, Payload: []byte("q")}); err != nil || pump.PendingInput() != 1 {
				t.Fatal("running child did not accept input after acknowledgment", err)
			}
		})
	}
}

func TestLeashInterruptAcknowledgmentDoesNotSurviveSnapshotReplacement(t *testing.T) {
	for _, replacement := range []string{"generation", "pump", "stream", "detach"} {
		t.Run(replacement, func(t *testing.T) {
			host, connection, pump := terminalFixture(t, Config{}, nil)
			terminalStates(t, host, connection)
			if err := host.PublishLeash(protocol.ProcessState{Generation: 1, State: "interrupting"}, pump); err != nil {
				t.Fatal(err)
			}
			for range 3 {
				if err := host.PublishLeash(protocol.ProcessState{Generation: 1, State: "running"}, pump); err != nil {
					t.Fatal(err)
				}
			}
			generation := uint32(1)
			switch replacement {
			case "generation":
				generation = 2
				if err := host.PublishLeash(protocol.ProcessState{Generation: generation, State: "running"}, pump); err != nil {
					t.Fatal(err)
				}
			case "pump":
				if err := host.PublishLeash(protocol.ProcessState{Generation: 1, State: "running"}, nil); err != nil {
					t.Fatal(err)
				}
			case "stream", "detach":
				previous := connection
				host.Authority.Disconnect(previous.lease, time.Now())
				lease, err := host.Authority.Acquire(testHostID, "leash", time.Now())
				if err != nil {
					t.Fatal(err)
				}
				if replacement == "detach" {
					host.terminal.detach(previous)
				}
				connection = &hostConnection{host: host, ctx: t.Context(), lease: lease, leashWake: make(chan struct{}, 1)}
				host.terminal.attach(connection)
				t.Cleanup(func() { host.terminal.detach(connection) })
				if _, ok, err := host.terminal.next(previous); ok || err != nil {
					t.Fatal("old stream received a replacement's frame", err)
				}
			}
			states := terminalStates(t, host, connection)
			if len(states) != 1 || states[0].State != "running" || states[0].Generation != generation {
				t.Fatalf("replacement replayed an old interrupt acknowledgment: %+v", states)
			}
		})
	}
}

func TestLeashQueuedControlRechecksProcessStateBeforeEffect(t *testing.T) {
	for _, state := range []string{"exited", "failed", "waiting"} {
		for _, action := range []string{"interrupt", "terminate", "restart"} {
			t.Run(state+"/"+action, func(t *testing.T) {
				host, connection, pump := terminalFixture(t, Config{}, nil)
				frame, err := protocol.ProcessControlFrame(protocol.ProcessControl{Generation: 1, Action: action})
				if err != nil {
					t.Fatal(err)
				}
				if err := host.terminal.input(connection, frame); err != nil {
					t.Fatal(err)
				}
				if err := host.PublishLeash(protocol.ProcessState{Generation: 1, State: state}, pump); err != nil {
					t.Fatal(err)
				}
				_, ok := host.TakeLeashControl()
				if want := state == "exited" && action == "restart"; ok != want {
					t.Fatalf("queued %s reached %s process: effect=%t, want=%t", action, state, ok, want)
				}
			})
		}
	}
}

func TestLeashConfigurationAndResizeAreFailClosed(t *testing.T) {
	host, connection, pump := terminalFixture(t, Config{}, nil)
	if host.ConfigureLeash() == nil {
		t.Fatal("reconfiguration accepted")
	}
	for _, state := range []protocol.ProcessState{{State: "running"}, {Generation: 3, State: "running"}, {Generation: 1, State: "unknown"}} {
		if host.PublishLeash(state, pump) == nil {
			t.Fatal("invalid publication accepted")
		}
	}
	for _, size := range [][2]int{{19, 24}, {80, 201}, {501, 5}, {80, 4}} {
		if host.ResizeLeash(size[0], size[1], time.Now()) == nil {
			t.Fatal("invalid native resize accepted")
		}
	}
	frame := protocol.Frame{Type: protocol.TypeTermResize, Payload: []byte{0, 90, 0, 30}}
	if err := host.terminal.input(connection, frame); err != nil {
		t.Fatal(err)
	}
	if err := host.ResizeLeash(100, 40, time.Now()); err != nil {
		t.Fatal(err)
	}
	select {
	case <-host.LeashSizes():
	default:
		t.Fatal("resize did not wake owner")
	}
	size, ok := host.TakeLeashSize()
	if !ok || size.Columns != 100 || size.Rows != 40 || !host.AcceptLeashSize(size) {
		t.Fatal("resize was not last-writer-wins")
	}
	host.AppliedLeashSize(size)
	if _, ok := host.TakeLeashSize(); ok {
		t.Fatal("resize replayed")
	}
	if err := host.terminal.input(connection, frame); err != nil {
		t.Fatal(err)
	}
	size, ok = host.TakeLeashSize()
	if !ok {
		t.Fatal("authorized resize missing")
	}
	host.Authority.Disconnect(connection.lease, time.Now())
	if host.AcceptLeashSize(size) {
		t.Fatal("disconnected resize survived debounce")
	}
	host.terminal.size = &size
	if _, ok := host.TakeLeashSize(); ok {
		t.Fatal("stale resize accepted")
	}
	other, err := NewHost(t.Context(), Config{Mode: "escape", SessionID: testHostID}, time.Now(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if other.ConfigureLeash() == nil || other.PublishLeash(protocol.ProcessState{Generation: 1, State: "waiting"}, nil) == nil {
		t.Fatal("wrong mode accepted leash configuration")
	}
	if other.leashOutput(connection) != nil {
		t.Fatal("unconfigured mode exposes output")
	}
}
