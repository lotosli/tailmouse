//go:build windows

package main

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"strings"
	"testing"
	"time"
	"unsafe"
)

func TestWindowsLocalKeyBytesPreserveNativeRecordsAndOwnerKeys(t *testing.T) {
	tests := []struct {
		name   string
		record localInputRecord
		want   []byte
	}{
		{name: "native key down", record: localInputRecord{key: 81, scan: 16, character: 'q', down: 1, modifiers: 8, repeat: 2}, want: []byte("\x1b[81;16;113;1;8;2_")},
		{name: "native unicode key up", record: localInputRecord{key: 0, scan: 0, character: 0xd83d, modifiers: 128, repeat: 1}, want: []byte("\x1b[0;0;55357;0;128;1_")},
		{name: "local ctrl c", record: localInputRecord{key: 67, scan: 46, character: 3, down: 1, modifiers: 8, repeat: 3}, want: []byte{3, 3, 3}},
		{name: "local enter", record: localInputRecord{key: 13, scan: 28, character: '\r', down: 1, repeat: 2}, want: []byte{'\r', '\r'}},
		{name: "released ctrl c remains native", record: localInputRecord{key: 67, scan: 46, character: 3, modifiers: 8, repeat: 1}, want: []byte("\x1b[67;46;3;0;8;1_")},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := localKeyBytes(test.record); !bytes.Equal(got, test.want) {
				t.Fatalf("encoded key = %q, want %q", got, test.want)
			}
		})
	}
	if size := unsafe.Sizeof(localInputRecord{}); size != 20 {
		t.Fatalf("INPUT_RECORD storage size = %d, want 20", size)
	}
	maximum := localKeyBytes(localInputRecord{character: 3, down: 1, repeat: ^uint16(0)})
	if len(maximum) != int(^uint16(0)) || maximum[0] != 3 || maximum[len(maximum)-1] != 3 {
		t.Fatal("native repeat count was truncated or exceeded its uint16 bound")
	}
	console := &leashLocalConsole{pending: append([]byte(nil), maximum...)}
	console.DiscardPendingInput()
	if len(console.pending) != 0 {
		t.Fatal("a restarted generation retained expanded local key input")
	}
}

func TestWindowsLeashLocalConsoleRedirectedFilesPreserveBytesAndOwnership(t *testing.T) {
	directory := t.TempDir()
	input, err := os.OpenFile(directory+"/input", os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	defer input.Close()
	value := []byte("q\x03\x1b[31m\n\xf0\x9f\x90\x88")
	if _, err := input.Write(value); err != nil {
		t.Fatal(err)
	}
	if _, err := input.Seek(0, io.SeekStart); err != nil {
		t.Fatal(err)
	}
	output, err := os.OpenFile(directory+"/output", os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	defer output.Close()
	console, err := openLeashConsole(input, output)
	if err != nil {
		t.Fatal(err)
	}
	data := make([]byte, len(value))
	if count, err := console.ReadInput(t.Context(), data); err != nil || count != len(value) || !bytes.Equal(data, value) {
		t.Fatalf("redirected input changed: count=%d err=%v", count, err)
	}
	if _, err := console.ReadInput(t.Context(), data); !errors.Is(err, io.EOF) {
		t.Fatalf("redirected input did not reach EOF: %v", err)
	}
	if err := console.Write(t.Context(), string(value)); err != nil {
		t.Fatal(err)
	}
	if width, height, err := console.Size(); err != nil || width != 0 || height != 0 {
		t.Fatalf("redirected streams invented dimensions: %dx%d %v", width, height, err)
	}
	if err := console.Close(); err != nil {
		t.Fatal(err)
	}
	if err := console.Close(); err != nil {
		t.Fatal("repeated cleanup failed", err)
	}
	if _, err := input.Seek(0, io.SeekStart); err != nil {
		t.Fatal("console closed the caller's input", err)
	}
	if _, err := output.Write([]byte("still-open")); err != nil {
		t.Fatal("console closed the caller's output", err)
	}
}

func TestWindowsLeashLocalConsolePipeCancellationJoinsAndPreservesCallerHandles(t *testing.T) {
	for _, operation := range []string{"read", "write"} {
		t.Run(operation, func(t *testing.T) {
			input, inputWriter, err := os.Pipe()
			if err != nil {
				t.Fatal(err)
			}
			defer input.Close()
			defer inputWriter.Close()
			outputReader, output, err := os.Pipe()
			if err != nil {
				t.Fatal(err)
			}
			defer outputReader.Close()
			defer output.Close()
			console, err := openLeashConsole(input, output)
			if err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithTimeout(t.Context(), 100*time.Millisecond)
			defer cancel()
			started := time.Now()
			if operation == "read" {
				_, err = console.ReadInput(ctx, make([]byte, 64))
			} else {
				err = console.Write(ctx, strings.Repeat("x", 4<<20))
			}
			if !errors.Is(err, context.DeadlineExceeded) || time.Since(started) > time.Second {
				t.Fatalf("blocked %s did not cancel in its bound: %v", operation, err)
			}
			if err := console.Close(); err != nil {
				t.Fatal(err)
			}
			if operation == "read" {
				if _, err := inputWriter.Write([]byte("q")); err != nil {
					t.Fatal("caller's pipe writer was closed", err)
				}
				got := make([]byte, 1)
				if _, err = input.Read(got); err != nil || got[0] != 'q' {
					t.Fatal("caller's pipe reader was closed", err)
				}
				return
			}
			drained := make(chan []byte, 1)
			go func() {
				got, _ := io.ReadAll(outputReader)
				drained <- got
			}()
			if _, err := output.Write([]byte("q")); err != nil {
				t.Fatal("caller's pipe output was closed", err)
			}
			if err := output.Close(); err != nil {
				t.Fatal(err)
			}
			select {
			case got := <-drained:
				if len(got) == 0 || got[len(got)-1] != 'q' {
					t.Fatal("caller output could not finish after private cleanup")
				}
			case <-time.After(time.Second):
				t.Fatal("caller output did not drain")
			}
		})
	}
}

// Windows has no SIGWINCH; redirected streams emit no console resize event.
func exerciseRedirectedResizeSignal(_ *leashCLIFixture) {}
