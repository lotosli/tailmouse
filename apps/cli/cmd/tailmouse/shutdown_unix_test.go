//go:build darwin || linux

package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"os"
	"reflect"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"golang.org/x/sys/unix"
	"golang.org/x/term"
	tailcattransport "tailmouse/apps/cli/internal/transport/tailcat"
)

// Only the first application-stream close observes the owned child's lifetime.
// No process other than the PID published by this fixture is inspected.
type shutdownObservedStream struct {
	tailcattransport.ByteStream
	once    sync.Once
	onClose func()
}

func (stream *shutdownObservedStream) Close() error {
	stream.once.Do(stream.onClose)
	return stream.ByteStream.Close()
}

type shutdownRunningFault struct {
	onRunning func(uint64)
	panic     bool
}

func (fault shutdownRunningFault) Write(data []byte) (int, error) {
	var record diagnosticRecord
	if err := json.Unmarshal(data, &record); err != nil {
		return 0, errors.New("invalid synthetic diagnostic record")
	}
	if record.Event == "process_state" && record.State == "running" {
		if record.PID == nil || *record.PID == 0 || *record.PID > 1<<31-1 {
			return 0, errors.New("invalid owned fixture PID")
		}
		fault.onRunning(*record.PID)
		if fault.panic {
			panic("synthetic running diagnostic failure")
		}
		return 0, errors.New("synthetic running diagnostic failure")
	}
	return len(data), nil
}

func TestLeashShutdownClosesStreamBeforeChildAndTransportBeforeConsole(t *testing.T) {
	for _, panicAtRunning := range []bool{false, true} {
		t.Run(map[bool]string{false: "error", true: "panic"}[panicAtRunning], func(t *testing.T) {
			_, slave, fd, initial, flags := terminalPair(t)
			fake := newFakeTransport()
			fake.closeErr = errors.New("later synthetic transport failure")
			var childPID atomic.Int64
			var closedWhileChildAlive atomic.Bool
			var applicationClosed atomic.Bool
			var childGoneBeforeTransport, rawAtTransportClose bool
			fake.onClose = func() {
				childGoneBeforeTransport = applicationClosed.Load() && childPID.Load() > 0 &&
					errors.Is(syscall.Kill(int(childPID.Load()), 0), syscall.ESRCH)
				raw, err := term.GetState(fd)
				rawAtTransportClose = err == nil && !reflect.DeepEqual(raw, initial)
			}
			var browser net.Conn
			defer func() {
				if browser != nil {
					_ = browser.Close()
				}
			}()
			fault := shutdownRunningFault{panic: panicAtRunning, onRunning: func(pid uint64) {
				childPID.Store(int64(pid))
				var stream net.Conn
				stream, browser = net.Pipe()
				// A pending HELLO holds a real application connection without
				// advancing authority or requiring another protocol worker here.
				fake.config.OnConnection(&shutdownObservedStream{ByteStream: stream, onClose: func() {
					closedWhileChildAlive.Store(syscall.Kill(int(childPID.Load()), 0) == nil)
					applicationClosed.Store(true)
				}})
			}}
			binary, err := os.Executable()
			if err != nil {
				t.Fatal(err)
			}
			environment := []string{"TAILMOUSE_LEASH_CLI_CHILD=wait"}
			if directory := os.Getenv("GOCOVERDIR"); directory != "" {
				environment = append(environment, "GOCOVERDIR="+directory)
			}
			ctx, cancel := context.WithTimeout(t.Context(), 8*time.Second)
			defer cancel()
			code := run(ctx, slave, []string{"leash", "--no-qr", "--json", "--start-on=now", "--", binary, "-test.run=^TestLeashCLIChild$"},
				environment, t.TempDir(), slave, fault, fake.start)
			assertTerminalRestored(t, fd, initial, flags)
			if code != exitInternal || fake.closeCalls != 1 || !closedWhileChildAlive.Load() || !childGoneBeforeTransport || !rawAtTransportClose {
				t.Fatalf("ordered shutdown failed: code=%d, close count=%d, stream-before-child=%t, child-before-transport=%t, transport-before-restore=%t",
					code, fake.closeCalls, closedWhileChildAlive.Load(), childGoneBeforeTransport, rawAtTransportClose)
			}
		})
	}
}

func TestLeashOwnerShutdownClosesApplicationBeforeGracefulTermination(t *testing.T) {
	for _, test := range []struct {
		name, mode string
		code       int
		expire     bool
	}{
		{"graceful", "ignore-interrupt", 143, false},
		{"forced", "ignore", 137, false},
		{"expire", "ignore-interrupt", 143, true},
	} {
		t.Run(test.name, func(t *testing.T) {
			flags := []string{"--start-on=connect"}
			if test.expire {
				flags = append(flags, "--ttl=1s", "--kill-on-expire")
			}
			fixture := startLeashCLI(t, test.mode, flags...)
			accept := fixture.transport.config.OnConnection
			var childPID atomic.Int64
			var closedWhileAlive atomic.Bool
			var transportAfterChild atomic.Bool
			fixture.transport.mu.Lock()
			fixture.transport.onClose = func() {
				transportAfterChild.Store(childPID.Load() > 0 && errors.Is(syscall.Kill(int(childPID.Load()), 0), syscall.ESRCH))
			}
			fixture.transport.mu.Unlock()
			fixture.transport.config.OnConnection = func(stream tailcattransport.ByteStream) {
				accept(&shutdownObservedStream{ByteStream: stream, onClose: func() {
					pid := childPID.Load()
					closedWhileAlive.Store(pid > 0 && syscall.Kill(int(pid), 0) == nil)
				}})
			}
			browser := fixture.connect(t)
			state := waitLeashRunning(t, fixture, browser, 1)
			if state.PID == nil {
				t.Fatal("owned child PID is missing")
			}
			childPID.Store(int64(*state.PID))
			fixture.awaitText(t, "child-ready") // Signal handlers are now installed.
			if !test.expire {
				fixture.signals <- os.Interrupt
				fixture.signals <- os.Interrupt
			}
			closeLeashBrowser(t, fixture, browser)
			fixture.result(t, test.code)
			if !closedWhileAlive.Load() || !transportAfterChild.Load() {
				t.Fatalf("owner shutdown ordering failed: application-before-child=%t, child-before-transport=%t", closedWhileAlive.Load(), transportAfterChild.Load())
			}
		})
	}
}

func TestLeashTransportFailurePrecedesLaterTerminalRestorationFailure(t *testing.T) {
	_, slave, fd, initial, _ := terminalPair(t)
	duplicate, err := unix.Dup(fd)
	if err != nil {
		t.Fatal(err)
	}
	input := os.NewFile(uintptr(duplicate), "owned-shutdown-input")
	t.Cleanup(func() {
		_ = input.Close()
		// The fault deliberately removes only this test's restoration handle.
		// Its other owned descriptor restores the private PTY for cleanup.
		if err := term.Restore(fd, initial); err != nil {
			t.Error(err)
		}
	})
	fake := newFakeTransport()
	fake.closeErr = errors.New("synthetic transport root")
	var closeErr error
	fake.onClose = func() { closeErr = input.Close() }
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	code := run(ctx, input, []string{"leash", "--no-qr", "--start-on=now", "--post-exit-ttl=30ms", "--", "/bin/sh", "-c", "exit 37"},
		nil, t.TempDir(), slave, io.Discard, fake.start)
	if code != exitTransport || closeErr != nil || fake.closeCalls != 1 {
		t.Fatalf("later console failure replaced transport root: code=%d, close count=%d, injected=%t", code, fake.closeCalls, closeErr == nil)
	}
	if after, err := term.GetState(fd); err != nil || reflect.DeepEqual(after, initial) {
		t.Fatal("test did not exercise failed terminal restoration")
	}
}

func TestLeashApplicationCloseFailurePrecedesLaterTerminalRestorationFailure(t *testing.T) {
	master, _, fd, initial, _ := terminalPair(t)
	duplicate, err := unix.Dup(fd)
	if err != nil {
		t.Fatal(err)
	}
	input := os.NewFile(uintptr(duplicate), "owned-application-close-input")
	fixture := startLeashCLIWithInput(t, "exit", input, master, io.Discard, "--start-on=connect")
	t.Cleanup(func() {
		if err := term.Restore(fd, initial); err != nil {
			t.Error(err)
		}
	})
	var closeErr error
	fixture.transport.mu.Lock()
	fixture.transport.onClose = func() { closeErr = input.Close() }
	fixture.transport.mu.Unlock()
	_ = fixture.connect(t)
	// This owned peer deliberately never consumes terminal frames or CLOSE.
	// Application closure must fail at its existing bound and force-join it.
	fixture.result(t, exitTransport)
	if closeErr != nil {
		t.Fatal("terminal restoration fault was not injected")
	}
	if after, err := term.GetState(fd); err != nil || reflect.DeepEqual(after, initial) {
		t.Fatal("test did not exercise the later restoration failure")
	}
}

func TestLeashNormalExitClosesTransportBeforeConsole(t *testing.T) {
	_, slave, fd, initial, flags := terminalPair(t)
	fake := newFakeTransport()
	closedWhileRaw := false
	fake.onClose = func() {
		raw, err := term.GetState(fd)
		closedWhileRaw = err == nil && !reflect.DeepEqual(raw, initial)
	}
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	code := run(ctx, slave, []string{"leash", "--no-qr", "--start-on=now", "--post-exit-ttl=30ms", "--", "/bin/sh", "-c", "exit 37"},
		nil, t.TempDir(), slave, io.Discard, fake.start)
	assertTerminalRestored(t, fd, initial, flags)
	if code != 37 || fake.closeCalls != 1 || !closedWhileRaw {
		t.Fatalf("normal exit ordering failed: code=%d, close count=%d, transport-before-restore=%t", code, fake.closeCalls, closedWhileRaw)
	}
}
