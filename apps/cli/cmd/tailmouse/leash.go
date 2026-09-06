package main

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"time"

	"tailmouse/apps/cli/internal/config"
	"tailmouse/apps/cli/internal/leash"
	"tailmouse/apps/cli/internal/platform/pty"
	"tailmouse/apps/cli/internal/protocol"
	"tailmouse/apps/cli/internal/session"
)

func watchLeash(parent context.Context, host *session.Host, options config.Options, command *leash.Command, input *os.File, output io.Writer, log *diagnostics, signals <-chan os.Signal, shutdown func(session.Outcome, func() session.Outcome)) (code int, outcome session.Outcome) {
	code, outcome = exitInternal, session.InternalFailure
	if parent.Err() != nil {
		return exitExpired, session.LocalRevoke
	}
	file, ok := output.(*os.File)
	if !ok {
		return config.ExitPTY, session.InternalFailure
	}
	console, err := openLeashConsole(input, file)
	if err != nil {
		return config.ExitPTY, session.InternalFailure
	}
	ctx, cancel := context.WithCancel(parent)
	defer cancel()
	log.terminal(console.state != nil, false)
	var process *pty.Process
	var pump *leash.Pump
	var pumpCancel context.CancelFunc
	var pumpDone <-chan error
	var childDone <-chan struct{}
	var childResult pty.Result
	state := protocol.ProcessState{Generation: 1, State: "waiting", Title: command.Title()}
	var ended, drained, accessClosed bool
	var gracefulStop bool
	var lastInterrupt time.Time
	var retention, resize, drain *time.Timer
	var retentionTick, resizeTick, drainTick <-chan time.Time
	var latestSize session.LeashSize
	var pendingLocal []byte
	var retryInput *time.Timer
	var retryInputTick <-chan time.Time
	localResize := leashResizeEvents(console)
	requestLocalResize := func() error {
		cols, rows, err := console.Size()
		if err != nil {
			return err
		}
		if cols < 20 || cols > 500 || rows < 5 || rows > 200 {
			return nil
		}
		return host.ResizeLeash(cols, rows, time.Now())
	}

	inputReader := readLeashInput(ctx, console)
	local := inputReader.values
	waitCtx, stopWait := context.WithCancel(ctx)
	accessDone := make(chan session.Outcome, 1)
	go func() { accessDone <- host.Wait(waitCtx) }()
	waited := false
	defer func() {
		if recover() != nil {
			code, outcome = exitInternal, session.InternalFailure
		}
		shutdown(outcome, func() session.Outcome {
			cancel()
			stopWait()
			if !waited {
				<-accessDone
			}
			if pumpCancel != nil {
				pumpCancel()
			}
			if inputReader != nil {
				inputReader.Close()
			}
			clear(pendingLocal)
			if process != nil {
				cleanup, finish := context.WithTimeout(context.Background(), 6*time.Second)
				if gracefulStop && !ended {
					if err := process.Terminate(cleanup); err != nil {
						_ = log.cleanupFailure("process_shutdown")
						code, outcome = exitInternal, session.InternalFailure
					}
				}
				if err := process.Close(cleanup); err != nil {
					_ = log.cleanupFailure("process_shutdown")
					if code == exitOK || childOutcome(outcome) {
						code, outcome = exitInternal, session.InternalFailure
					}
				}
				if gracefulStop && childOutcome(outcome) {
					result, err := process.Wait(cleanup)
					if err != nil {
						code, outcome = exitInternal, session.InternalFailure
					} else {
						code = result.ExitCode
					}
				}
				finish()
			}
			if pumpDone != nil {
				<-pumpDone
			}
			for _, timer := range []*time.Timer{retention, resize, drain, retryInput} {
				if timer != nil {
					timer.Stop()
				}
			}
			return outcome
		})
		if console != nil {
			if err := console.Close(); err != nil {
				_ = log.cleanupFailure("terminal_restoration")
				if code == exitOK || childOutcome(outcome) {
					code, outcome = exitInternal, session.InternalFailure
				}
			}
		}
		log.terminal(false, false)
	}()

	publish := func() error {
		if err := host.PublishLeash(state, pump); err != nil {
			return err
		}
		return log.processState(state)
	}
	start := func() error {
		if parent.Err() != nil {
			return parent.Err()
		}
		snapshot := host.Authority.Inspect(time.Now())
		if snapshot.State == session.Expired || snapshot.State == session.Closed {
			return &protocol.ProtocolError{Code: protocol.CodeExpired}
		}
		pump = nil
		state.State, state.PID, state.StartedAt, state.ExitCode, state.Signal = "starting", nil, nil, nil, nil
		if err := publish(); err != nil {
			return err
		}
		var err error
		process, err = pty.Start(ctx, command)
		if err != nil {
			state.State = "failed"
			_ = publish()
			return err
		}
		pump, err = leash.NewPump(process, options.Leash.ScrollbackBytes, func(writeCtx context.Context, data []byte) error { return console.Write(writeCtx, string(data)) })
		if err != nil {
			return err
		}
		if state.Generation > 1 {
			markerCtx, finish := context.WithTimeout(ctx, 2*time.Second)
			err := pump.RestartMarker(markerCtx, state.Generation)
			finish()
			if err != nil {
				return err
			}
		}
		pid, started := uint64(process.PID()), time.Now().Unix()
		state.State, state.PID, state.StartedAt = "running", &pid, &started
		if err := publish(); err != nil {
			return err
		}
		pumpCtx, stop := context.WithCancel(ctx)
		pumpCancel = stop
		done := make(chan error, 1)
		pumpDone, childDone, ended, drained = done, process.Done(), false, false
		go func(active *leash.Pump) { done <- active.Run(pumpCtx) }(pump)
		return nil
	}
	startFailure := func(err error) (int, session.Outcome) {
		var launch *pty.StartError
		if errors.As(err, &launch) {
			return launch.ExitCode(), session.InternalFailure
		}
		if parent.Err() != nil {
			return exitExpired, session.LocalRevoke
		}
		if value, _ := protocol.ErrorCodeOf(err); value == protocol.CodeExpired {
			return exitExpired, session.TTLExpired
		}
		return exitInternal, session.InternalFailure
	}
	interrupt := func(raw bool) (bool, error) {
		if process == nil || ended {
			return true, nil
		}
		now := time.Now()
		if !lastInterrupt.IsZero() && now.Sub(lastInterrupt) <= 2*time.Second {
			if err := log.write(diagnosticRecord{Event: "warning", Message: "Second interrupt confirmed: closing TailMouse and the process group."}, true, false); err != nil {
				return false, err
			}
			return true, nil
		}
		if raw {
			if err := pump.Input(ctx, []byte{3}); err != nil {
				return false, err
			}
		} else {
			if err := process.Interrupt(ctx); err != nil {
				return false, err
			}
		}
		lastInterrupt = now
		return false, nil
	}
	revoke := func() (int, session.Outcome) {
		gracefulStop = true
		if ended {
			return childResult.ExitCode, session.LocalRevoke
		}
		return exitExpired, session.LocalRevoke // Cleanup supplies the child's result.
	}
	// Preserve each raw chunk atomically except at an owner-level Ctrl+C
	// boundary. Backpressure retains one chunk and pauses reads, not the owner.
	forwardLocal := func(data []byte) ([]byte, bool, error) {
		for len(data) > 0 {
			count := bytes.IndexByte(data, 3)
			if count < 0 {
				count = len(data)
			}
			if count > 0 {
				if options.Leash.LocalInput {
					if err := pump.Input(ctx, data[:count]); err != nil {
						if errors.Is(err, leash.ErrBackpressure) {
							return data, false, nil
						}
						return nil, false, err
					}
				}
				clear(data[:count])
				data = data[count:]
			}
			if len(data) > 0 {
				stop, err := interrupt(true)
				if errors.Is(err, leash.ErrBackpressure) {
					return data, false, nil
				}
				if err != nil || stop {
					clear(data)
					return nil, stop, err
				}
				data[0] = 0
				data = data[1:]
			}
		}
		return nil, false, nil
	}
	firstHello := host.FirstHello()
	if options.Leash.StartOn == "now" {
		if err := start(); err != nil {
			return startFailure(err)
		}
		firstHello = nil
	}
	for {
		localReady := local
		if len(pendingLocal) > 0 {
			localReady = nil
		}
		if ended && drained && state.State != "exited" {
			// Retention owns only bytes and the recorded result. Release the old
			// group/PTY now, not minutes later when its PID might be reused.
			if inputReader != nil {
				inputReader.Close()
				inputReader = nil
			}
			local, localResize = nil, nil
			clear(pendingLocal)
			pendingLocal = nil
			if retryInput != nil {
				retryInput.Stop()
				retryInput, retryInputTick = nil, nil
			}
			if resize != nil {
				resize.Stop()
				resize, resizeTick = nil, nil
			}
			if err := process.Close(ctx); err != nil {
				return exitInternal, session.InternalFailure
			}
			state.State, state.ExitCode = "exited", &childResult.ExitCode
			if childResult.Signal != 0 {
				name := leashSignalName(childResult.Signal)
				state.Signal = &name
			}
			if accessClosed {
				process, pump, pumpCancel = nil, nil, nil
				if err := console.Close(); err != nil {
					return exitInternal, session.InternalFailure
				}
				console = nil
				log.terminal(false, false)
				if err := log.processState(state); err != nil {
					return exitInternal, session.InternalFailure
				}
				return childResult.ExitCode, session.ModeComplete
			}
			if err := host.RetainLeash(state, pump); err != nil {
				return exitInternal, session.InternalFailure
			}
			process, pump, pumpCancel = nil, nil, nil
			if err := console.Close(); err != nil {
				return exitInternal, session.InternalFailure
			}
			console = nil
			log.terminal(false, false)
			if err := log.processState(state); err != nil {
				return exitInternal, session.InternalFailure
			}
			if options.Once {
				return childResult.ExitCode, session.ModeComplete
			}
			retention, retentionTick = leashRetentionTimer(options.Leash.PostExitHost, options.Leash.PostExitTTL)
		}
		select {
		case <-parent.Done():
			return revoke()
		case value := <-signals:
			switch {
			case value == os.Interrupt:
				stop, err := interrupt(false)
				if err != nil {
					return exitInternal, session.InternalFailure
				}
				if stop {
					return revoke()
				}
			case shutdownSignal(value):
				return revoke()
			case leashResizeSignal(value) && process != nil && !ended:
				if err := requestLocalResize(); err != nil {
					return exitInternal, session.InternalFailure
				}
			}
		case <-localResize:
			if err := requestLocalResize(); err != nil {
				return exitInternal, session.InternalFailure
			}
		case <-firstHello:
			firstHello = nil
			if process == nil {
				if err := start(); err != nil {
					return startFailure(err)
				}
			}
		case value := <-localReady:
			if value.err != nil && !errors.Is(value.err, io.EOF) && ctx.Err() == nil {
				clear(value.data)
				return exitInternal, session.InternalFailure
			}
			if errors.Is(value.err, io.EOF) {
				local = nil
			}
			if process == nil {
				for index, key := range value.data {
					if key == 3 {
						clear(value.data)
						return exitExpired, session.LocalRevoke
					}
					if (key == '\r' || key == '\n') && options.Leash.StartOn == "connect-or-enter" {
						if err := start(); err != nil {
							clear(value.data)
							return startFailure(err)
						}
						firstHello = nil
						clear(value.data[:index+1])
						value.data = value.data[index+1:]
						break
					}
				}
			}
			if process != nil && !ended {
				remaining, stop, err := forwardLocal(value.data)
				if err != nil {
					clear(value.data)
					return exitInternal, session.InternalFailure
				}
				if stop {
					return revoke()
				}
				if len(remaining) > 0 {
					pendingLocal = remaining
					if retryInput == nil {
						retryInput = time.NewTimer(10 * time.Millisecond)
					} else {
						retryInput.Reset(10 * time.Millisecond)
					}
					retryInputTick = retryInput.C
					continue
				}
			} else if process != nil {
				for _, key := range value.data {
					if key == 3 {
						clear(value.data)
						return childResult.ExitCode, session.LocalRevoke
					}
				}
			}
			clear(value.data)
		case <-retryInputTick:
			retryInputTick = nil
			if ended {
				clear(pendingLocal)
				pendingLocal = nil
				continue
			}
			remaining, stop, err := forwardLocal(pendingLocal)
			if err != nil {
				return exitInternal, session.InternalFailure
			}
			pendingLocal = remaining
			if stop {
				return revoke()
			}
			if len(pendingLocal) > 0 {
				retryInput.Reset(10 * time.Millisecond)
				retryInputTick = retryInput.C
			}
		case result := <-accessDone:
			waited, accessClosed = true, true
			accessDone = nil
			if process == nil {
				return outcomeCode(result), result
			}
			if result == session.LocalRevoke {
				return revoke()
			}
			if result != session.TTLExpired && result != session.GraceExpired {
				return outcomeCode(result), result
			}
			if ended && drained {
				return childResult.ExitCode, result
			}
			if options.Leash.KillOnExpire {
				if ended {
					return childResult.ExitCode, result
				}
				gracefulStop = true
				return exitExpired, result
			}
			// Only access-only expiry keeps the mode alive after transport closes.
			// Full exit uses the deferred application, mode, transport sequence.
			shutdown(result, nil)
		case <-host.Disconnected():
			if options.Leash.KillOnDisconnect && process != nil && !ended {
				if err := process.Terminate(ctx); err != nil {
					return exitInternal, session.InternalFailure
				}
			}
		case <-childDone:
			childDone, ended = nil, true
			var err error
			childResult, err = process.Wait(ctx)
			if err != nil {
				return exitInternal, session.InternalFailure
			}
			if !drained {
				drain = time.NewTimer(2 * time.Second)
				drainTick = drain.C
			}
		case err := <-pumpDone:
			pumpDone, drained = nil, true
			if drain != nil {
				drain.Stop()
				drainTick = nil
			}
			if err != nil {
				select {
				case <-process.Done():
					if !errors.Is(err, context.Canceled) && !errors.Is(err, os.ErrClosed) {
						return exitInternal, session.InternalFailure
					}
				default:
					return exitInternal, session.InternalFailure
				}
			}
		case <-drainTick:
			drainTick = nil
			pumpCancel()
			clear(pendingLocal)
			pendingLocal = nil
			if retryInput != nil {
				retryInput.Stop()
				retryInputTick = nil
			}
			if err := process.Close(ctx); err != nil {
				return exitInternal, session.InternalFailure
			}
		case <-retentionTick:
			_, _ = host.Authority.Finish(session.ModeComplete)
			return childResult.ExitCode, session.ModeComplete
		case <-host.LeashSizes():
			if size, ok := host.TakeLeashSize(); ok {
				latestSize = size
				if resize == nil {
					resize = time.NewTimer(time.Until(size.At.Add(50 * time.Millisecond)))
				} else {
					resize.Reset(time.Until(size.At.Add(50 * time.Millisecond)))
				}
				resizeTick = resize.C
			}
		case <-resizeTick:
			resizeTick = nil
			if process != nil && !ended && host.AcceptLeashSize(latestSize) {
				if err := process.Resize(ctx, int(latestSize.Columns), int(latestSize.Rows)); err != nil {
					return exitInternal, session.InternalFailure
				}
				host.AppliedLeashSize(latestSize)
			}
		case <-host.LeashControls():
			request, ok := host.TakeLeashControl()
			if !ok || process == nil && request.Action != "restart" {
				continue
			}
			if request.Action == "interrupt" {
				if err := process.Interrupt(ctx); err != nil {
					return exitInternal, session.InternalFailure
				}
				state.State = "interrupting"
				if err := publish(); err != nil {
					return exitInternal, session.InternalFailure
				}
				state.State = "running"
				if err := publish(); err != nil {
					return exitInternal, session.InternalFailure
				}
				continue
			}
			if !ended && process != nil {
				if err := process.Terminate(ctx); err != nil {
					return exitInternal, session.InternalFailure
				}
			}
			if request.Action == "terminate" {
				continue
			}
			if inputReader != nil {
				inputReader.Close()
				inputReader = nil
			}
			if pumpCancel != nil {
				pumpCancel()
			}
			clear(pendingLocal)
			pendingLocal = nil
			if retryInput != nil {
				retryInput.Stop()
				retryInputTick = nil
			}
			if process != nil {
				if err := process.Close(ctx); err != nil {
					return exitInternal, session.InternalFailure
				}
			}
			if pumpDone != nil {
				<-pumpDone
				pumpDone = nil
			}
			if retention != nil {
				retention.Stop()
				retentionTick = nil
			}
			if drain != nil {
				drain.Stop()
				drainTick = nil
			}
			if state.Generation == ^uint32(0) {
				return exitInternal, session.InternalFailure
			}
			state.Generation++
			if console == nil {
				console, err = openLeashConsole(input, file)
				if err != nil {
					return config.ExitPTY, session.InternalFailure
				}
				log.terminal(console.state != nil, false)
			}
			if err := start(); err != nil {
				return startFailure(err)
			}
			inputReader = readLeashInput(ctx, console)
			local, localResize = inputReader.values, leashResizeEvents(console)
		}
	}
}

func leashRetentionTimer(host bool, duration time.Duration) (*time.Timer, <-chan time.Time) {
	if host {
		return nil, nil
	}
	timer := time.NewTimer(duration)
	return timer, timer.C
}

func outcomeCode(outcome session.Outcome) int {
	switch outcome {
	case session.ProtocolFailure:
		return exitProtocol
	case session.TransportFailure:
		return exitTransport
	case session.InternalFailure:
		return exitInternal
	case session.ModeComplete:
		return exitOK
	default:
		return exitExpired
	}
}
