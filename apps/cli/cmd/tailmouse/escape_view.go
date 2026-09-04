package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"math"
	"strings"
	"time"

	"tailmouse/apps/cli/internal/config"
	"tailmouse/apps/cli/internal/escape"
	"tailmouse/apps/cli/internal/protocol"
	"tailmouse/apps/cli/internal/session"
)

const spectatorInterval = time.Second / 20

type escapeDisplay struct {
	width, height               int
	showNet, debug, interactive bool
	notice                      string
}

func displayScent(view session.EscapeView, metrics session.Metrics) (points [escape.ScentCapacity]escape.ScentPoint, count int) {
	window := 2 * time.Duration(max(40, min(250, metrics.RTTMS))*float64(time.Millisecond))
	variation := time.Duration(max(0, min(25, metrics.JitterMS/2)) * float64(time.Millisecond))
	previous := view.State.Elapsed
	for index := view.ScentCount - 1; index >= 0; index-- {
		point := view.Scent[index]
		if point.At < view.State.Elapsed-window {
			break
		}
		gap := 50*time.Millisecond + variation
		if count%2 == 1 {
			gap = 50*time.Millisecond - variation
		}
		if point.At <= view.State.Elapsed && previous-point.At >= gap {
			points[count] = point
			count++
			previous = point.At
		}
	}
	return points, count
}

func escapeResultText(result protocol.GameResult) (string, error) {
	if _, err := protocol.GameResultFrame(result); err != nil {
		return "", err
	}
	heading := map[string]string{"escaped": "THE MOUSE ESCAPED", "caught": "THE CAT WON", "timeout": "TIME RAN OUT", "connection_lost": "CONNECTION LOST"}[result.Outcome]
	var text strings.Builder
	fmt.Fprintf(&text, "%s\n\nTime          %.1fs\nRTT p50       %.0fms\nRTT p95       %.0fms\n", heading, result.ElapsedMS/1000, result.RTTP50MS, result.RTTP95MS)
	if result.JitterMS != nil {
		fmt.Fprintf(&text, "Jitter        %.0fms\n", *result.JitterMS)
	}
	fmt.Fprintf(&text, "Relay         %s\n\n%s\n", result.Relay, result.Message)
	return text.String(), nil
}

func escapeScreen(view session.EscapeView, metrics session.Metrics, display escapeDisplay) (string, error) {
	var lines []string
	if view.Result.Outcome != "" {
		text, err := escapeResultText(view.Result)
		if err != nil {
			return "", err
		}
		lines = strings.Split(strings.TrimSuffix(text, "\n"), "\n")
		if view.RestartPending {
			lines = append(lines, "Restart requested; waiting for browser.")
		}
	} else {
		phase := string(view.State.Phase)
		if view.State.Paused {
			phase = "connection lost; paused"
		}
		lines = append(lines, fmt.Sprintf("TAILMOUSE ESCAPE | Round %d | %s", view.Round, phase))
		if display.showNet {
			lines = append(lines, "DERP: "+view.Relay)
		} else {
			lines = append(lines, "Host-authoritative game")
		}
		remaining := int((view.State.Remaining + time.Second - 1) / time.Second)
		clock := fmt.Sprintf("Time %02d:%02d", remaining/60, remaining%60)
		if view.State.Phase == escape.CountingDown {
			clock += fmt.Sprintf("  Get ready: %d", (view.State.CountdownRemaining+time.Second-1)/time.Second)
		}
		if display.showNet {
			network := "RTT --  Jitter --"
			if metrics.Samples > 0 {
				network = fmt.Sprintf("RTT %.0fms  Jitter %.0fms", metrics.RTTMS, metrics.JitterMS)
			}
			clock = network + "  " + clock
		}
		lines = append(lines, clock)
		if display.width < 48 || display.height < 24 {
			lines = append(lines, "Map needs a 48x24 terminal; resize to view.")
		} else {
			var cells [escape.MapHeight][escape.MapWidth]byte
			for y, row := range view.Map.Rows {
				for x := range escape.MapWidth {
					cells[y][x] = ' '
					if row[x] == '#' {
						cells[y][x] = '#'
					}
				}
			}
			plot := func(point escape.Point, value byte) {
				x, y := int(math.Floor(float64(point.X))), int(math.Floor(float64(point.Y)))
				if view.Map.Walkable(x, y) {
					cells[y][x] = value
				}
			}
			visibleScent, count := displayScent(view, metrics)
			for _, scent := range visibleScent[:count] {
				plot(scent.Position, '.')
			}
			for index, point := range view.Map.Cheese {
				if !view.State.Cheese[index] {
					plot(point, '*')
				}
			}
			exit := byte('x')
			if view.State.ExitOpen() {
				exit = 'O'
			}
			plot(view.Map.Exit, exit)
			plot(view.State.Cat, 'C')
			plot(view.State.Mouse, 'M')
			for _, row := range cells {
				lines = append(lines, string(row[:]))
			}
		}
		cheese := 0
		for _, collected := range view.State.Cheese {
			if collected {
				cheese++
			}
		}
		dash := "READY"
		if view.State.DashCooldown > 0 {
			dash = fmt.Sprintf("%.1fs", view.State.DashCooldown.Seconds())
		}
		status := fmt.Sprintf("Cheese %d/2  Dash %s", cheese, dash)
		if display.showNet {
			status += fmt.Sprintf("  Queue %d  Squeaks %.0f/s", view.Queue+view.State.PendingDash, metrics.EscapeInputRate)
		}
		lines = append(lines, status)
	}
	keys := "Ctrl+C exit | interactive keys unavailable"
	if display.interactive {
		keys = "q/Ctrl+C exit | d debug"
		if view.CanRestart {
			keys += " | r restart"
		}
	}
	lines = append(lines, keys)
	if display.notice != "" {
		lines = append(lines, display.notice)
	} else if display.debug {
		debug := fmt.Sprintf("Tick %d  Input %d  Scent %d  Cat %.2f", view.State.Tick, view.State.AcceptedSequence, view.ScentCount, view.State.CatSpeed)
		if display.showNet {
			debug += fmt.Sprintf("  Snap/s %.1f  TX/RX %d/%d", metrics.EscapeSnapshotRate, metrics.BytesTX, metrics.BytesRX)
		}
		lines = append(lines, debug)
	} else if view.Result.Outcome == "" {
		lines = append(lines, "M mouse | C cat | * cheese | O exit | . scent")
	}
	width, height := max(1, min(500, display.width)), max(1, min(200, display.height))
	if len(lines) > height {
		lines = lines[:height]
	}
	for index, line := range lines {
		if len(line) > width {
			lines[index] = line[:max(0, width-1)] + ">"
		}
	}
	return "\x1b[H" + strings.Join(lines, "\r\n") + "\x1b[J", nil
}

// watchEscape is the one CLI presentation loop. The host keeps its existing
// independent ticker; no terminal read/write or frame queue holds the game lock.
func watchEscape(ctx context.Context, host *session.Host, options config.Options, stdout io.Writer, log *diagnostics, console escapeConsole, interactive bool, shutdown func(session.Outcome, func() session.Outcome)) (outcome session.Outcome, failure error) {
	ctx, cancel := context.WithCancel(ctx)
	done := make(chan session.Outcome, 1)
	go func() { done <- host.Wait(ctx) }()
	keys := make(chan byte, 16)
	inputDone := make(chan struct{})
	inputFailure := make(chan error, 1)
	go func() {
		defer close(inputDone)
		defer close(keys)
		defer func() {
			if recover() != nil {
				inputFailure <- errors.New("terminal input failed")
				_, _ = host.Authority.Finish(session.InternalFailure)
				cancel()
			}
		}()
		if console == nil {
			return
		}
		for {
			key, err := console.ReadKey(ctx)
			if err != nil {
				if !errors.Is(err, io.EOF) && ctx.Err() == nil {
					inputFailure <- err
					_, _ = host.Authority.Finish(session.InternalFailure)
					cancel()
				}
				return
			}
			if key == 'q' || key == 3 {
				cancel()
				return
			}
			if key != 'r' && key != 'd' {
				continue
			}
			select {
			case keys <- key:
			case <-ctx.Done():
				return
			default:
				inputFailure <- errors.New("terminal key queue is full")
				_, _ = host.Authority.Finish(session.InternalFailure)
				cancel()
				return
			}
		}
	}()
	waited, alternate := false, false
	var lastResult protocol.GameResult
	var resultRound uint64
	writeConsole := func(parent context.Context, value string) (err error) {
		defer func() {
			if recover() != nil {
				err = errors.New("terminal output failed")
			}
		}()
		writeContext, stop := context.WithTimeout(parent, time.Second)
		defer stop()
		return console.Write(writeContext, value)
	}
	defer func() {
		if recover() != nil {
			failure = errors.New("terminal presentation failed")
			_, _ = host.Authority.Finish(session.InternalFailure)
		}
		cancel()
		if !waited {
			outcome = <-done
		}
		if failure != nil && outcome == session.ModeComplete {
			outcome = session.InternalFailure
		}
		shutdown(outcome, func() session.Outcome {
			<-inputDone
			select {
			case err := <-inputFailure:
				failure = errors.Join(failure, err)
			default:
			}
			if failure != nil && outcome == session.ModeComplete {
				outcome = session.InternalFailure
			}
			return outcome
		})
		if alternate {
			err := writeConsole(context.Background(), "\x1b[?25h\x1b[?1049l")
			if err == nil && lastResult.Outcome != "" {
				var text string
				text, err = escapeResultText(lastResult)
				if err == nil {
					err = writeConsole(context.Background(), strings.ReplaceAll(text, "\n", "\r\n"))
				}
			}
			failure = errors.Join(failure, err)
		}
		if console != nil {
			failure = errors.Join(failure, console.Close())
		}
		log.terminal(false, false)
		if failure != nil && outcome == session.ModeComplete {
			outcome = session.InternalFailure
		}
	}()
	log.terminal(interactive, false)
	ticker := time.NewTicker(spectatorInterval)
	defer ticker.Stop()
	display := escapeDisplay{showNet: options.Escape.ShowNet, interactive: interactive}
	fail := func(err error) { failure = err; _, _ = host.Authority.Finish(session.InternalFailure); cancel() }
	refresh := func() error {
		if ctx.Err() != nil {
			return nil
		}
		view := host.InspectEscapeView()
		if view.Result.Outcome == "" {
			lastResult = protocol.GameResult{}
		}
		if !view.Started {
			if alternate {
				return writeConsole(ctx, "\x1b[HWaiting for browser to start the next round.\r\nq/Ctrl+C exit\x1b[J")
			}
			return nil
		}
		if view.Result.Outcome != "" && resultRound != view.Round {
			lastResult, resultRound = view.Result, view.Round
			if err := log.gameResult(view.Result); err != nil {
				return err
			}
			if !alternate {
				text, err := escapeResultText(view.Result)
				if err != nil {
					return err
				}
				if console != nil {
					width, _, err := console.Size()
					if err != nil {
						return err
					}
					if width > 0 {
						return writeConsole(ctx, strings.ReplaceAll(text, "\n", "\r\n"))
					}
				}
				count, err := io.WriteString(stdout, text)
				if err == nil && count != len(text) {
					err = io.ErrShortWrite
				}
				if err != nil {
					return err
				}
			}
		}
		if console == nil || !options.Escape.TerminalRender {
			return nil
		}
		var err error
		display.width, display.height, err = console.Size()
		if err != nil {
			return err
		}
		if display.width == 0 {
			return nil
		}
		if !alternate {
			alternate = true
			if err := writeConsole(ctx, "\x1b[?1049h\x1b[?25l"); err != nil {
				return err
			}
			log.terminal(interactive, true)
		}
		screen, err := escapeScreen(view, host.InspectMetrics(), display)
		if err != nil {
			return err
		}
		return writeConsole(ctx, screen)
	}
	for {
		select {
		case outcome = <-done:
			waited = true
			if err := refresh(); err != nil {
				failure = err
			}
			return outcome, failure
		case <-ctx.Done():
			return outcome, failure
		case key, ok := <-keys:
			if !ok {
				keys = nil
				display.interactive = false
				continue
			}
			display.notice = ""
			if key == 'd' {
				display.debug = !display.debug
			} else if err := host.RestartEscape(); err != nil {
				if !errors.Is(err, session.ErrInvalidTransition) {
					fail(err)
					return outcome, failure
				}
				display.notice = "Restart needs a finished round and --once=false."
			}
		case <-ticker.C:
			if err := refresh(); err != nil {
				fail(err)
				return outcome, failure
			}
		}
	}
}
