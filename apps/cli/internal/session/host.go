package session

import (
	"context"
	"errors"
	"io"
	"sync"
	"sync/atomic"
	"time"

	"tailmouse/apps/cli/internal/escape"
	"tailmouse/apps/cli/internal/protocol"
)

const (
	MaxConnections    = 8 // One owner plus bounded concurrent handshake attempts.
	handshakeLimit    = 10 * time.Second
	closeLimit        = 2 * time.Second
	peerLivenessLimit = 30 * time.Second
)

var ErrShutdown = errors.New("session stream shutdown did not complete gracefully")

// Host owns the connection workers around the authority core. Tailcat and mode
// resources remain owned by the composition root. Close joins every worker.
type Host struct {
	Authority                                            *Session
	mode                                                 string
	ctx                                                  context.Context
	cancel                                               context.CancelFunc
	ready                                                chan struct{}
	firstHello                                           chan struct{}
	disconnected                                         chan struct{}
	changed                                              chan struct{}
	stopped                                              chan struct{}
	mu                                                   sync.Mutex
	listening                                            bool
	waiting                                              bool
	closing                                              bool
	welcome                                              protocol.Welcome
	connections                                          map[*hostConnection]struct{}
	closeOnce                                            sync.Once
	closeErr                                             error
	latency                                              Latency
	observe                                              func(Event) error
	game                                                 *escapeGame
	terminal                                             *leashTerminal
	bytesTX, bytesRX, framesTX, framesRX, protocolErrors atomic.Uint64
}

// Event carries only local, non-secret measurements to the CLI diagnostic sink.
// Observe is synchronous: no event queue or independent worker survives Close.
type Event struct {
	Kind    EventKind
	Metrics Metrics
	Dropped protocol.OutputDropped
}

type EventKind uint8

const (
	BrowserConnected EventKind = iota + 1
	BrowserDisconnected
	RTTMeasured
	TerminalOutputDropped
)

type hostConnection struct {
	host      *Host
	stream    io.ReadWriteCloser
	ctx       context.Context
	cancel    context.CancelFunc
	writeSlot chan struct{}
	gameWake  chan struct{}
	leashWake chan struct{}
	lease     Lease     // Protected by Host.mu.
	closing   bool      // Protected by Host.mu.
	lastPong  time.Time // Protected by Host.mu; initialized on accepted HELLO.
}

type Metrics struct {
	LatencySnapshot
	BytesTX            uint64  `json:"bytes_tx"`
	BytesRX            uint64  `json:"bytes_rx"`
	FramesTX           uint64  `json:"frames_tx"`
	FramesRX           uint64  `json:"frames_rx"`
	ProtocolErrors     uint64  `json:"protocol_errors"`
	ActiveConnection   bool    `json:"active_conn"`
	ReconnectCount     uint64  `json:"reconnect_count"`
	OutputRingUsed     int     `json:"output_ring_used"`
	OutputDroppedBytes uint64  `json:"output_dropped_bytes"`
	ProcessGeneration  uint32  `json:"process_generation"`
	EscapeInputRate    float64 `json:"escape_input_rate"`
	EscapeSnapshotRate float64 `json:"escape_snapshot_rate"`
}

func (host *Host) InspectMetrics() Metrics {
	snapshot := host.Authority.Inspect(time.Now())
	metrics := Metrics{LatencySnapshot: host.latency.Inspect(),
		BytesTX: host.bytesTX.Load(), BytesRX: host.bytesRX.Load(), FramesTX: host.framesTX.Load(), FramesRX: host.framesRX.Load(),
		ProtocolErrors: host.protocolErrors.Load(), ActiveConnection: snapshot.State == Active, ReconnectCount: snapshot.Reconnects}
	host.mu.Lock()
	game, terminal := host.game, host.terminal
	host.mu.Unlock()
	if terminal != nil {
		terminal.mu.Lock()
		metrics.ProcessGeneration, metrics.OutputDroppedBytes = terminal.state.Generation, terminal.dropped
		if terminal.pump != nil {
			metrics.OutputRingUsed = terminal.pump.RetainedOutputBytes()
		}
		terminal.mu.Unlock()
	}
	if game != nil {
		game.mu.Lock()
		now := time.Now()
		if elapsed := now.Sub(game.rateAt); elapsed >= time.Second {
			game.inputRate = float64(game.inputs-game.rateInputs) / elapsed.Seconds()
			game.snapshotRate = float64(game.snapshots-game.rateSnapshots) / elapsed.Seconds()
			game.rateAt, game.rateInputs, game.rateSnapshots = now, game.inputs, game.snapshots
		}
		metrics.EscapeInputRate, metrics.EscapeSnapshotRate = game.inputRate, game.snapshotRate
		game.mu.Unlock()
	}
	return metrics
}

func (connection *hostConnection) Read(buffer []byte) (int, error) {
	count, err := connection.stream.Read(buffer)
	connection.host.bytesRX.Add(uint64(count))
	return count, err
}

func (connection *hostConnection) Write(buffer []byte) (int, error) {
	count, err := connection.stream.Write(buffer)
	connection.host.bytesTX.Add(uint64(count))
	return count, err
}

func (connection *hostConnection) Close() error { return connection.stream.Close() }

func NewHost(ctx context.Context, config Config, now time.Time, observe func(Event) error) (*Host, error) {
	if ctx == nil {
		return nil, ErrInvalidConfig
	}
	authority, err := New(config, now)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithCancel(ctx)
	return &Host{
		Authority: authority, mode: config.Mode, ctx: ctx, cancel: cancel, observe: observe,
		ready: make(chan struct{}), changed: make(chan struct{}, 1), stopped: make(chan struct{}),
		firstHello: make(chan struct{}), disconnected: make(chan struct{}, 1),
		connections: make(map[*hostConnection]struct{}),
	}, nil
}

// FirstHello closes exactly once after a valid peer acquires authority. It is
// a historical start trigger, not proof of a current connection or permission.
// It survives a failed WELCOME write or a later disconnect. The CLI must still
// check local cancellation and session expiry before allocating its process.
func (host *Host) FirstHello() <-chan struct{}   { return host.firstHello }
func (host *Host) Disconnected() <-chan struct{} { return host.disconnected }

// Listen publishes relay metadata only after native transport is ready.
func (host *Host) Listen(relayMode, relayHost string, now time.Time) error {
	host.mu.Lock()
	defer host.mu.Unlock()
	if host.listening || host.closing {
		return ErrInvalidTransition
	}
	snapshot := host.Authority.Inspect(now)
	if snapshot.State == Expired || snapshot.State == Closed {
		return &protocol.ProtocolError{Code: protocol.CodeExpired}
	}
	expires := int64(0)
	if !snapshot.ExpiresAt.IsZero() {
		expires = snapshot.ExpiresAt.Unix()
	}
	welcome := protocol.Welcome{Mode: host.mode, ExpiresAt: expires, RelayMode: relayMode,
		RelayHost: relayHost, Capabilities: host.Authority.Capabilities()}
	if _, err := protocol.WelcomeFrame(welcome); err != nil {
		return err
	}
	if err := host.Authority.Listen(now); err != nil {
		return err
	}
	host.welcome, host.listening = welcome, true
	if host.game != nil {
		host.game.relay = relayHost
	}
	close(host.ready)
	return nil
}

// Accept transfers ownership of a stream. Excess or late arrivals are closed
// before a worker or payload buffer is allocated.
func (host *Host) Accept(stream io.ReadWriteCloser) bool {
	if stream == nil {
		return false
	}
	host.mu.Lock()
	if host.closing || host.ctx.Err() != nil || len(host.connections) >= MaxConnections {
		host.mu.Unlock()
		_ = stream.Close()
		return false
	}
	ctx, cancel := context.WithCancel(host.ctx)
	connection := &hostConnection{host: host, stream: stream, ctx: ctx, cancel: cancel, writeSlot: make(chan struct{}, 1)}
	if host.game != nil {
		connection.gameWake = make(chan struct{}, 1)
	}
	if host.terminal != nil {
		connection.leashWake = make(chan struct{}, 1)
	}
	host.connections[connection] = struct{}{}
	host.mu.Unlock()
	go host.serve(connection)
	return true
}

func (host *Host) serve(connection *hostConnection) {
	var pingDone chan struct{}
	defer func() {
		connection.cancel()
		_ = connection.stream.Close()
		if pingDone != nil {
			<-pingDone
		}
		host.mu.Lock()
		lease := connection.lease
		host.mu.Unlock()
		if lease != 0 {
			if host.game != nil {
				host.game.detach(connection)
			}
			if host.terminal != nil {
				host.terminal.detach(connection)
			}
			host.latency.ResetPending()
			if host.Authority.Disconnect(lease, time.Now()) {
				select {
				case host.disconnected <- struct{}{}:
				default:
				}
				host.report(Event{Kind: BrowserDisconnected})
			}
		} else {
			host.Authority.ConnectFailed()
		}
		host.notify()
		host.mu.Lock()
		delete(host.connections, connection)
		if host.closing && len(host.connections) == 0 {
			close(host.stopped)
		}
		host.mu.Unlock()
	}()
	select {
	case <-host.ready:
	case <-connection.ctx.Done():
		return
	}
	_ = host.Authority.BeginConnect(time.Now()) // Busy peers still validate HELLO before rejection.
	helloContext, cancel := context.WithTimeout(connection.ctx, handshakeLimit)
	frame, err := protocol.ReadFrame(helloContext, connection, protocol.PeerHost, protocol.StateAwaitClientHello)
	cancel()
	if err != nil {
		if !errors.Is(err, io.EOF) && host.ctx.Err() == nil {
			host.reject(connection, err, protocol.StateAwaitServerWelcome)
		}
		return
	}
	host.framesRX.Add(1)
	hello, err := protocol.DecodeHello(frame)
	clear(frame.Payload)
	if err != nil {
		host.reject(connection, err, protocol.StateAwaitServerWelcome)
		return
	}
	lease, err := host.Authority.Acquire(hello.SessionID, hello.Mode, time.Now())
	hello.SessionID = [16]byte{}
	if err != nil {
		host.reject(connection, err, protocol.StateAwaitServerWelcome)
		return
	}
	host.mu.Lock()
	connection.lease = lease
	connection.lastPong = time.Now()
	welcome := host.welcome
	select {
	case <-host.firstHello:
	default:
		close(host.firstHello)
	}
	host.mu.Unlock()
	frame, err = protocol.WelcomeFrame(welcome)
	if err != nil {
		host.finish(ProtocolFailure)
		return
	}
	if err := connection.send(host.ctx, protocol.StateAwaitServerWelcome, frame); err != nil {
		return
	}
	if !host.report(Event{Kind: BrowserConnected}) {
		return
	}
	host.notify()
	state := protocol.StateActiveEscape
	if host.mode == "leash" {
		state = protocol.StateActiveLeash
	}
	if host.game != nil {
		if err := host.game.attach(connection); err != nil {
			host.reject(connection, err, state)
			host.finish(InternalFailure)
			return
		}
		host.notify()
	}
	if host.terminal != nil {
		host.terminal.attach(connection)
	}
	pingDone = make(chan struct{})
	go func() {
		defer close(pingDone)
		ticker := time.NewTicker(time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-connection.ctx.Done():
				return
			case <-connection.leashWake:
				if connection.sendLeash(state) != nil {
					connection.cancel()
					return
				}
			case <-host.leashOutput(connection):
				if connection.sendLeash(state) != nil {
					connection.cancel()
					return
				}
			case <-connection.gameWake:
				frame, ok := host.game.next(connection)
				if !ok {
					continue
				}
				err := connection.send(connection.ctx, state, frame)
				host.game.sent(connection, frame, err)
				clear(frame.Payload)
				if err != nil {
					connection.cancel()
					return
				}
			case <-ticker.C:
				if connection.expirePeer(time.Now()) {
					connection.cancel()
					return
				}
				host.mu.Lock()
				closing := connection.closing
				host.mu.Unlock()
				if closing {
					return
				}
				frame := host.latency.Ping(time.Now())
				if host.game != nil {
					host.game.ping(connection, frame)
				}
				if host.terminal != nil {
					host.terminal.ping(connection, frame)
				}
				err := connection.send(connection.ctx, state, frame)
				clear(frame.Payload)
				if err != nil {
					connection.cancel()
					return
				}
			}
		}
	}()
	for {
		frame, err := protocol.ReadFrame(connection.ctx, connection, protocol.PeerHost, state)
		if err != nil {
			if protocol.IsTruncatedFrame(err) {
				// The established stream is lost, not reusable. Deferred cleanup
				// discards its work and releases its lease under disconnect policy.
				return
			}
			if code, ok := protocol.ErrorCodeOf(err); ok && connection.ctx.Err() == nil {
				host.protocolErrors.Add(1)
				host.reject(connection, &protocol.ProtocolError{Code: code}, state)
				host.finish(ProtocolFailure)
			}
			return
		}
		host.framesRX.Add(1)
		stop := host.handle(connection, state, frame)
		clear(frame.Payload)
		if stop {
			return
		}
	}
}

// expirePeer fences late input and heartbeat refresh before teardown releases
// the lease. Both the existing ticker and receive path enforce the same bound.
func (connection *hostConnection) expirePeer(now time.Time) bool {
	connection.host.mu.Lock()
	defer connection.host.mu.Unlock()
	if connection.closing || now.Sub(connection.lastPong) < peerLivenessLimit {
		return false
	}
	connection.closing = true
	return true
}

func (host *Host) handle(connection *hostConnection, state protocol.State, frame protocol.Frame) bool {
	if frame.Type == protocol.TypeClose {
		host.mu.Lock()
		alreadyClosing := connection.closing
		connection.closing = true
		host.mu.Unlock()
		if !alreadyClosing {
			closeFrame, _ := protocol.CloseFrame("normal")
			if err := connection.send(host.ctx, protocol.StateClosing, closeFrame); err != nil {
				return true
			}
		}
		if !host.waitForEOF(connection) {
			host.finish(ProtocolFailure)
			return true
		}
		// A browser exit ends Escape; it does not revoke a Leash process.
		if host.mode == "escape" && !alreadyClosing {
			host.finish(ModeComplete)
		}
		return true
	}
	if connection.expirePeer(time.Now()) {
		return true
	}
	host.mu.Lock()
	closing := connection.closing
	host.mu.Unlock()
	if closing {
		return false
	} // Only peer CLOSE completes its in-flight direction.
	if snapshot := host.Authority.Inspect(time.Now()); snapshot.State != Active {
		host.notify()
		return false
	}
	switch frame.Type {
	case protocol.TypePing:
		return connection.send(host.ctx, state, protocol.Frame{Type: protocol.TypePong, Payload: frame.Payload}) != nil
	case protocol.TypePong:
		now := time.Now()
		host.mu.Lock()
		valid := !connection.closing && now.Sub(connection.lastPong) < peerLivenessLimit && host.latency.Pong(frame.Payload, now)
		if valid {
			connection.lastPong = now
		}
		host.mu.Unlock()
		if valid {
			if host.game != nil {
				if err := host.game.pong(connection, frame.Payload); err != nil {
					host.finish(InternalFailure)
					return true
				}
			}
			if host.terminal != nil {
				host.terminal.pong(connection, frame.Payload)
			}
			return !host.report(Event{Kind: RTTMeasured})
		}
		return false
	case protocol.TypeError:
		host.protocolErrors.Add(1)
		host.finish(ProtocolFailure)
		return true
	case protocol.TypeGameInput, protocol.TypeGameEvent:
		if host.game != nil {
			if err := host.game.input(connection, frame); err != nil {
				return connection.send(host.ctx, state, protocol.ErrorFrame(err)) != nil
			}
			return false
		}
		return connection.send(host.ctx, state, protocol.ErrorFrame(&protocol.ProtocolError{Code: protocol.CodeUnauthorized})) != nil
	case protocol.TypeTermInput, protocol.TypeTermResize, protocol.TypeProcessControl:
		if host.terminal != nil {
			if err := host.terminal.input(connection, frame); err != nil {
				return connection.send(host.ctx, state, protocol.ErrorFrame(err)) != nil
			}
			return false
		}
		err := host.Authority.Authorize(connection.lease, capabilityFor(frame.Type), time.Now())
		if err == nil {
			err = &protocol.ProtocolError{Code: protocol.CodeUnauthorized}
		}
		return connection.send(host.ctx, state, protocol.ErrorFrame(err)) != nil
	default:
		// Mode handlers are connected by their accepted Escape/Leash tasks.
		// Until then, no syntactically valid input can cause a side effect.
		err := host.Authority.Authorize(connection.lease, capabilityFor(frame.Type), time.Now())
		if err == nil {
			err = &protocol.ProtocolError{Code: protocol.CodeUnauthorized}
		}
		return connection.send(host.ctx, state, protocol.ErrorFrame(err)) != nil
	}
}

func capabilityFor(message protocol.MessageType) string {
	switch message {
	case protocol.TypeGameInput:
		return "game_input"
	case protocol.TypeGameEvent:
		return "game_view"
	case protocol.TypeTermInput:
		return "terminal_input"
	case protocol.TypeTermResize:
		return "resize"
	default:
		return "process_control"
	}
}

func (connection *hostConnection) send(parent context.Context, state protocol.State, frame protocol.Frame) error {
	ctx, cancel := context.WithTimeout(parent, closeLimit)
	defer cancel()
	select {
	case connection.writeSlot <- struct{}{}:
	case <-ctx.Done():
		return ctx.Err()
	}
	defer func() { <-connection.writeSlot }()
	connection.host.mu.Lock()
	closing := connection.closing
	connection.host.mu.Unlock()
	if closing && frame.Type != protocol.TypeClose && frame.Type != protocol.TypeError {
		return nil
	}
	err := protocol.WriteFrame(ctx, connection, protocol.PeerHost, state, frame)
	if err == nil {
		connection.host.framesTX.Add(1)
	}
	return err
}

func (host *Host) reject(connection *hostConnection, err error, state protocol.State) {
	if state == protocol.StateAwaitServerWelcome {
		host.protocolErrors.Add(1)
	}
	host.mu.Lock()
	connection.closing = true
	host.mu.Unlock()
	if connection.send(host.ctx, state, protocol.ErrorFrame(err)) == nil {
		host.waitForEOF(connection)
	}
}

func (host *Host) waitForEOF(connection *hostConnection) bool {
	ctx, cancel := context.WithTimeout(connection.ctx, closeLimit)
	defer cancel()
	stop := context.AfterFunc(ctx, func() { _ = connection.stream.Close() })
	defer stop()
	var extra [1]byte
	count, err := connection.Read(extra[:]) // Never drain an unbounded peer body.
	return count == 0 && errors.Is(err, io.EOF)
}

func (host *Host) finish(outcome Outcome) {
	_, _ = host.Authority.Finish(outcome)
	host.notify()
}

func (host *Host) report(event Event) bool {
	if host.observe != nil {
		event.Metrics = host.InspectMetrics()
		if err := host.observe(event); err != nil {
			host.finish(InternalFailure)
			return false
		}
	}
	return true
}

func (host *Host) notify() {
	select {
	case host.changed <- struct{}{}:
	default:
	}
}

// Wait owns TTL/grace timers. It returns only an authoritative terminal outcome.
func (host *Host) Wait(ctx context.Context) Outcome {
	host.mu.Lock()
	host.waiting = true // Configuration is immutable once its owner loop starts.
	game := host.game
	host.mu.Unlock()
	var gameTicker *time.Ticker
	var gameTicks <-chan time.Time
	defer func() {
		if gameTicker != nil {
			gameTicker.Stop()
		}
	}()
	for {
		snapshot := host.Authority.Inspect(time.Now())
		if snapshot.State == Closed || snapshot.State == Expired {
			return snapshot.Outcome
		}
		if game != nil {
			state, started := host.InspectEscape()
			if started && state.Phase != escape.Finished && gameTicker == nil {
				gameTicker = time.NewTicker(time.Second / escape.SimulationHz)
				gameTicks = gameTicker.C
			} else if state.Phase == escape.Finished && gameTicker != nil {
				gameTicker.Stop()
				gameTicker, gameTicks = nil, nil
			}
		}
		deadline := snapshot.ExpiresAt
		if !snapshot.GraceDeadline.IsZero() && (deadline.IsZero() || snapshot.GraceDeadline.Before(deadline)) {
			deadline = snapshot.GraceDeadline
		}
		var timer *time.Timer
		var tick <-chan time.Time
		if !deadline.IsZero() {
			timer = time.NewTimer(time.Until(deadline))
			tick = timer.C
		}
		select {
		case <-ctx.Done():
			host.finish(LocalRevoke)
		case <-host.changed:
		case <-tick:
		case <-gameTicks:
			if err := game.tick(); err != nil {
				host.finish(InternalFailure)
			}
		}
		if timer != nil {
			timer.Stop()
		}
	}
}

// Close stops admission, sends bounded CLOSE notifications, then joins streams
// before the composition root drains Tailcat. Repetition returns the same result.
func (host *Host) Close(reason string) error {
	host.closeOnce.Do(func() {
		host.finish(LocalRevoke) // Preserve any outcome already chosen by Wait or mode logic.
		host.mu.Lock()
		host.closing = true
		connections := make([]*hostConnection, 0, len(host.connections))
		for connection := range host.connections {
			connections = append(connections, connection)
		}
		if len(connections) == 0 {
			close(host.stopped)
		}
		host.mu.Unlock()
		ctx, cancel := context.WithTimeout(context.Background(), closeLimit)
		defer cancel()
		frame, err := protocol.CloseFrame(reason)
		if err != nil {
			host.closeErr = ErrShutdown
		}
		for _, connection := range connections {
			host.mu.Lock()
			pending := connection.lease == 0
			active := connection.lease != 0 && !connection.closing
			connection.closing = true
			host.mu.Unlock()
			if active && err == nil {
				if sendErr := connection.send(ctx, protocol.StateClosing, frame); sendErr != nil {
					host.closeErr = ErrShutdown
				}
			} else if pending {
				connection.cancel()
				_ = connection.stream.Close()
			}
		}
		select {
		case <-host.stopped:
		case <-ctx.Done():
			host.closeErr = ErrShutdown
		}
		host.cancel()
		for _, connection := range connections {
			_ = connection.stream.Close()
		}
		<-host.stopped // Close of the stream contract unblocks Read and Write.
		host.mu.Lock()
		host.welcome = protocol.Welcome{}
		host.mu.Unlock()
	})
	return host.closeErr
}
