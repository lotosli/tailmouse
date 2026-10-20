//go:build darwin || linux

package main

import (
	"context"
	"errors"
	"io"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/creack/pty"
	"golang.org/x/sys/unix"
	"golang.org/x/term"
)

func terminalPair(t *testing.T) (*os.File, *os.File, int, *term.State, int) {
	t.Helper()
	master, slave, err := pty.Open()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = slave.Close(); _ = master.Close() })
	if err := pty.Setsize(slave, &pty.Winsize{Cols: 100, Rows: 24}); err != nil {
		t.Fatal(err)
	}
	fd := int(slave.Fd())
	state, err := term.GetState(fd)
	if err != nil {
		t.Fatal(err)
	}
	flags, err := unix.FcntlInt(uintptr(fd), unix.F_GETFL, 0)
	if err != nil {
		t.Fatal(err)
	}
	return master, slave, fd, state, flags
}

func assertTerminalRestored(t *testing.T, fd int, state *term.State, flags int) {
	t.Helper()
	after, err := term.GetState(fd)
	if err != nil || !reflect.DeepEqual(after, state) {
		t.Fatalf("terminal mode was not restored: %v", err)
	}
	current, err := unix.FcntlInt(uintptr(fd), unix.F_GETFL, 0)
	// F_GETFL can also expose kernel bookkeeping such as Darwin's FWASWRITTEN.
	// Compare public I/O modes, not the kernel's irreversible write-history bit.
	const modes = unix.O_ACCMODE | unix.O_NONBLOCK | unix.O_APPEND | unix.O_ASYNC | unix.O_SYNC
	if err != nil || current&modes != flags&modes {
		t.Fatalf("terminal descriptor flags = %#x, want %#x: %v", current, flags, err)
	}
}

func TestNativeConsoleKeysOutputSizeAndRestore(t *testing.T) {
	master, slave, fd, state, flags := terminalPair(t)
	console, interactive, err := openStartupConsole(slave, slave)
	if err != nil || !interactive || console == nil {
		t.Fatalf("terminal open failed: %v", err)
	}
	defer console.Close()
	raw, err := term.GetState(fd)
	if err != nil || reflect.DeepEqual(raw, state) {
		t.Fatal("terminal did not enter raw mode")
	}
	width, height, err := console.Size()
	if err != nil || width != 100 || height != 24 {
		t.Fatalf("terminal size = %dx%d: %v", width, height, err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	for _, want := range []byte{'d', 'r', 'q', 3} {
		if _, err := master.Write([]byte{want}); err != nil {
			t.Fatal(err)
		}
		key, err := console.ReadKey(ctx)
		if err != nil || key != want {
			t.Fatalf("raw key = %d, want %d: %v", key, want, err)
		}
	}
	text := "\x1b[HMouse\r\nCat"
	if err := console.Write(ctx, text); err != nil {
		t.Fatal(err)
	}
	masterFD := int(master.Fd())
	data := make([]byte, len(text))
	for offset := 0; offset < len(data); {
		if err := pollConsole(ctx, masterFD, unix.POLLIN); err != nil {
			t.Fatal(err)
		}
		count, err := unix.Read(masterFD, data[offset:])
		if err != nil || count == 0 {
			t.Fatalf("terminal read failed: %v", err)
		}
		offset += count
	}
	if string(data) != text {
		t.Fatal("raw output was transformed or input was echoed")
	}
	if err := console.Close(); err != nil {
		t.Fatal(err)
	}
	assertTerminalRestored(t, fd, state, flags)
	if err := console.Close(); err != nil {
		t.Fatal("second restoration failed")
	}
}

func TestNativeConsoleCancellationAndBackpressure(t *testing.T) {
	for _, operation := range []string{"read", "write"} {
		t.Run(operation, func(t *testing.T) {
			_, slave, fd, state, flags := terminalPair(t)
			console, _, err := openStartupConsole(slave, slave)
			if err != nil {
				t.Fatal(err)
			}
			defer console.Close()
			ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
			defer cancel()
			started := time.Now()
			if operation == "read" {
				_, err = console.ReadKey(ctx)
			} else {
				// An unread PTY must not stall shutdown when its output buffer fills.
				err = console.Write(ctx, strings.Repeat("x", 256<<10))
			}
			if !errors.Is(err, context.DeadlineExceeded) || time.Since(started) > time.Second {
				t.Fatalf("%s did not honor cancellation: %v", operation, err)
			}
			if err := console.Close(); err != nil {
				t.Fatal(err)
			}
			assertTerminalRestored(t, fd, state, flags)
		})
	}
}

func TestNativeConsolePreservesExistingNonblockingDescriptor(t *testing.T) {
	_, slave, fd, state, _ := terminalPair(t)
	if err := unix.SetNonblock(fd, true); err != nil {
		t.Fatal(err)
	}
	flags, err := unix.FcntlInt(uintptr(fd), unix.F_GETFL, 0)
	if err != nil {
		t.Fatal(err)
	}
	console, _, err := openStartupConsole(slave, slave)
	if err != nil {
		t.Fatal(err)
	}
	if err := console.Close(); err != nil {
		t.Fatal(err)
	}
	assertTerminalRestored(t, fd, state, flags)
}

func TestNativeConsoleRedirectedAndPartialTerminals(t *testing.T) {
	file, err := os.CreateTemp(t.TempDir(), "redirected")
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	console, interactive, err := openStartupConsole(file, file)
	if err != nil || console != nil || interactive {
		t.Fatal("redirected files were treated as a terminal")
	}
	for _, inputOnly := range []bool{true, false} {
		_, slave, fd, state, flags := terminalPair(t)
		if inputOnly {
			console, interactive, err = openStartupConsole(slave, io.Discard)
		} else {
			console, interactive, err = openStartupConsole(nil, slave)
		}
		if err != nil || interactive != inputOnly || console == nil {
			t.Fatalf("partial terminal open failed: %v", err)
		}
		if inputOnly {
			width, height, err := console.Size()
			if err != nil || width != 0 || height != 0 || console.Write(context.Background(), "x") == nil {
				t.Fatal("input-only terminal exposed output")
			}
		} else if _, err := console.ReadKey(context.Background()); !errors.Is(err, io.EOF) {
			t.Fatal("output-only terminal exposed input")
		}
		if err := console.Close(); err != nil {
			t.Fatal(err)
		}
		assertTerminalRestored(t, fd, state, flags)
	}
}

func TestNativeConsoleClosedDescriptorFailsAndRestoresOtherFlags(t *testing.T) {
	_, slave, fd, state, flags := terminalPair(t)
	// An output-only marker with an invalid cached descriptor fails after input.
	console := &nativeConsole{input: slave, inputFD: fd, output: os.Stdout, outputFD: -1}
	if err := console.prepare(); err == nil {
		t.Fatal("invalid output descriptor was accepted")
	}
	if err := console.Close(); err != nil {
		t.Fatal(err)
	}
	assertTerminalRestored(t, fd, state, flags)
	console = &nativeConsole{input: slave, inputFD: fd, output: slave, outputFD: fd}
	if err := console.prepare(); err != nil {
		t.Fatal(err)
	}
	if err := slave.Close(); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if _, err := console.ReadKey(ctx); err == nil || errors.Is(err, context.DeadlineExceeded) {
		t.Fatal("closed input did not fail immediately")
	}
	if err := console.Write(ctx, "x"); err == nil || errors.Is(err, context.DeadlineExceeded) {
		t.Fatal("closed output did not fail immediately")
	}
	if _, _, err := console.Size(); err == nil {
		t.Fatal("closed terminal reported a size")
	}
	if err := console.Close(); err == nil {
		t.Fatal("failed flag restoration was swallowed")
	}
	if _, _, err := openStartupConsole(slave, io.Discard); err == nil {
		t.Fatal("closed input handle was accepted")
	}
	if _, _, err := openStartupConsole(nil, slave); err == nil {
		t.Fatal("closed output handle was accepted")
	}
}
