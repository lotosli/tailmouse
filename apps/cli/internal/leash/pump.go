package leash

import (
	"context"
	"errors"
	"fmt"
	"io"
	"sync"
)

const (
	MaxInputBytes      = 256 << 10
	BrowserBufferBytes = 1 << 20
	// The terminal frame's 32 KiB limit includes its type and flags bytes.
	TerminalChunkBytes = (32 << 10) - 2
)

var (
	ErrBackpressure       = errors.New("terminal input buffer is full")
	ErrInput              = errors.New("invalid terminal input chunk")
	ErrPumpClosed         = errors.New("terminal I/O is closed")
	ErrSubscriptionClosed = errors.New("terminal subscription is closed")
	ErrPumpRunning        = errors.New("terminal I/O has already started")
	errOutputDrained      = errors.New("terminal output drained")
)

// PTY is the OS boundary consumed by the pump. The caller owns startup, process
// control and final closure. Cancellation of a stream is not process lifetime.
type PTY interface {
	Read(context.Context, []byte) (int, error)
	Write(context.Context, []byte) error
	Done() <-chan struct{}
}

// Pump bounds terminal input/output independently of network delivery. Only
// Run reads the PTY; its one joined writer serializes all accepted input bytes.
type Pump struct {
	process              PTY
	local                func(context.Context, []byte) error
	history, delivery    *Ring
	outputMu             sync.Mutex
	subscriber           *Subscription
	outputEnded          bool
	inputMu              sync.Mutex
	input                [MaxInputBytes]byte
	head, queued         int
	inputWake            chan struct{}
	inputClosed, started bool
}

func NewPump(process PTY, scrollback int, local func(context.Context, []byte) error) (*Pump, error) {
	if process == nil || local == nil {
		return nil, ErrInput
	}
	history, err := NewRing(scrollback)
	if err != nil {
		return nil, err
	}
	delivery, err := NewRing(BrowserBufferBytes)
	if err != nil {
		return nil, err
	}
	return &Pump{process: process, local: local, history: history, delivery: delivery, inputWake: make(chan struct{}, 1)}, nil
}

// RestartMarker precedes this generation's first PTY read in both local and
// retained output. It accepts no command text and cannot race a running pump.
func (pump *Pump) RestartMarker(ctx context.Context, generation uint32) error {
	pump.inputMu.Lock()
	defer pump.inputMu.Unlock()
	if generation < 2 || pump.started {
		return ErrInput
	}
	data := []byte(fmt.Sprintf("\r\n──── TailMouse restarted process · generation %d ────\r\n", generation))
	if err := pump.history.Append(data); err != nil {
		return err
	}
	if err := pump.delivery.Append(data); err != nil {
		return err
	}
	return pump.local(ctx, data)
}

// Input accepts a complete chunk atomically. It never waits for terminal or
// network I/O. The source must be authorized by the host before calling it.
func (pump *Pump) Input(ctx context.Context, data []byte) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if len(data) == 0 || len(data) > TerminalChunkBytes {
		return ErrInput
	}
	pump.inputMu.Lock()
	defer pump.inputMu.Unlock()
	if pump.inputClosed {
		return ErrPumpClosed
	}
	select {
	case <-pump.process.Done():
		return ErrPumpClosed
	default:
	}
	if len(data) > len(pump.input)-pump.queued {
		return ErrBackpressure
	}
	start := (pump.head + pump.queued) % len(pump.input)
	first := copy(pump.input[start:], data)
	copy(pump.input[:], data[first:])
	pump.queued += len(data)
	select {
	case pump.inputWake <- struct{}{}:
	default:
	}
	return nil
}

// PendingInput includes the bytes already handed to the single PTY writer.
func (pump *Pump) PendingInput() int {
	pump.inputMu.Lock()
	defer pump.inputMu.Unlock()
	return pump.queued
}

// RetainedOutputBytes measures history without allocating or copying PTY data.
func (pump *Pump) RetainedOutputBytes() int {
	pump.history.mu.Lock()
	defer pump.history.mu.Unlock()
	return int(min(pump.history.total, uint64(len(pump.history.data))))
}

func (pump *Pump) write(ctx context.Context) error {
	var data [TerminalChunkBytes]byte
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		pump.inputMu.Lock()
		count := min(pump.queued, len(data))
		first := copy(data[:count], pump.input[pump.head:])
		copy(data[first:count], pump.input[:])
		pump.inputMu.Unlock()
		if count == 0 {
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-pump.inputWake:
				continue
			}
		}
		if err := pump.process.Write(ctx, data[:count]); err != nil {
			return err
		}
		pump.inputMu.Lock()
		first = min(count, len(pump.input)-pump.head)
		clear(pump.input[pump.head : pump.head+first])
		clear(pump.input[:count-first])
		pump.head = (pump.head + count) % len(pump.input)
		pump.queued -= count
		pump.inputMu.Unlock()
		clear(data[:count])
	}
}

// Run returns after the PTY reaches EOF or a root I/O/cancellation error. It
// always cancels and joins its writer, clears pending input and seals output.
// A child may still be alive after cancellation; its owner decides how to close.
func (pump *Pump) Run(parent context.Context) (failure error) {
	pump.inputMu.Lock()
	if pump.started {
		pump.inputMu.Unlock()
		return ErrPumpRunning
	}
	pump.started = true
	pump.inputMu.Unlock()
	ctx, cancel := context.WithCancelCause(parent)
	writerDone := make(chan struct{})
	go func() {
		defer close(writerDone)
		defer func() {
			if recover() != nil {
				cancel(errors.New("terminal input writer failed"))
			}
		}()
		if err := pump.write(ctx); err != nil && ctx.Err() == nil {
			select {
			case <-pump.process.Done(): // Normal exit can close the PTY during an input write.
			default:
				cancel(err)
			}
		}
	}()
	defer func() {
		if recover() != nil {
			failure = errors.New("terminal output reader failed")
		}
		pump.inputMu.Lock()
		pump.inputClosed = true
		pump.inputMu.Unlock()
		if failure == nil {
			cancel(errOutputDrained)
		} else {
			cancel(failure)
		}
		<-writerDone
		// WithCancelCause selects the first root failure across both I/O paths.
		failure = context.Cause(ctx)
		if errors.Is(failure, errOutputDrained) {
			failure = nil
		}
		pump.inputMu.Lock()
		pump.head, pump.queued = 0, 0
		clear(pump.input[:])
		pump.inputMu.Unlock()
		pump.outputMu.Lock()
		pump.outputEnded = true
		pump.wakeOutput()
		pump.outputMu.Unlock()
	}()
	var data [TerminalChunkBytes]byte
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		count, err := pump.process.Read(ctx, data[:])
		if count < 0 || count > len(data) {
			return errors.New("invalid terminal read length")
		}
		if count > 0 {
			pump.outputMu.Lock()
			appendErr := pump.history.Append(data[:count])
			if appendErr == nil {
				appendErr = pump.delivery.Append(data[:count])
			}
			pump.wakeOutput()
			pump.outputMu.Unlock()
			if appendErr != nil {
				return appendErr
			}
			if err := pump.local(ctx, data[:count]); err != nil {
				return err
			}
		}
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return err
		}
		if count == 0 {
			return io.ErrNoProgress
		}
	}
}

func (pump *Pump) wakeOutput() {
	if pump.subscriber != nil {
		select {
		case pump.subscriber.changed <- struct{}{}:
		default:
		}
	}
}

// Subscription is a single serialized browser output reader. Replacing or
// closing it never closes the PTY or changes local output. Read data is copied.
type Subscription struct {
	pump    *Pump
	cursor  uint64
	closed  bool
	changed chan struct{}
	done    chan struct{}
}

// Subscribe atomically captures history and the live cursor. The consumer must
// send reset, this snapshot and its dropped count before reading live output.
// At most one active subscriber exists; a superseded reader fails explicitly.
func (pump *Pump) Subscribe() (Chunk, *Subscription) {
	pump.outputMu.Lock()
	defer pump.outputMu.Unlock()
	if pump.subscriber != nil {
		pump.subscriber.closeLocked()
	}
	snapshot := pump.history.Snapshot()
	subscriber := &Subscription{pump: pump, cursor: snapshot.End, changed: make(chan struct{}, 1), done: make(chan struct{})}
	pump.subscriber = subscriber
	return snapshot, subscriber
}

func (subscriber *Subscription) Read(ctx context.Context, limit int) (Chunk, error) {
	for {
		if err := ctx.Err(); err != nil {
			return Chunk{}, err
		}
		chunk, err := subscriber.ReadAvailable(limit)
		if err != nil || len(chunk.Data) > 0 {
			return chunk, err
		}
		select {
		case <-ctx.Done():
			return Chunk{}, ctx.Err()
		case <-subscriber.done:
			return Chunk{}, ErrSubscriptionClosed
		case <-subscriber.changed:
		}
	}
}

// Changed lets the session's existing sender select output alongside PING and
// process-state updates. ReadAvailable is single-consumer, like Read.
func (subscriber *Subscription) Changed() <-chan struct{} { return subscriber.changed }

func (subscriber *Subscription) ReadAvailable(limit int) (Chunk, error) {
	if limit <= 0 || limit > TerminalChunkBytes {
		return Chunk{}, ErrInput
	}
	pump := subscriber.pump
	pump.outputMu.Lock()
	defer pump.outputMu.Unlock()
	if subscriber.closed {
		return Chunk{}, ErrSubscriptionClosed
	}
	chunk, err := pump.delivery.ReadFrom(subscriber.cursor, limit)
	if err == nil {
		subscriber.cursor = chunk.End
	}
	if err == nil && len(chunk.Data) == 0 && pump.outputEnded {
		err = io.EOF
	}
	return chunk, err
}

func (subscriber *Subscription) closeLocked() {
	if !subscriber.closed {
		subscriber.closed = true
		close(subscriber.done)
	}
}

func (subscriber *Subscription) Close() {
	subscriber.pump.outputMu.Lock()
	defer subscriber.pump.outputMu.Unlock()
	subscriber.closeLocked()
	if subscriber.pump.subscriber == subscriber {
		subscriber.pump.subscriber = nil
	}
}
