package share

import (
	"context"
	"errors"
	"io"
	"sync"
	"time"

	"tailmouse/apps/cli/internal/leash"
	"tailmouse/apps/cli/internal/platform/pty"
)

type Terminal struct {
	localCols, localRows int
	process              *pty.Process
	host                 *Host
	ctx                  context.Context
	cancel               context.CancelFunc
	mu                   sync.Mutex
	input                sync.Mutex
	history              []byte
	truncated            bool
	subscribers          map[Stream]chan []byte
	local                io.Writer
	cols, rows           int
	exited               bool
	result               pty.Result
	done                 chan struct{}
	closeOnce            sync.Once
	closeErr             error
	failure              error
}
type TerminalState struct {
	Cols        int    `json:"cols"`
	Rows        int    `json:"rows"`
	Type        string `json:"type"`
	PID         int    `json:"pid"`
	Running     bool   `json:"running"`
	ExitCode    int    `json:"exitCode"`
	Controller  bool   `json:"controller"`
	Recovery    string `json:"recovery"`
	HistoryLost bool   `json:"historyLost"`
}

func NewTerminal(ctx context.Context, o Options, environ []string, host *Host) (*Terminal, error) {
	command, e := leash.NewCommand(o.Argv, o.Cwd, o.Title, environ, nil)
	if e != nil {
		return nil, ErrConfig
	}
	process, e := pty.Start(ctx, command)
	if e != nil {
		return nil, errors.New("CLI_START_FAILED")
	}
	c, cancel := context.WithCancel(ctx)
	t := &Terminal{process: process, host: host, ctx: c, cancel: cancel, subscribers: map[Stream]chan []byte{}, cols: 80, rows: 24, done: make(chan struct{})}
	go t.read()
	return t, nil
}
func (t *Terminal) read() {
	defer close(t.done)
	var failure error
	buffer := make([]byte, ChunkSize)
	for {
		n, e := t.process.Read(t.ctx, buffer)
		if n > 0 {
			data := append([]byte(nil), buffer[:n]...)
			t.mu.Lock()
			if !t.truncated {
				if len(t.history)+n <= 4<<20 {
					t.history = append(t.history, data...)
				} else {
					t.history = nil
					t.truncated = true
				}
			}
			for stream, ch := range t.subscribers {
				select {
				case ch <- data:
				default:
					_ = stream.Close()
					delete(t.subscribers, stream)
				}
			}
			local := t.local
			t.mu.Unlock()
			if local != nil {
				if _, e := local.Write(data); e != nil {
					failure = errors.New("CLI_LOCAL_OUTPUT_FAILED")
					t.cancel()
					break
				}
			}
		}
		if e != nil {
			break
		}
	}
	result, e := t.process.Wait(t.ctx)
	if failure != nil {
		cleanup, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		_ = t.process.Close(cleanup)
		cancel()
	}
	t.mu.Lock()
	t.exited = true
	t.failure = failure
	if e != nil {
		result.ExitCode = -1
	}
	t.result = result
	t.mu.Unlock()
	if failure != nil && t.host.options.Command == "cli" {
		t.host.cancel()
		return
	}
	if e == nil && t.host.options.Command == "cli" {
		timer := time.NewTimer(60 * time.Second)
		defer timer.Stop()
		select {
		case <-timer.C:
			t.host.cancel()
		case <-t.ctx.Done():
		}
	}
}
func (t *Terminal) Err() error                { t.mu.Lock(); defer t.mu.Unlock(); return t.failure }
func (t *Terminal) Running() bool             { t.mu.Lock(); defer t.mu.Unlock(); return !t.exited }
func (t *Terminal) SetLocal(writer io.Writer) { t.mu.Lock(); t.local = writer; t.mu.Unlock() }
func (t *Terminal) LocalInput(ctx context.Context, data []byte) error {
	t.input.Lock()
	defer t.input.Unlock()
	t.host.TakeLocal()
	if e := t.restoreLocalLocked(ctx); e != nil {
		return e
	}
	return t.process.Write(ctx, data)
}
func (t *Terminal) LocalResize(ctx context.Context, cols, rows int) error {
	t.input.Lock()
	defer t.input.Unlock()
	t.localCols, t.localRows = cols, rows
	t.host.mu.Lock()
	remote := t.host.controller != ""
	t.host.mu.Unlock()
	if remote {
		return nil
	}
	return t.restoreLocalLocked(ctx)
}
func (t *Terminal) restoreLocalLocked(ctx context.Context) error {
	if t.localCols < 20 || t.localCols > 500 || t.localRows < 5 || t.localRows > 200 {
		return nil
	}
	if e := t.process.Resize(ctx, t.localCols, t.localRows); e != nil {
		return e
	}
	t.mu.Lock()
	t.cols, t.rows = t.localCols, t.localRows
	t.mu.Unlock()
	return nil
}
func (t *Terminal) RestoreLocal(ctx context.Context) error {
	t.input.Lock()
	defer t.input.Unlock()
	return t.restoreLocalLocked(ctx)
}
func (h *Host) Terminal() *Terminal { return h.terminal }
func (t *Terminal) Serve(ctx context.Context, stream Stream, member string) {
	t.mu.Lock()
	history := append([]byte(nil), t.history...)
	truncated := t.truncated
	ch := make(chan []byte, 32)
	t.subscribers[stream] = ch
	state := TerminalState{Cols: t.cols, Rows: t.rows, Type: "terminal", PID: t.process.PID(), Running: !t.exited, ExitCode: t.result.ExitCode, Recovery: "history", HistoryLost: truncated}
	cols, rows := t.cols, t.rows
	t.mu.Unlock()
	defer func() { t.mu.Lock(); delete(t.subscribers, stream); t.mu.Unlock() }()
	state.Controller = t.host.CanInput(member)
	if truncated {
		state.Recovery = "redraw"
	}
	if WriteJSON(stream, state) != nil {
		return
	}
	for len(history) > 0 {
		n := min(len(history), ChunkSize)
		if WriteFrame(stream, DataFrame, history[:n]) != nil {
			return
		}
		history = history[n:]
	}
	if truncated {
		t.input.Lock()
		e := t.process.Resize(ctx, cols%480+20, rows)
		if e == nil {
			// Wait for the application to observe the intermediate size. A fixed
			// short sleep can coalesce both SIGWINCH events before ncurses reads
			// the size, leaving a reconnecting guest with only screen deltas.
			timer := time.NewTimer(500 * time.Millisecond)
			select {
			case <-timer.C:
			case data := <-ch:
				if WriteFrame(stream, DataFrame, data) != nil {
					timer.Stop()
					t.input.Unlock()
					return
				}
			case <-ctx.Done():
			}
			timer.Stop()
			e = t.process.Resize(ctx, cols, rows)
		}
		t.input.Unlock()
		if e != nil {
			_ = sendError(stream, "TERMINAL_REDRAW_REQUIRED")
		}
	}
	readErr := make(chan error, 1)
	go func() { readErr <- t.readInput(ctx, stream, member) }()
	defer func() { _ = stream.Close(); <-readErr }()
	tick := time.NewTicker(time.Second)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case e := <-readErr:
			readErr <- e
			return
		case data := <-ch:
			if WriteFrame(stream, DataFrame, data) != nil {
				return
			}
		case <-tick.C:
			t.mu.Lock()
			next := TerminalState{Cols: t.cols, Rows: t.rows, Type: "terminal.state", PID: t.process.PID(), Running: !t.exited, ExitCode: t.result.ExitCode}
			t.mu.Unlock()
			next.Controller = t.host.CanInput(member)
			if WriteJSON(stream, next) != nil {
				return
			}
		}
	}
}
func (t *Terminal) readInput(ctx context.Context, stream Stream, member string) error {
	for {
		f, e := ReadFrame(stream)
		if e != nil {
			return e
		}
		t.input.Lock()
		if !t.host.CanInput(member) {
			t.input.Unlock()
			return ErrReadonly
		}
		switch f.Kind {
		case DataFrame:
			e = t.process.Write(ctx, f.Data)
		case JSONFrame:
			var m Message
			e = Decode(f, &m)
			if e == nil {
				switch m.Type {
				case "resize":
					e = t.process.Resize(ctx, m.Cols, m.Rows)
					if e == nil {
						t.mu.Lock()
						t.cols, t.rows = m.Cols, m.Rows
						t.mu.Unlock()
					}
				case "interrupt":
					e = t.process.Interrupt(ctx)
				default:
					e = ErrFrame
				}
			}
		default:
			e = ErrFrame
		}
		t.input.Unlock()
		if e != nil {
			return e
		}
	}
}
func (t *Terminal) Close() error {
	t.closeOnce.Do(func() {
		t.cancel()
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		t.closeErr = t.process.Close(ctx)
		<-t.done
	})
	return t.closeErr
}
