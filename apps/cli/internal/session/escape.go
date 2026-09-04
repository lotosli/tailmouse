package session

import (
	"encoding/binary"
	"errors"
	"math"
	"strconv"
	"sync"
	"time"

	"tailmouse/apps/cli/internal/escape"
	"tailmouse/apps/cli/internal/protocol"
)

const maxGameOutput = 16

type EscapeConfig struct {
	Map                  string
	Seed                 int64
	Round                time.Duration
	Once                 bool
	Control              string
	PhoneRender, ShowNet bool
}

// escapeGame binds one concrete mode to Host. All fields below are protected by
// mu. The host wait loop and connection reader serialize here, never across I/O.
type escapeGame struct {
	mu                                               sync.Mutex
	host                                             *Host
	config                                           EscapeConfig
	relay                                            string
	round                                            *escape.Round
	connection                                       *hostConnection
	queue                                            []protocol.Frame
	snapshotSequence, eventSequence                  uint32
	clientEventSequence                              uint32
	result                                           *protocol.GameResult
	roundNumber, inputs, snapshots                   uint64
	rateAt                                           time.Time
	rateInputs, rateSnapshots                        uint64
	inputRate, snapshotRate                          float64
	resultSent, resultAcknowledged, restartRequested bool
	resultPing                                       [16]byte
	inputPing                                        [16]byte
	lastInput, inputDrained                          time.Time
	inputBlocked                                     bool
}

// EscapeView contains only local display values, never connection credentials.
type EscapeView struct {
	State                               escape.RoundState
	Map                                 escape.Map
	Scent                               [escape.ScentCapacity]escape.ScentPoint
	ScentCount                          int
	Result                              protocol.GameResult
	Started, CanRestart, RestartPending bool
	Round, Inputs, Snapshots            uint64
	Queue                               int
	Relay                               string
}

func (host *Host) InspectEscapeView() EscapeView {
	host.mu.Lock()
	game := host.game
	host.mu.Unlock()
	if game == nil {
		return EscapeView{}
	}
	game.mu.Lock()
	defer game.mu.Unlock()
	view := EscapeView{Round: game.roundNumber, Inputs: game.inputs, Snapshots: game.snapshots,
		Queue: len(game.queue), Relay: game.relay, RestartPending: game.restartRequested}
	if game.round != nil {
		view.Started, view.State, view.Map = true, game.round.Inspect(), game.round.Map()
		view.Scent, view.ScentCount = game.round.Scent()
	}
	if game.result != nil {
		view.Result = *game.result
		if game.result.JitterMS != nil {
			jitter := *game.result.JitterMS
			view.Result.JitterMS = &jitter
		}
		state := host.Authority.Inspect(time.Now()).State
		view.CanRestart = !game.config.Once && (state == Active || state == ReconnectGrace) && game.result.Outcome != string(escape.ConnectionLost)
	}
	return view
}

// RestartEscape queues at most one local request. A regular post-result
// PING/PONG drains the old browser input before a connected round is replaced.
func (host *Host) RestartEscape() error {
	host.mu.Lock()
	game := host.game
	host.mu.Unlock()
	if game == nil {
		return ErrInvalidTransition
	}
	game.mu.Lock()
	defer game.mu.Unlock()
	state := host.Authority.Inspect(time.Now()).State
	if game.config.Once || game.result == nil || game.result.Outcome == string(escape.ConnectionLost) || (state != Active && state != ReconnectGrace) {
		return ErrInvalidTransition
	}
	game.restartRequested = true
	if game.connection == nil || game.resultAcknowledged {
		return game.restart()
	}
	return nil
}

func (game *escapeGame) restart() error {
	game.clearQueue()
	game.round, game.result = nil, nil
	game.resultSent, game.resultAcknowledged, game.restartRequested = false, false, false
	game.resultPing = [16]byte{}
	if game.connection != nil {
		if err := game.startRound(); err != nil {
			return err
		}
		if err := game.initializeConnection(); err != nil {
			return err
		}
	}
	game.host.notify()
	return nil
}

func (game *escapeGame) ping(connection *hostConnection, frame protocol.Frame) {
	game.mu.Lock()
	defer game.mu.Unlock()
	if game.connection == connection && game.inputBlocked && game.inputPing == [16]byte{} {
		copy(game.inputPing[:], frame.Payload)
	}
	if game.connection == connection && game.resultSent && !game.resultAcknowledged && game.resultPing == [16]byte{} {
		copy(game.resultPing[:], frame.Payload)
	}
}

func (game *escapeGame) pong(connection *hostConnection, payload []byte) error {
	game.mu.Lock()
	defer game.mu.Unlock()
	if game.connection == connection && game.inputBlocked && game.inputPing != [16]byte{} && len(payload) == 16 && binary.BigEndian.Uint64(payload) >= binary.BigEndian.Uint64(game.inputPing[:]) {
		game.inputBlocked, game.inputDrained = false, time.Now()
		game.inputPing = [16]byte{}
	}
	// Host calls this only after Latency validates the echoed sequence/stamp.
	// Any valid post-result ping proves the same ordered boundary. A peer that
	// misses the liveness deadline must establish a new connection instead.
	if game.connection != connection || !game.resultSent || game.resultPing == [16]byte{} || len(payload) != 16 || binary.BigEndian.Uint64(payload) < binary.BigEndian.Uint64(game.resultPing[:]) {
		return nil
	}
	game.resultAcknowledged = true
	if game.restartRequested {
		return game.restart()
	}
	return nil
}

func (game *escapeGame) startRound() error {
	if game.roundNumber == math.MaxUint64 {
		return &protocol.ProtocolError{Code: protocol.CodeInternal}
	}
	round, err := escape.NewRound(game.config.Map, game.config.Seed, game.config.Round, time.Now())
	if err != nil {
		return err
	}
	game.round, game.roundNumber = round, game.roundNumber+1
	game.resetInputBoundary()
	return nil
}

func (game *escapeGame) resetInputBoundary() {
	game.lastInput, game.inputDrained, game.inputPing = time.Time{}, time.Time{}, [16]byte{}
	game.inputBlocked = false
}

// TCP acceptance is not delivery. Drain the old ordered stream through a
// regular post-gap ping before allowing queued intent to refresh input age.
func (game *escapeGame) requireInputBoundary(now time.Time) {
	latest := game.lastInput
	if game.inputDrained.After(latest) {
		latest = game.inputDrained
	}
	if !game.lastInput.IsZero() && now.Sub(latest) > escape.InputDecayAfter {
		game.inputBlocked = true
	}
}

// ConfigureEscape validates local policy before Listen or transport admission.
// The actual round starts only after the first authorized WELCOME.
func (host *Host) ConfigureEscape(config EscapeConfig) error {
	host.mu.Lock()
	defer host.mu.Unlock()
	if host.mode != "escape" || host.game != nil || host.listening || host.waiting || host.closing || len(host.connections) != 0 {
		return ErrInvalidTransition
	}
	if _, err := escape.New(config.Map, config.Seed, config.Round); err != nil {
		return err
	}
	if config.Control != "touch" && config.Control != "tilt" {
		return ErrInvalidConfig
	}
	host.game = &escapeGame{host: host, config: config, queue: make([]protocol.Frame, 0, maxGameOutput), rateAt: time.Now()}
	return nil
}

// InspectEscape returns a value snapshot for the local spectator and tests.
func (host *Host) InspectEscape() (escape.RoundState, bool) {
	host.mu.Lock()
	game := host.game
	host.mu.Unlock()
	if game == nil {
		return escape.RoundState{}, false
	}
	game.mu.Lock()
	defer game.mu.Unlock()
	if game.round == nil {
		return escape.RoundState{}, false
	}
	return game.round.Inspect(), true
}

func (game *escapeGame) attach(connection *hostConnection) error {
	game.mu.Lock()
	defer game.mu.Unlock()
	now := time.Now()
	if err := game.host.Authority.Authorize(connection.lease, "game_view", now); err != nil {
		return err
	}
	if game.round == nil {
		if err := game.startRound(); err != nil {
			return err
		}
	}
	game.clearQueue()
	game.round.ForgetConnection()
	game.connection, game.clientEventSequence = connection, 0
	game.resetInputBoundary()
	game.resultSent, game.resultAcknowledged = false, false
	game.resultPing = [16]byte{}
	return game.initializeConnection()
}

func (game *escapeGame) initializeConnection() error {
	frame, err := game.initialization()
	if err != nil {
		return err
	}
	game.offer(frame)
	if err := game.offerSnapshot(); err != nil {
		return err
	}
	if game.result != nil {
		frame, err := protocol.GameResultFrame(*game.result)
		if err != nil {
			return err
		}
		game.offer(frame)
	} else if state := game.round.Inspect(); state.Phase == escape.CountingDown {
		return game.event("countdown", countdownSeconds(state.CountdownRemaining), false)
	}
	return nil
}

func (game *escapeGame) detach(connection *hostConnection) {
	game.mu.Lock()
	defer game.mu.Unlock()
	if game.connection != connection {
		return
	}
	game.connection = nil
	game.round.ForgetConnection()
	game.clearQueue()
	if game.restartRequested {
		if err := game.restart(); err != nil {
			game.host.finish(InternalFailure)
		}
	}
}

func (game *escapeGame) input(connection *hostConnection, frame protocol.Frame) error {
	game.mu.Lock()
	defer game.mu.Unlock()
	now := time.Now()
	if game.connection != connection || game.round == nil {
		return &protocol.ProtocolError{Code: protocol.CodeUnauthorized}
	}
	if err := game.host.Authority.Authorize(connection.lease, capabilityFor(frame.Type), now); err != nil {
		return err
	}
	if frame.Type == protocol.TypeGameEvent {
		event, err := protocol.DecodeGameEvent(frame, protocol.PeerBrowser)
		if err != nil {
			return err
		}
		if uint32(event.Sequence) > game.clientEventSequence {
			game.clientEventSequence = uint32(event.Sequence)
			game.host.finish(ModeComplete)
		}
		return nil
	}
	input, err := protocol.DecodeGameInput(frame)
	if err != nil {
		return err
	}
	if input.Dash {
		if err := game.host.Authority.Authorize(connection.lease, "dash", now); err != nil {
			return err
		}
	}
	if game.result != nil || input.Sequence <= game.round.Inspect().AcceptedSequence {
		return nil
	}
	game.requireInputBoundary(now)
	if game.inputBlocked {
		if input.Dash {
			return game.event("dash_rejected", float64(ceilMS(game.round.Inspect().DashCooldown)), false)
		}
		return nil
	}
	accepted, err := game.round.Accept(now, input.Sequence, escape.Input{Direction: escape.Point{X: input.VelocityX, Y: input.VelocityY}, Dash: input.Dash})
	if accepted {
		game.inputs++
		game.lastInput, game.inputDrained = now, time.Time{}
	}
	if errors.Is(err, escape.ErrInputBackpressure) {
		return &protocol.ProtocolError{Code: protocol.CodeBackpressure}
	}
	return err
}

func (game *escapeGame) tick() error {
	game.mu.Lock()
	defer game.mu.Unlock()
	if game.round == nil || game.result != nil {
		return nil
	}
	now := time.Now()
	game.requireInputBoundary(now)
	if authority := game.host.Authority.Inspect(now); authority.State == Closed || authority.State == Expired {
		return nil
	}
	previous := game.round.Inspect()
	latency := game.host.latency.Inspect()
	update, err := game.round.Tick(now, time.Duration(latency.RTTMS*float64(time.Millisecond)))
	if err != nil {
		return err
	}
	if update.PauseChanged {
		name := "connection_resumed"
		if update.Paused {
			name = "connection_paused"
		}
		if err := game.event(name, 0, true); err != nil {
			return err
		}
	}
	before, after := countdownSeconds(previous.CountdownRemaining), countdownSeconds(update.State.CountdownRemaining)
	if before != after {
		if err := game.event("countdown", after, false); err != nil {
			return err
		}
	}
	for cheese := range 2 {
		if update.CheeseMask&(1<<cheese) != 0 {
			if err := game.event("cheese_collected", float64(cheese), false); err != nil {
				return err
			}
		}
	}
	if !previous.ExitOpen() && update.State.ExitOpen() {
		if err := game.event("exit_opened", 0, true); err != nil {
			return err
		}
	}
	if update.DashRejected {
		if err := game.event("dash_rejected", float64(ceilMS(update.State.DashCooldown)), false); err != nil {
			return err
		}
	}
	if update.SnapshotDue || update.Result != "" {
		if err := game.offerSnapshot(); err != nil {
			return err
		}
	}
	if update.Result != "" {
		result := protocol.GameResult{Outcome: string(update.Result), ElapsedMS: float64(update.State.Elapsed / time.Millisecond),
			Relay: game.relay, RTTP50MS: math.Round(latency.P50MS), RTTP95MS: math.Round(latency.P95MS)}
		if latency.Samples > 0 {
			jitter := math.Round(latency.JitterMS)
			result.JitterMS = &jitter
		}
		result.Message = protocol.GameResultMessage(result.Outcome, result.RTTP50MS)
		frame, err := protocol.GameResultFrame(result)
		if err != nil {
			return err
		}
		game.result = &result
		game.offer(frame)
		if game.connection == nil {
			game.complete()
		}
	}
	return nil
}

func (game *escapeGame) complete() {
	if game.result.Outcome == string(escape.ConnectionLost) {
		game.host.finish(GraceExpired)
	} else if game.config.Once {
		game.host.finish(ModeComplete)
	}
}

func (game *escapeGame) sent(connection *hostConnection, frame protocol.Frame, err error) {
	if frame.Type != protocol.TypeGameResult && frame.Type != protocol.TypeGameSnapshot {
		return
	}
	game.mu.Lock()
	defer game.mu.Unlock()
	if game.connection != connection {
		return
	}
	if frame.Type == protocol.TypeGameSnapshot {
		if err == nil {
			game.snapshots++
		}
		return
	}
	if err != nil {
		game.host.finish(TransportFailure)
		return
	}
	game.resultSent = true
	game.complete()
}

func (game *escapeGame) event(name string, value float64, null bool) error {
	if game.eventSequence == math.MaxUint32 {
		return &protocol.ProtocolError{Code: protocol.CodeInternal}
	}
	game.eventSequence++
	event := protocol.GameEvent{Sequence: float64(game.eventSequence), Event: name}
	if !null {
		event.Value = &value
	}
	frame, err := protocol.GameEventFrame(event, protocol.PeerHost)
	if err == nil {
		game.offer(frame)
	}
	return err
}

func (game *escapeGame) initialization() (protocol.Frame, error) {
	layout := game.round.Map()
	return protocol.GameInitFrame(protocol.GameInit{Seed: strconv.FormatInt(game.config.Seed, 10),
		Map:   protocol.GameMap{Name: layout.Name, Width: escape.MapWidth, Height: escape.MapHeight, Rows: append([]string(nil), layout.Rows[:]...)},
		Mouse: gamePoint(layout.Mouse), Cat: gamePoint(layout.Cat), Cheeses: []protocol.GamePoint{gamePoint(layout.Cheese[0]), gamePoint(layout.Cheese[1])}, Exit: gamePoint(layout.Exit),
		RoundDurationMS: float64(ceilMS(game.config.Round)), CountdownMS: float64(escape.Countdown / time.Millisecond),
		Presentation: protocol.GamePresentation{Control: game.config.Control, PhoneRender: game.config.PhoneRender, ShowNet: game.config.ShowNet},
		Constants: protocol.GameConstants{MouseSpeed: escape.MouseSpeed, CatBaseSpeed: escape.CatBaseSpeed, CatMaxSpeed: escape.CatMaxSpeed,
			DashMultiplier: escape.DashMultiplier, DashDurationMS: float64(escape.DashDuration / time.Millisecond), DashCooldownMS: float64(escape.DashCooldown / time.Millisecond)}})
}

func (game *escapeGame) offerSnapshot() error {
	if game.snapshotSequence == math.MaxUint32 {
		return &protocol.ProtocolError{Code: protocol.CodeInternal}
	}
	state := game.round.Inspect()
	game.snapshotSequence++
	phase := uint8(0)
	if state.Phase != escape.CountingDown {
		phase = 1
	}
	if state.Paused {
		phase = 2
	}
	mask := uint8(0)
	for index, collected := range state.Cheese {
		if collected {
			mask |= 1 << index
		}
	}
	frame, err := protocol.GameSnapshotFrame(protocol.GameSnapshot{Sequence: game.snapshotSequence, AcceptedInputSequence: state.AcceptedSequence,
		ElapsedMS: uint64(state.Elapsed / time.Millisecond), Mouse: gamePoint(state.Mouse), Cat: gamePoint(state.Cat),
		RemainingMS: uint32(ceilMS(game.config.Round) - uint64(state.Elapsed/time.Millisecond)), DashCooldownMS: uint32(ceilMS(state.DashCooldown)), CollectedMask: mask, Phase: phase, ExitOpen: state.ExitOpen()})
	if err == nil {
		game.offer(frame)
	}
	return err
}

// offer owns frame bytes, coalesces only snapshots, and never blocks the core.
func (game *escapeGame) offer(frame protocol.Frame) {
	if game.connection == nil || game.connection.ctx.Err() != nil {
		clear(frame.Payload)
		return
	}
	if frame.Type == protocol.TypeGameSnapshot {
		for index, queued := range game.queue {
			if queued.Type == protocol.TypeGameSnapshot {
				clear(queued.Payload)
				game.queue[index] = frame // Keep initialization/discrete ordering intact.
				return
			}
		}
	}
	if len(game.queue) == maxGameOutput {
		clear(frame.Payload)
		game.connection.cancel()
		return
	}
	game.queue = append(game.queue, frame)
	select {
	case game.connection.gameWake <- struct{}{}:
	default:
	}
}

func (game *escapeGame) next(connection *hostConnection) (protocol.Frame, bool) {
	game.mu.Lock()
	defer game.mu.Unlock()
	if connection != game.connection || len(game.queue) == 0 || connection.ctx.Err() != nil {
		return protocol.Frame{}, false
	}
	frame := game.queue[0]
	copy(game.queue, game.queue[1:])
	game.queue[len(game.queue)-1] = protocol.Frame{}
	game.queue = game.queue[:len(game.queue)-1]
	if len(game.queue) != 0 {
		select {
		case connection.gameWake <- struct{}{}:
		default:
		}
	}
	return frame, true
}

func (game *escapeGame) clearQueue() {
	for _, frame := range game.queue {
		clear(frame.Payload)
	}
	clear(game.queue)
	game.queue = game.queue[:0]
}
func gamePoint(point escape.Point) protocol.GamePoint {
	return protocol.GamePoint{X: float64(point.X), Y: float64(point.Y)}
}
func ceilMS(duration time.Duration) uint64 {
	return uint64((duration + time.Millisecond - 1) / time.Millisecond)
}
func countdownSeconds(duration time.Duration) float64 {
	return float64((duration + time.Second - 1) / time.Second)
}
