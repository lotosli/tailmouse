//go:build windows

package pty

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"testing"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

func testConsolePipe(t *testing.T, hostReads bool) (*os.File, windows.Handle) {
	t.Helper()
	host, console, err := consolePipe(t.Context(), hostReads)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := host.Close(); err != nil && !errors.Is(err, os.ErrClosed) {
			t.Error(err)
		}
		if err := windows.CloseHandle(console); err != nil {
			t.Error(err)
		}
	})
	if err := host.SetDeadline(time.Now().Add(2 * time.Second)); err != nil {
		t.Fatal("host channel is not cancellable", err)
	}
	return host, console
}

func TestConPTYChannelRoundTripAndOwnership(t *testing.T) {
	for _, hostReads := range []bool{false, true} {
		name := "input"
		if hostReads {
			name = "output"
		}
		t.Run(name, func(t *testing.T) {
			host, console := testConsolePipe(t, hostReads)
			getInfo := windows.NewLazySystemDLL("kernel32.dll").NewProc("GetHandleInformation")
			checkHandle := func(handle uintptr) {
				var flags uint32
				ok, _, err := getInfo.Call(handle, uintptr(unsafe.Pointer(&flags)))
				if ok == 0 || flags&windows.HANDLE_FLAG_INHERIT != 0 {
					t.Fatal("terminal channel may be inherited", err)
				}
			}
			checkHandle(uintptr(console))
			raw, err := host.SyscallConn()
			if err != nil {
				t.Fatal(err)
			}
			if err := raw.Control(checkHandle); err != nil {
				t.Fatal(err)
			}
			want := []byte("\x1b[31mUnicode 🐈\x1b[0m\x00")
			got := make([]byte, len(want))
			var count uint32
			if hostReads {
				if err := windows.WriteFile(console, want, &count, nil); err != nil || count != uint32(len(want)) {
					t.Fatal("synchronous ConPTY output failed", err)
				}
				if _, err := io.ReadFull(host, got); err != nil {
					t.Fatal(err)
				}
			} else {
				if count, err := host.Write(want); err != nil || count != len(want) {
					t.Fatal("host input failed", err)
				}
				if err := windows.ReadFile(console, got, &count, nil); err != nil || count != uint32(len(want)) {
					t.Fatal("synchronous ConPTY input failed", err)
				}
			}
			if !bytes.Equal(got, want) {
				t.Fatal("terminal channel changed raw bytes")
			}
		})
	}
}

func TestConPTYChannelDeadlinesAndCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if host, console, err := consolePipe(ctx, true); !errors.Is(err, context.Canceled) || host != nil || console != 0 {
		t.Fatal("canceled setup allocated a channel")
	}
	read, _ := testConsolePipe(t, true)
	if err := read.SetReadDeadline(time.Now().Add(30 * time.Millisecond)); err != nil {
		t.Fatal(err)
	}
	if _, err := read.Read(make([]byte, 1)); !errors.Is(err, os.ErrDeadlineExceeded) {
		t.Fatal("empty terminal output ignored its deadline", err)
	}
	write, _ := testConsolePipe(t, false)
	if err := write.SetWriteDeadline(time.Now().Add(30 * time.Millisecond)); err != nil {
		t.Fatal(err)
	}
	// The ConPTY peer deliberately consumes nothing. The host must cancel
	// rather than retain an indefinitely blocked write or allocate a worker.
	for range 64 {
		if _, err := write.Write(make([]byte, 32<<10)); err != nil {
			if !errors.Is(err, os.ErrDeadlineExceeded) {
				t.Fatal(err)
			}
			return
		}
	}
	t.Fatal("an unread terminal channel accepted unbounded queued input")
}
