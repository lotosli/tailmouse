package session

import (
	"context"
	"crypto/rand"
	"errors"
	"io"
	"sync"
	"sync/atomic"
	"time"

	"tailmouse/apps/cli/internal/protocol"
)

const (
	MaxConnections           = 8
	MaxPendingAuthentication = 4
	handshakeLimit           = 10 * time.Second
	authenticationLimit      = 30 * time.Second
	authenticationByteLimit  = 4096
	authenticationFailures   = 10
	authenticationCooldown   = 30 * time.Second
	closeLimit               = 2 * time.Second
	peerLivenessLimit        = 30 * time.Second
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
	terminal                                             *leashTerminal
	entropy                                              io.Reader
	accessMode                                           string
	accessCode                                           AccessCode
	authFailures                                         int
	authCooldownUntil                                    time.Time
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
	host              *Host
	stream            io.ReadWriteCloser
	ctx               context.Context
	cancel            context.CancelFunc
	writeSlot         chan struct{}
	leashWake         chan struct{}
	lease             Lease     // Protected by Host.mu.
	closing           bool      // Protected by Host.mu.
	authenticated     bool      // Protected by Host.mu.
	preAdmissionBytes int       // Protected by Host.mu.
	challenge         [32]byte  // Protected by Host.mu.
	challengeIssued   bool      // Protected by Host.mu.
	lastPong          time.Time // Protected by Host.mu; initialized on accepted HELLO.
}

type Metrics struct {
	LatencySnapshot
	BytesTX            uint64 `json:"bytes_tx"`
	BytesRX            uint64 `json:"bytes_rx"`
	FramesTX           uint64 `json:"frames_tx"`
	FramesRX           uint64 `json:"frames_rx"`
	ProtocolErrors     uint64 `json:"protocol_errors"`
	ActiveConnection   bool   `json:"active_conn"`
	ReconnectCount     uint64 `json:"reconnect_count"`
	OutputRingUsed     int    `json:"output_ring_used"`
	OutputDroppedBytes uint64 `json:"output_dropped_bytes"`
	ProcessGeneration  uint32 `json:"process_generation"`
}

func (host *Host) InspectMetrics() Metrics {
	snapshot := host.Authority.Inspect(time.Now())
	metrics := Metrics{LatencySnapshot: host.latency.Inspect(),
		BytesTX: host.bytesTX.Load(), BytesRX: host.bytesRX.Load(), FramesTX: host.framesTX.Load(), FramesRX: host.framesRX.Load(),
		ProtocolErrors: host.protocolErrors.Load(), ActiveConnection: snapshot.State == Active, ReconnectCount: snapshot.Reconnects}
	host.mu.Lock()
	terminal := host.terminal
	host.mu.Unlock()
	if terminal != nil {
		terminal.mu.Lock()
		metrics.ProcessGeneration, metrics.OutputDroppedBytes = terminal.state.Generation, terminal.dropped
		if terminal.pump != nil {
			metrics.OutputRingUsed = terminal.pump.RetainedOutputBytes()
		} else {
			metrics.OutputRingUsed = len(terminal.retained)
		}
		terminal.mu.Unlock()
	}

	return metrics
}

func (connection *hostConnection) Read(buffer []byte) (int, error) {
	connection.host.mu.Lock()
	if connection.host.mode == "leash" && connection.lease == 0 {
		remaining := authenticationByteLimit - connection.preAdmissionBytes
		if remaining <= 0 {
			connection.host.mu.Unlock()
			return 0, errAuthenticationBudget
		}
		if len(buffer) > remaining {
			buffer = buffer[:remaining]
		}
	}
	connection.host.mu.Unlock()
	count, err := connection.stream.Read(buffer)
	connection.host.bytesRX.Add(uint64(count))
	connection.host.mu.Lock()
	if connection.host.mode == "leash" && connection.lease == 0 {
		connection.preAdmissionBytes += count
	}
	connection.host.mu.Unlock()
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
	entropy := config.entropy
	if entropy == nil {
		entropy = rand.Reader
	}
	host := &Host{
		Authority: authority, mode: config.Mode, ctx: ctx, cancel: cancel, observe: observe,
		ready: make(chan struct{}), changed: make(chan struct{}, 1), stopped: make(chan struct{}),
		firstHello: make(chan struct{}), disconnected: make(chan struct{}, 1),
		connections: make(map[*hostConnection]struct{}), entropy: entropy,
	}
	if config.Mode == "leash" {
		host.accessMode = "code"
		if config.NoPassword {
			host.accessMode = "link"
		} else {
			code, err := newAccessCode(entropy)
			if err != nil {
				cancel()
				return nil, err
			}
			host.accessCode = code
		}
	}
	return host, nil
}

func (host *Host) AccessCodeForDisplay() (AccessCode, bool) {
	host.mu.Lock()
	defer host.mu.Unlock()
	return host.accessCode, host.accessMode == "code" && host.accessCode != (AccessCode{})
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
	if host.mode == "leash" {
		welcome.AccessMode = host.accessMode
	}
	if _, err := protocol.WelcomeFrame(welcome); err != nil {
		return err
	}
	if err := host.Authority.Listen(now); err != nil {
		return err
	}
	host.welcome, host.listening = welcome, true

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
	tooManyPending := host.mode == "leash" && host.pendingAuthenticationLocked() >= MaxPendingAuthentication
	if host.closing || host.ctx.Err() != nil || len(host.connections) >= MaxConnections || tooManyPending {
		host.mu.Unlock()
		_ = stream.Close()
		return false
	}
	ctx, cancel := context.WithCancel(host.ctx)
	connection := &hostConnection{host: host, stream: stream, ctx: ctx, cancel: cancel, writeSlot: make(chan struct{}, 1)}

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
		clear(connection.challenge[:])
		connection.challengeIssued = false
		connection.authenticated = false
		delete(host.connections, connection)
		if host.closing && len(host.connections) == 0 {
			close(host.stopped)
		}
		host.mu.Unlock()
	}()
	admissionLimit := handshakeLimit
	if host.mode == "leash" {
		admissionLimit = authenticationLimit
	}
	admissionContext, cancelAdmission := context.WithTimeout(connection.ctx, admissionLimit)
	defer cancelAdmission()
	select {
	case <-host.ready:
	case <-admissionContext.Done():
		return
	}
	_ = host.Authority.BeginConnect(time.Now()) // Busy peers still validate HELLO before rejection.
	frame, err := protocol.ReadFrame(admissionContext, connection, protocol.PeerHost, protocol.StateAwaitClientHello)
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
	if host.mode == "leash" {
		if err := host.Authority.ValidatePeer(hello.SessionID, hello.Mode, time.Now()); err != nil {
			hello.SessionID = [16]byte{}
			host.reject(connection, err, protocol.StateAwaitServerWelcome)
			return
		}
		if host.accessMode == "code" {
			if err := host.authenticationThrottle(time.Now()); err != nil {
				hello.SessionID = [16]byte{}
				host.reject(connection, err, protocol.StateAwaitServerWelcome)
				return
			}
			challenge, err := host.issueChallenge(connection)
			if err != nil {
				hello.SessionID = [16]byte{}
				host.finish(InternalFailure)
				return
			}
			challengeFrame, err := protocol.AuthChallengeFrame(challenge)
			clear(challenge[:])
			if err != nil {
				hello.SessionID = [16]byte{}
				host.finish(ProtocolFailure)
				return
			}
			if err := connection.send(admissionContext, protocol.StateAwaitServerWelcome, challengeFrame); err != nil {
				clear(challengeFrame.Payload)
				hello.SessionID = [16]byte{}
				return
			}
			clear(challengeFrame.Payload)
			proofFrame, readErr := protocol.ReadFrame(admissionContext, connection, protocol.PeerHost, protocol.StateAwaitAuthProof)
			if readErr != nil {
				_, _ = host.consumeChallenge(connection)
				hello.SessionID = [16]byte{}
				if _, ok := protocol.ErrorCodeOf(readErr); ok && connection.ctx.Err() == nil && admissionContext.Err() == nil {
					host.reject(connection, host.authenticationFailure(time.Now()), protocol.StateAwaitAuthProof)
				}
				return
			}
			host.framesRX.Add(1)
			proof, proofErr := protocol.DecodeAuthProof(proofFrame)
			clear(proofFrame.Payload)
			issuedChallenge, issued := host.consumeChallenge(connection)
			if proofErr != nil || !issued {
				clear(proof[:])
				clear(issuedChallenge[:])
				hello.SessionID = [16]byte{}
				host.reject(connection, host.authenticationFailure(time.Now()), protocol.StateAwaitAuthProof)
				return
			}
			if err := host.authenticationThrottle(time.Now()); err != nil {
				clear(proof[:])
				clear(issuedChallenge[:])
				hello.SessionID = [16]byte{}
				host.reject(connection, err, protocol.StateAwaitAuthProof)
				return
			}
			code, available := host.AccessCodeForDisplay()
			verified := available && VerifyAccessProof(code, hello.SessionID, issuedChallenge, proof)
			clear(code[:])
			clear(proof[:])
			clear(issuedChallenge[:])
			if !verified {
				hello.SessionID = [16]byte{}
				host.reject(connection, host.authenticationFailure(time.Now()), protocol.StateAwaitAuthProof)
				return
			}
			host.authenticationSucceeded(connection)
		} else {
			host.authenticationSucceeded(connection)
		}
	}
	lease, err := host.Authority.Acquire(hello.SessionID, hello.Mode, time.Now())
	hello.SessionID = [16]byte{}
	if err != nil {
		host.reject(connection, err, protocol.StateAwaitServerWelcome)
		return
	}
	cancelAdmission()
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
	state := protocol.StateActiveLeash

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
		// A browser exit does not revoke the terminal process.

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
		// Terminal handlers retain authority checks.
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
	changed, _ := host.Authority.Finish(outcome)
	if changed {
		host.mu.Lock()
		host.clearAuthenticationLocked()
		host.mu.Unlock()
	}
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
	host.mu.Unlock()
	for {
		snapshot := host.Authority.Inspect(time.Now())
		if snapshot.State == Closed || snapshot.State == Expired {
			return snapshot.Outcome
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
		terminal := host.terminal
		host.welcome = protocol.Welcome{}
		host.mu.Unlock()
		if terminal != nil {
			terminal.close()
		}
	})
	return host.closeErr
}
