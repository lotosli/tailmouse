package session

import (
	"bytes"
	"encoding/binary"
	"errors"
	"io"
	"sync"
	"time"

	"tailmouse/apps/cli/internal/leash"
	"tailmouse/apps/cli/internal/protocol"
)

// leashTerminal binds the CLI-owned process/pump to one authorized stream. Its
// lock protects memory only; neither PTY syscalls nor network writes hold it.
type leashTerminal struct {
	mu                sync.Mutex
	host              *Host
	state             protocol.ProcessState
	pump              *leash.Pump
	cols, rows        uint16
	connection        *hostConnection
	subscription      *leash.Subscription
	history           []byte
	retained          []byte
	reset, stateDirty bool
	interruptAck      *protocol.ProcessState
	dropped, reported uint64
	retainedDropped   uint64
	live              []byte
	barrier           bool
	barrierPing       []byte
	barrierAt         time.Time
	control           *LeashControl
	controls          chan struct{}
	size              *LeashSize
	sizes             chan struct{}
}

type LeashControl struct {
	protocol.ProcessControl
	lease Lease
}

type LeashSize struct {
	Columns, Rows uint16
	At            time.Time
	lease         Lease
}

func (host *Host) ConfigureLeash() error {
	host.mu.Lock()
	defer host.mu.Unlock()
	if host.mode != "leash" || host.listening || host.waiting || host.closing || host.terminal != nil {
		return ErrInvalidTransition
	}
	host.terminal = &leashTerminal{host: host, state: protocol.ProcessState{Generation: 1, State: "waiting"}, cols: 80, rows: 24,
		controls: make(chan struct{}, 1), sizes: make(chan struct{}, 1)}
	return nil
}

// PublishLeash is called only by the CLI process owner. A new pump replaces the
// generation's subscription; state-only updates retain its exact output cursor.
func (host *Host) PublishLeash(state protocol.ProcessState, pump *leash.Pump) error {
	frame, err := protocol.ProcessStateFrame(state)
	if err != nil {
		return err
	}
	state, err = protocol.DecodeProcessState(frame) // Copy all pointer fields.
	if err != nil {
		return err
	}
	terminal := host.terminal
	if terminal == nil {
		return ErrInvalidTransition
	}
	terminal.mu.Lock()
	defer terminal.mu.Unlock()
	if state.Generation < terminal.state.Generation || uint64(state.Generation) > uint64(terminal.state.Generation)+1 {
		return ErrInvalidTransition
	}
	changed := pump != terminal.pump || state.Generation != terminal.state.Generation
	restart := state.Generation != terminal.state.Generation || terminal.pump != nil && pump != terminal.pump
	if changed {
		clear(terminal.retained)
		terminal.retained, terminal.retainedDropped = nil, 0
		terminal.dropped = 0
		terminal.interruptAck = nil
	} else if terminal.connection != nil && terminal.interruptAck == nil && terminal.stateDirty && terminal.state.State == "interrupting" && state.State == "running" {
		// Running may replace ordinary state, but cannot erase the reply that
		// releases the browser's pending control. Selected frames already have
		// their order guaranteed by the sole sender, so retain only unsent state.
		ack := terminal.state
		terminal.interruptAck = &ack
	}
	terminal.state, terminal.pump, terminal.stateDirty = state, pump, true
	if changed && terminal.connection != nil {
		terminal.snapshotLocked()
		terminal.barrier = terminal.barrier || restart
	}
	terminal.wakeLocked()
	return nil
}

// RetainLeash replaces a fully drained generation with only its safe process
// result and bounded history. It deliberately releases the Pump, its PTY
// reference, input queue, live-delivery ring and subscriber state.
func (host *Host) RetainLeash(state protocol.ProcessState, pump *leash.Pump) error {
	if state.State != "exited" || pump == nil {
		return ErrInvalidTransition
	}
	frame, err := protocol.ProcessStateFrame(state)
	if err != nil {
		return err
	}
	state, err = protocol.DecodeProcessState(frame)
	clear(frame.Payload)
	if err != nil {
		return err
	}
	snapshot, err := pump.FinalSnapshot()
	if err != nil {
		return err
	}
	terminal := host.terminal
	if terminal == nil {
		clear(snapshot.Data)
		return ErrInvalidTransition
	}
	terminal.mu.Lock()
	defer terminal.mu.Unlock()
	if terminal.pump != pump || terminal.state.Generation != state.Generation {
		clear(snapshot.Data)
		return ErrInvalidTransition
	}
	clear(terminal.retained)
	terminal.retained, terminal.retainedDropped = snapshot.Data, snapshot.Dropped
	terminal.state, terminal.pump = state, nil
	terminal.dropped = snapshot.Dropped
	terminal.interruptAck = nil
	terminal.snapshotLocked()
	terminal.wakeLocked()
	return nil
}

func (terminal *leashTerminal) snapshotLocked() {
	if terminal.subscription != nil {
		terminal.subscription.Close()
	}
	clear(terminal.history)
	clear(terminal.live)
	terminal.history, terminal.live, terminal.subscription = nil, nil, nil
	terminal.reported = 0
	if terminal.pump != nil {
		snapshot, subscription := terminal.pump.Subscribe()
		terminal.history, terminal.subscription = snapshot.Data, subscription
		terminal.dropped = max(terminal.dropped, snapshot.Dropped)
	} else if len(terminal.retained) > 0 || terminal.retainedDropped > 0 {
		terminal.history = bytes.Clone(terminal.retained)
		terminal.dropped = max(terminal.dropped, terminal.retainedDropped)
	}
	terminal.reset, terminal.stateDirty = true, true
	terminal.interruptAck = nil
	terminal.barrierPing = nil
}

func (terminal *leashTerminal) attach(connection *hostConnection) {
	terminal.mu.Lock()
	defer terminal.mu.Unlock()
	terminal.connection, terminal.barrier = connection, false
	terminal.snapshotLocked()
	terminal.wakeLocked()
}

func (terminal *leashTerminal) detach(connection *hostConnection) {
	terminal.mu.Lock()
	defer terminal.mu.Unlock()
	if terminal.connection != connection {
		return
	}
	if terminal.subscription != nil {
		terminal.subscription.Close()
	}
	clear(terminal.history)
	clear(terminal.live)
	terminal.connection, terminal.subscription, terminal.history, terminal.live = nil, nil, nil, nil
	terminal.barrier, terminal.barrierPing = false, nil
	terminal.control = nil
	if terminal.size != nil && terminal.size.lease == connection.lease {
		terminal.size = nil
	}
	terminal.interruptAck = nil
}

func (terminal *leashTerminal) close() {
	terminal.mu.Lock()
	defer terminal.mu.Unlock()
	if terminal.subscription != nil {
		terminal.subscription.Close()
	}
	clear(terminal.history)
	clear(terminal.retained)
	clear(terminal.live)
	clear(terminal.barrierPing)
	terminal.state = protocol.ProcessState{}
	terminal.pump, terminal.connection, terminal.subscription = nil, nil, nil
	terminal.history, terminal.retained, terminal.live, terminal.barrierPing = nil, nil, nil, nil
	terminal.control, terminal.size, terminal.interruptAck = nil, nil, nil
	terminal.dropped, terminal.reported, terminal.retainedDropped = 0, 0, 0
	terminal.barrier, terminal.reset, terminal.stateDirty = false, false, false
}

func (terminal *leashTerminal) wakeLocked() {
	if terminal.connection != nil {
		select {
		case terminal.connection.leashWake <- struct{}{}:
		default:
		}
	}
}

func (host *Host) leashOutput(connection *hostConnection) <-chan struct{} {
	if host.terminal == nil {
		return nil
	}
	terminal := host.terminal
	terminal.mu.Lock()
	defer terminal.mu.Unlock()
	if terminal.connection != connection || terminal.subscription == nil {
		return nil
	}
	return terminal.subscription.Changed()
}

func (terminal *leashTerminal) next(connection *hostConnection) (frame protocol.Frame, ok bool, err error) {
	terminal.mu.Lock()
	defer terminal.mu.Unlock()
	if terminal.connection != connection {
		return frame, false, nil
	}
	defer func() {
		if ok {
			terminal.wakeLocked()
		}
	}()
	if terminal.reset {
		terminal.reset = false
		frame, err = protocol.TermResetFrame(protocol.TermReset{Generation: terminal.state.Generation, Columns: terminal.cols, Rows: terminal.rows})
		return frame, true, err
	}
	if len(terminal.history) > 0 {
		count := min(len(terminal.history), leash.TerminalChunkBytes)
		data := bytes.Clone(terminal.history[:count])
		clear(terminal.history[:count])
		terminal.history = terminal.history[count:]
		if len(terminal.history) == 0 {
			terminal.history = nil
		}
		return protocol.Frame{Type: protocol.TypeTermOutput, Payload: data}, true, nil
	}
	if terminal.dropped != terminal.reported {
		terminal.reported = terminal.dropped
		frame, err = protocol.OutputDroppedFrame(protocol.OutputDropped{Generation: terminal.state.Generation, Bytes: terminal.dropped})
		return frame, true, err
	}
	if terminal.interruptAck != nil {
		frame, err = protocol.ProcessStateFrame(*terminal.interruptAck)
		terminal.interruptAck = nil
		return frame, true, err
	}
	if terminal.stateDirty {
		terminal.stateDirty = false
		frame, err = protocol.ProcessStateFrame(terminal.state)
		return frame, true, err
	}
	if len(terminal.live) > 0 {
		data := terminal.live
		terminal.live = nil
		return protocol.Frame{Type: protocol.TypeTermOutput, Payload: data}, true, nil
	}
	if terminal.subscription == nil {
		return frame, false, nil
	}
	chunk, err := terminal.subscription.ReadAvailable(leash.TerminalChunkBytes)
	if errors.Is(err, io.EOF) {
		return frame, false, nil
	}
	if err != nil {
		return frame, false, err
	}
	if chunk.Dropped > 0 {
		if chunk.Dropped > (1<<53-1)-terminal.dropped {
			return frame, false, ErrInvalidTransition
		}
		terminal.dropped += chunk.Dropped
		terminal.reported = terminal.dropped
		terminal.live = chunk.Data
		frame, err = protocol.OutputDroppedFrame(protocol.OutputDropped{Generation: terminal.state.Generation, Bytes: terminal.dropped})
		return frame, true, err
	}
	if len(chunk.Data) == 0 {
		return frame, false, nil
	}
	return protocol.Frame{Type: protocol.TypeTermOutput, Payload: chunk.Data}, true, nil
}

func (connection *hostConnection) sendLeash(state protocol.State) error {
	frame, ok, err := connection.host.terminal.next(connection)
	if err != nil {
		connection.host.finish(InternalFailure)
		return err
	}
	if !ok {
		return nil
	}
	defer clear(frame.Payload)
	if frame.Type == protocol.TypeOutputDropped {
		dropped, err := protocol.DecodeOutputDropped(frame)
		if err != nil {
			connection.host.finish(InternalFailure)
			return err
		}
		// Report the observed cumulative loss before a potentially blocked
		// network write. Reconnect can report the same generation/count again;
		// the value is not an additional number of dropped bytes.
		if !connection.host.report(Event{Kind: TerminalOutputDropped, Dropped: dropped}) {
			return errors.New("diagnostic output failed")
		}
	}
	return connection.send(connection.ctx, state, frame)
}

func (terminal *leashTerminal) input(connection *hostConnection, frame protocol.Frame) error {
	terminal.mu.Lock()
	defer terminal.mu.Unlock()
	if terminal.connection != connection {
		return &protocol.ProtocolError{Code: protocol.CodeUnauthorized}
	}
	capability := capabilityFor(frame.Type)
	var control protocol.ProcessControl
	if frame.Type == protocol.TypeProcessControl {
		var err error
		control, err = protocol.DecodeProcessControl(frame)
		if err != nil {
			return err
		}
		capability = control.Action
	}
	if err := terminal.host.Authority.Authorize(connection.lease, capability, time.Now()); err != nil {
		return err
	}
	switch frame.Type {
	case protocol.TypeTermInput:
		if terminal.barrier || terminal.control != nil {
			return &protocol.ProtocolError{Code: protocol.CodeBackpressure}
		}
		if terminal.pump == nil || terminal.state.State != "running" && terminal.state.State != "interrupting" {
			return &protocol.ProtocolError{Code: protocol.CodeProcessNotRunning}
		}
		err := terminal.pump.Input(connection.ctx, frame.Payload)
		if errors.Is(err, leash.ErrBackpressure) {
			return &protocol.ProtocolError{Code: protocol.CodeBackpressure}
		}
		if err != nil {
			return &protocol.ProtocolError{Code: protocol.CodeUnauthorized}
		}
	case protocol.TypeTermResize:
		terminal.resizeLocked(binary.BigEndian.Uint16(frame.Payload[:2]), binary.BigEndian.Uint16(frame.Payload[2:]), connection.lease, time.Now())
	case protocol.TypeProcessControl:
		if control.Generation != terminal.state.Generation {
			return &protocol.ProtocolError{Code: protocol.CodeUnauthorized}
		}
		if terminal.state.State != "running" && terminal.state.State != "interrupting" && !(control.Action == "restart" && terminal.state.State == "exited") {
			return &protocol.ProtocolError{Code: protocol.CodeProcessNotRunning}
		}
		if terminal.control != nil {
			return &protocol.ProtocolError{Code: protocol.CodeBackpressure}
		}
		terminal.control = &LeashControl{ProcessControl: control, lease: connection.lease}
		select {
		case terminal.controls <- struct{}{}:
		default:
		}
	default:
		return &protocol.ProtocolError{Code: protocol.CodeBadFrame}
	}
	return nil
}

func (host *Host) LeashControls() <-chan struct{} { return host.terminal.controls }

// TakeLeashControl rechecks lease, generation and process state immediately
// before a platform effect. A disconnected peer leaves no delayed work.
func (host *Host) TakeLeashControl() (LeashControl, bool) {
	terminal := host.terminal
	terminal.mu.Lock()
	defer terminal.mu.Unlock()
	request := terminal.control
	terminal.control = nil
	if request == nil || request.Generation != terminal.state.Generation || terminal.host.Authority.Authorize(request.lease, request.Action, time.Now()) != nil {
		return LeashControl{}, false
	}
	if terminal.state.State != "running" && terminal.state.State != "interrupting" && !(request.Action == "restart" && terminal.state.State == "exited") {
		return LeashControl{}, false
	}
	switch request.Action {
	case "interrupt":
		terminal.state.State = "interrupting"
	case "terminate":
		terminal.state.State = "terminating"
	case "restart":
		terminal.state.State = "restarting"
	}
	terminal.stateDirty = true
	terminal.wakeLocked()
	return *request, true
}

func (terminal *leashTerminal) resizeLocked(cols, rows uint16, lease Lease, now time.Time) {
	terminal.size = &LeashSize{Columns: cols, Rows: rows, At: now, lease: lease}
	select {
	case terminal.sizes <- struct{}{}:
	default:
	}
}

// ResizeLeash submits an owner-local SIGWINCH through the same last-writer
// slot used by the browser. The CLI owns the 50 ms timer and native syscall.
func (host *Host) ResizeLeash(cols, rows int, now time.Time) error {
	if host.terminal == nil || cols < 20 || cols > 500 || rows < 5 || rows > 200 {
		return ErrInvalidConfig
	}
	terminal := host.terminal
	terminal.mu.Lock()
	defer terminal.mu.Unlock()
	terminal.resizeLocked(uint16(cols), uint16(rows), 0, now)
	return nil
}

func (host *Host) LeashSizes() <-chan struct{} { return host.terminal.sizes }

func (host *Host) TakeLeashSize() (LeashSize, bool) {
	terminal := host.terminal
	terminal.mu.Lock()
	defer terminal.mu.Unlock()
	size := terminal.size
	terminal.size = nil
	if size == nil || size.lease != 0 && host.Authority.Authorize(size.lease, "resize", time.Now()) != nil {
		return LeashSize{}, false
	}
	return *size, true
}

// AppliedLeashSize records only a successful native resize, for later resets.
func (host *Host) AppliedLeashSize(size LeashSize) {
	terminal := host.terminal
	terminal.mu.Lock()
	defer terminal.mu.Unlock()
	terminal.cols, terminal.rows = size.Columns, size.Rows
}

func (host *Host) AcceptLeashSize(size LeashSize) bool {
	return size.lease == 0 || host.Authority.Authorize(size.lease, "resize", time.Now()) == nil
}

func (terminal *leashTerminal) ping(connection *hostConnection, frame protocol.Frame) {
	terminal.mu.Lock()
	defer terminal.mu.Unlock()
	if terminal.connection != connection || !terminal.barrier || terminal.reset || len(terminal.history) > 0 || terminal.interruptAck != nil || terminal.stateDirty {
		return
	}
	if terminal.barrierPing == nil || time.Since(terminal.barrierAt) > 5*time.Second {
		terminal.barrierPing, terminal.barrierAt = bytes.Clone(frame.Payload), time.Now()
	}
}

func (terminal *leashTerminal) pong(connection *hostConnection, data []byte) {
	terminal.mu.Lock()
	defer terminal.mu.Unlock()
	if terminal.connection == connection && terminal.barrier && bytes.Equal(data, terminal.barrierPing) {
		terminal.barrier, terminal.barrierPing = false, nil
	}
}
