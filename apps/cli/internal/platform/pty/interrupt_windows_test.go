//go:build windows

package pty

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

func conPTYInterruptChild(mode string) {
	raw := strings.Contains(mode, "raw")
	if raw {
		input, err := windows.GetStdHandle(windows.STD_INPUT_HANDLE)
		var settings uint32
		if err != nil || windows.GetConsoleMode(input, &settings) != nil || windows.SetConsoleMode(input, settings&^(windows.ENABLE_PROCESSED_INPUT|windows.ENABLE_LINE_INPUT|windows.ENABLE_ECHO_INPUT)) != nil {
			os.Exit(125)
		}
	}
	set := windows.NewLazySystemDLL("kernel32.dll").NewProc("SetConsoleCtrlHandler")
	if err := set.Find(); err != nil {
		os.Exit(125)
	}
	handler := windows.NewCallback(func(event uint32) uintptr {
		if event == windows.CTRL_C_EVENT {
			windows.ExitProcess(31)
		}
		if event != windows.CTRL_BREAK_EVENT {
			return 0
		}
		if os.WriteFile("break.received", []byte("received"), 0o600) != nil {
			windows.ExitProcess(125)
		}
		if strings.Contains(mode, "ignore") {
			return 1
		}
		windows.ExitProcess(32)
		return 1
	})
	if ok, _, _ := set.Call(handler, 1); ok == 0 {
		os.Exit(125)
	}
	if _, err := fmt.Fprint(os.Stdout, "ready\r\n"); err != nil {
		os.Exit(125)
	}
	if raw {
		var data [1]byte
		if count, err := os.Stdin.Read(data[:]); err == nil && count == 1 && data[0] == 3 {
			if os.WriteFile("raw-control-c.received", []byte("received"), 0o600) != nil {
				os.Exit(125)
			}
		}
	}
	<-time.After(14 * time.Second)
}

func conPTYMarker(t *testing.T, ctx context.Context, directory, name string) {
	t.Helper()
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	for {
		data, err := os.ReadFile(filepath.Join(directory, name))
		if err == nil && string(data) == "received" {
			return
		}
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			t.Fatal(err)
		}
		select {
		case <-ticker.C:
		case <-ctx.Done():
			t.Fatal("native child did not acknowledge its control event", ctx.Err())
		}
	}
}

func TestConPTYInterruptDeliversNativeBreakWithProcessedInputDisabled(t *testing.T) {
	for _, mode := range []string{"interrupt-processed", "interrupt-raw", "interrupt-raw-ignore"} {
		t.Run(mode, func(t *testing.T) {
			command := conPTYCommand(t, mode)
			process := startConPTY(t, command)
			conPTYReady(t, process)
			drain := conPTYDrainWorker(t, process)
			ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
			defer cancel()
			if err := process.Interrupt(ctx); err != nil {
				t.Fatal(err)
			}
			conPTYMarker(t, ctx, command.Cwd(), "break.received")
			if strings.Contains(mode, "ignore") {
				observation, stop := context.WithTimeout(ctx, 100*time.Millisecond)
				_, err := process.Wait(observation)
				stop()
				if !errors.Is(err, context.DeadlineExceeded) {
					t.Fatal("interrupt terminated a child that handled and ignored it", err)
				}
				if err := process.Terminate(ctx); err != nil {
					t.Fatal(err)
				}
			} else if result, err := process.Wait(ctx); err != nil || result.ExitCode != 32 {
				t.Fatal("explicit interrupt did not deliver CTRL_BREAK_EVENT", err)
			}
			if err := process.Close(ctx); err != nil {
				t.Fatal(err)
			}
			if err := process.Interrupt(ctx); !errors.Is(err, os.ErrClosed) {
				t.Fatal("interrupt reused a released generation", err)
			}
			select {
			case err := <-drain:
				if err != nil {
					t.Fatal(err)
				}
			case <-ctx.Done():
				t.Fatal("output worker survived control cleanup")
			}
		})
	}
}

func TestConPTYLocalControlCPreservesProcessedAndRawSemantics(t *testing.T) {
	for _, raw := range []bool{false, true} {
		t.Run(fmt.Sprintf("raw=%t", raw), func(t *testing.T) {
			mode := "interrupt-processed"
			if raw {
				mode = "interrupt-raw"
			}
			command := conPTYCommand(t, mode)
			process := startConPTY(t, command)
			conPTYReady(t, process)
			ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
			defer cancel()
			if err := process.Write(ctx, []byte{3}); err != nil {
				t.Fatal(err)
			}
			want := 31
			if raw {
				conPTYMarker(t, ctx, command.Cwd(), "raw-control-c.received")
				want = 32
				if err := process.Interrupt(ctx); err != nil {
					t.Fatal(err)
				}
			}
			drainConPTY(t, ctx, process)
			if result, err := process.Wait(ctx); err != nil || result.ExitCode != want {
				t.Fatal("local Ctrl+C was coerced into the wrong native event", err)
			}
		})
	}
}

func TestConPTYInterruptAdmissionIsBoundedAndCannotSplitAWrite(t *testing.T) {
	host, peer := testConsolePipe(t, false)
	ioCtx, ioCancel := context.WithCancel(t.Context())
	defer ioCancel()
	process := &Process{input: host, ioCtx: ioCtx, ioCancel: ioCancel, writeGate: make(chan struct{}, 1), released: make(chan struct{})}
	result := make(chan error, 1)
	finished := make(chan struct{})
	go func() {
		defer close(finished)
		// Exceed the private pipe's capacity to exercise a pending native
		// write, not a synthetic lock. The peer deliberately consumes nothing.
		result <- process.Write(t.Context(), bytes.Repeat([]byte{'x'}, 4<<20))
	}()
	t.Cleanup(func() {
		ioCancel()
		select {
		case <-finished:
		case <-time.After(3 * time.Second):
			t.Error("native channel writer survived cancellation")
		}
	})
	peek := windows.NewLazySystemDLL("kernel32.dll").NewProc("PeekNamedPipe")
	if err := peek.Find(); err != nil {
		t.Fatal(err)
	}
	ready, stop := context.WithTimeout(t.Context(), 2*time.Second)
	defer stop()
	for {
		var available uint32
		if ok, _, err := peek.Call(uintptr(peer), 0, 0, 0, uintptr(unsafe.Pointer(&available)), 0); ok == 0 {
			t.Fatal(err)
		}
		if available > 0 {
			break
		}
		select {
		case <-ready.Done():
			t.Fatal("fixture did not start the native write")
		case <-finished:
			t.Fatal("fixture write did not block")
		case <-time.After(10 * time.Millisecond):
		}
	}
	queued, cancel := context.WithTimeout(t.Context(), 20*time.Millisecond)
	err := process.Write(queued, []byte("must-not-enter"))
	cancel()
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatal("queued writer ignored cancellation", err)
	}
	start := time.Now()
	if err := process.Interrupt(t.Context()); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatal("blocked control admission did not report its deadline", err)
	}
	if elapsed := time.Since(start); elapsed < 1900*time.Millisecond || elapsed > 3*time.Second {
		t.Fatalf("control delivery escaped its two-second budget: %s", elapsed)
	}
	ioCancel()
	select {
	case err := <-result:
		if !errors.Is(err, os.ErrClosed) {
			t.Fatal("active writer did not stop on final I/O cancellation", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("active writer survived cancellation")
	}
	if err := process.Write(t.Context(), []byte("late")); !errors.Is(err, os.ErrClosed) {
		t.Fatal("writer admission survived final cancellation", err)
	}
	if err := host.Close(); err != nil {
		t.Fatal(err)
	}
	var data [32 << 10]byte
	for total := 0; ; {
		var count uint32
		err := windows.ReadFile(peer, data[:], &count, nil)
		total += int(count)
		if total > 4<<20 || bytes.IndexFunc(data[:count], func(r rune) bool { return r != 'x' }) >= 0 {
			t.Fatal("a canceled input or control sequence split the active write")
		}
		if errors.Is(err, windows.ERROR_BROKEN_PIPE) {
			break
		}
		if err != nil || count == 0 {
			t.Fatal("fixture channel did not reach its bounded EOF", err)
		}
	}
}
