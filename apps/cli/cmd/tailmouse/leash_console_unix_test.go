//go:build darwin || linux

package main

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"golang.org/x/sys/unix"
	"golang.org/x/term"
	"tailmouse/apps/cli/internal/leash"
)

func TestLeashLocalConsolePreservesRawChunksAndRestores(t *testing.T) {
	master, slave, fd, state, flags := terminalPair(t)
	console, err := openLeashConsole(slave, slave)
	if err != nil {
		t.Fatal(err)
	}
	defer console.Close()
	if raw, err := term.GetState(fd); err != nil || reflect.DeepEqual(raw, state) {
		t.Fatal("leash input did not enter raw mode")
	}
	ctx, cancel := context.WithTimeout(t.Context(), time.Second)
	defer cancel()
	input := []byte("q\x03\x1b[A\t\x00\xf0\x9f\x90\x88\r\n")
	if _, err := master.Write(input); err != nil {
		t.Fatal(err)
	}
	got := make([]byte, len(input))
	for offset := 0; offset < len(got); {
		count, err := console.ReadInput(ctx, got[offset:])
		if err != nil || count == 0 {
			t.Fatalf("raw input read failed: %v", err)
		}
		offset += count
	}
	if !bytes.Equal(got, input) {
		t.Fatal("leash console transformed or intercepted raw input")
	}
	if count, err := console.ReadInput(ctx, nil); count != 0 || err != nil {
		t.Fatal("empty read consumed input")
	}
	if width, height, err := console.Size(); err != nil || width != 100 || height != 24 {
		t.Fatalf("local dimensions = %dx%d: %v", width, height, err)
	}
	if err := console.Close(); err != nil {
		t.Fatal(err)
	}
	assertTerminalRestored(t, fd, state, flags)
	if err := console.Close(); err != nil {
		t.Fatal("repeated local terminal restoration failed")
	}
}

func TestLeashLocalConsoleRedirectedFilesAndEOF(t *testing.T) {
	input, err := os.CreateTemp(t.TempDir(), "input")
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
	output, err := os.Create(filepath.Join(t.TempDir(), "output"))
	if err != nil {
		t.Fatal(err)
	}
	defer output.Close()
	console, err := openLeashConsole(input, output)
	if err != nil {
		t.Fatal(err)
	}
	defer console.Close()
	ctx, cancel := context.WithTimeout(t.Context(), time.Second)
	defer cancel()
	var data [64]byte
	count, err := console.ReadInput(ctx, data[:])
	if err != nil || !bytes.Equal(data[:count], value) {
		t.Fatalf("redirected input changed: %v", err)
	}
	if _, err := console.ReadInput(ctx, data[:]); !errors.Is(err, io.EOF) {
		t.Fatalf("regular-file input did not reach EOF: %v", err)
	}
	if width, height, err := console.Size(); err != nil || width != 0 || height != 0 {
		t.Fatal("redirected streams exposed invented terminal dimensions")
	}
	if err := console.Write(ctx, string(value)); err != nil {
		t.Fatal(err)
	}
	if err := console.Close(); err != nil {
		t.Fatal(err)
	}
	if got, err := os.ReadFile(output.Name()); err != nil || !bytes.Equal(got, value) {
		t.Fatal("redirected output was translated or incomplete")
	}
	// The caller still owns both usable handles after console closure.
	if _, err := input.Seek(0, io.SeekStart); err != nil {
		t.Fatal("console closed the caller's input")
	}
	if _, err := output.Write([]byte("still open")); err != nil {
		t.Fatal("console closed the caller's output")
	}
}

func TestLeashLocalConsolePipesCancelAndRestore(t *testing.T) {
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
			defer output.Close()
			defer outputReader.Close()
			var descriptors, original []int
			for _, file := range []*os.File{input, output} {
				fd, err := consoleDescriptor(file)
				if err != nil {
					t.Fatal(err)
				}
				flags, err := unix.FcntlInt(uintptr(fd), unix.F_GETFL, 0)
				if err != nil {
					t.Fatal(err)
				}
				descriptors, original = append(descriptors, fd), append(original, flags)
			}
			console, err := openLeashConsole(input, output)
			if err != nil {
				t.Fatal(err)
			}
			defer console.Close()
			ctx, cancel := context.WithTimeout(t.Context(), 100*time.Millisecond)
			defer cancel()
			started := time.Now()
			if operation == "read" {
				var data [64]byte
				_, err = console.ReadInput(ctx, data[:])
			} else {
				err = console.Write(ctx, strings.Repeat("x", 1<<20))
			}
			if !errors.Is(err, context.DeadlineExceeded) || time.Since(started) > time.Second {
				t.Fatalf("redirected %s did not cancel: %v", operation, err)
			}
			if err := console.Close(); err != nil {
				t.Fatal(err)
			}
			for index, fd := range descriptors {
				flags, err := unix.FcntlInt(uintptr(fd), unix.F_GETFL, 0)
				if err != nil || flags&unix.O_NONBLOCK != original[index]&unix.O_NONBLOCK {
					t.Fatal("console did not restore the caller's pipe I/O mode")
				}
			}
		})
	}
}

func TestLeashLocalConsolePartialTTYAndInvalidHandles(t *testing.T) {
	_, slave, fd, state, flags := terminalPair(t)
	output, err := os.CreateTemp(t.TempDir(), "output")
	if err != nil {
		t.Fatal(err)
	}
	defer output.Close()
	for _, input := range []*os.File{nil, slave} {
		console, err := openLeashConsole(input, output)
		if err != nil {
			t.Fatal(err)
		}
		width, height, err := console.Size()
		if err != nil || input == nil && (width != 0 || height != 0) || input != nil && (width != 100 || height != 24) {
			t.Fatal("partial terminal dimensions did not use the available TTY")
		}
		if input == nil {
			if _, err := console.ReadInput(t.Context(), make([]byte, 1)); !errors.Is(err, io.EOF) {
				t.Fatal("absent stdin did not return EOF")
			}
		}
		if err := console.Close(); err != nil {
			t.Fatal(err)
		}
		assertTerminalRestored(t, fd, state, flags)
	}
	if console, err := openLeashConsole(slave, nil); err == nil || console != nil {
		t.Fatal("missing output was accepted")
	}
	if err := output.Close(); err != nil {
		t.Fatal(err)
	}
	if console, err := openLeashConsole(slave, output); err == nil || console != nil {
		t.Fatal("closed output was accepted")
	}
	if console, err := openLeashConsole(output, slave); err == nil || console != nil {
		t.Fatal("closed input was accepted")
	}
	assertTerminalRestored(t, fd, state, flags)
}

func TestLeashInputRestartDropsQueuedAndInFlightChunks(t *testing.T) {
	input, err := os.CreateTemp(t.TempDir(), "input")
	if err != nil {
		t.Fatal(err)
	}
	defer input.Close()
	old := bytes.Repeat([]byte("O"), 2*leash.TerminalChunkBytes)
	if _, err := input.Write(append(old, []byte("fresh-source")...)); err != nil {
		t.Fatal(err)
	}
	if _, err := input.Seek(0, io.SeekStart); err != nil {
		t.Fatal(err)
	}
	output, err := os.CreateTemp(t.TempDir(), "output")
	if err != nil {
		t.Fatal(err)
	}
	defer output.Close()
	console, err := openLeashConsole(input, output)
	if err != nil {
		t.Fatal(err)
	}
	defer console.Close()
	ctx, cancel := context.WithTimeout(t.Context(), time.Second)
	defer cancel()
	reader := readLeashInput(ctx, console)
	defer reader.Close()
	ticker := time.NewTicker(time.Millisecond)
	defer ticker.Stop()
	for {
		offset, err := input.Seek(0, io.SeekCurrent)
		if err != nil {
			t.Fatal(err)
		}
		if offset == int64(len(old)) {
			break
		}
		select {
		case <-ticker.C:
		case <-ctx.Done():
			t.Fatal("reader did not reach its bounded handoff")
		}
	}
	reader.Close()
	if _, open := <-reader.values; open {
		t.Fatal("old input remains after reader shutdown")
	}
	next := readLeashInput(ctx, console)
	defer next.Close()
	select {
	case value := <-next.values:
		if value.err != nil || string(value.data) != "fresh-source" {
			t.Fatal("restart replayed accepted old bytes or consumed unread source bytes")
		}
	case <-ctx.Done():
		t.Fatal("fresh reader did not resume")
	}
	select {
	case value := <-next.values:
		if !errors.Is(value.err, io.EOF) || len(value.data) != 0 {
			t.Fatal("reader did not preserve EOF")
		}
	case <-ctx.Done():
		t.Fatal("reader did not finish")
	}
}

func TestLeashInputRestartJoinsBlockedReadWithoutLosingFirstNewByte(t *testing.T) {
	input, writer, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer input.Close()
	defer writer.Close()
	output, err := os.CreateTemp(t.TempDir(), "output")
	if err != nil {
		t.Fatal(err)
	}
	defer output.Close()
	console, err := openLeashConsole(input, output)
	if err != nil {
		t.Fatal(err)
	}
	defer console.Close()
	ctx, cancel := context.WithTimeout(t.Context(), time.Second)
	defer cancel()
	reader := readLeashInput(ctx, console)
	reader.Close()
	next := readLeashInput(ctx, console)
	defer next.Close()
	if _, err := writer.Write([]byte("q")); err != nil {
		t.Fatal(err)
	}
	select {
	case value := <-next.values:
		if value.err != nil || string(value.data) != "q" {
			t.Fatal("first new local byte was lost or changed")
		}
	case <-ctx.Done():
		t.Fatal("new reader did not accept input")
	}
}
