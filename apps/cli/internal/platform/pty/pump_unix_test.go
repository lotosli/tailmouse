//go:build darwin || linux

package pty

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"io"
	"os"
	"sync"
	"testing"
	"time"

	"golang.org/x/sys/unix"
	"golang.org/x/term"

	"tailmouse/apps/cli/internal/leash"
)

const pumpOutputBytes = 4 << 20

func pumpOutput() []byte {
	data := make([]byte, pumpOutputBytes)
	for index := range data {
		data[index] = byte(index*31 + index/251)
	}
	return data
}

func pumpRecord(source byte, sequence uint32) [48]byte {
	var record [48]byte
	record[0] = source
	binary.LittleEndian.PutUint32(record[1:5], sequence)
	copy(record[5:], bytes.Repeat([]byte("q\x03\x1b[A\xf0\x9f\x90\x88"), 5))
	return record
}

// Raw mode disables line discipline and output translation, so the assertions
// compare actual PTY bytes, including NUL, Ctrl+C, ANSI and partial UTF-8.
func pumpChild(mode string) int {
	if _, err := term.MakeRaw(0); err != nil {
		return 125
	}
	if mode == "pump-output" {
		if count, err := io.Copy(os.Stdout, bytes.NewReader(pumpOutput())); err != nil || count != pumpOutputBytes {
			return 125
		}
		return 29
	}
	if _, err := io.WriteString(os.Stdout, "ready\n"); err != nil {
		return 125
	}
	data := make([]byte, 100*48)
	if _, err := io.ReadFull(os.Stdin, data); err != nil {
		return 125
	}
	if count, err := os.Stdout.Write(data); err != nil || count != len(data) {
		return 125
	}
	return 37
}

// Every test owns both a hard operation deadline and a joined pump. Process
// cleanup is registered first by startChild and therefore runs after the join.
func startNativePump(t *testing.T, pump *leash.Pump) (context.Context, context.CancelFunc, func() error) {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	done := make(chan struct{})
	var result error
	go func() {
		defer close(done)
		result = pump.Run(ctx)
	}()
	t.Cleanup(func() {
		cancel()
		select {
		case <-done:
		case <-time.After(2 * time.Second):
			t.Error("native pump did not join after cancellation")
		}
	})
	return ctx, cancel, func() error {
		select {
		case <-done:
			return result
		case <-ctx.Done():
			// Cancellation must stop the actual platform I/O as well as Run.
			select {
			case <-done:
				return result
			case <-time.After(2 * time.Second):
				return errors.New("native pump did not join")
			}
		}
	}
}

func readNativeSubscription(t *testing.T, ctx context.Context, subscriber *leash.Subscription) ([]byte, uint64) {
	t.Helper()
	var output bytes.Buffer
	var dropped uint64
	for {
		chunk, err := subscriber.Read(ctx, leash.TerminalChunkBytes)
		dropped += chunk.Dropped
		output.Write(chunk.Data)
		if errors.Is(err, io.EOF) {
			return output.Bytes(), dropped
		}
		if err != nil {
			t.Fatal(err)
		}
		if output.Len() > pumpOutputBytes {
			t.Fatal("subscription exceeded the bounded child fixture output")
		}
	}
}

func TestNativePumpSlowBrowserCannotBlockChildOrLocalOutput(t *testing.T) {
	process := startChild(t, childCommand(t, "pump-output"))
	var local bytes.Buffer
	pump, err := leash.NewPump(process, leash.MinScrollback, func(_ context.Context, data []byte) error {
		_, err := local.Write(data)
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	initial, slowBrowser := pump.Subscribe()
	defer slowBrowser.Close()
	if initial.End != 0 || initial.Dropped != 0 || len(initial.Data) != 0 {
		t.Fatal("new subscription did not start empty")
	}
	ctx, _, wait := startNativePump(t, pump)
	// Deliberately do not consume browser output until the child and pump exit.
	if err := wait(); err != nil {
		t.Fatal(err)
	}
	result, err := process.Wait(ctx)
	if err != nil || result != (Result{ExitCode: 29}) {
		t.Fatalf("unexpected child outcome: %+v, %v", result, err)
	}
	expected := pumpOutput()
	if !bytes.Equal(local.Bytes(), expected) {
		t.Fatal("slow browser blocked or changed local PTY bytes")
	}
	retained, dropped := readNativeSubscription(t, ctx, slowBrowser)
	if dropped != pumpOutputBytes-leash.BrowserBufferBytes || !bytes.Equal(retained, expected[len(expected)-leash.BrowserBufferBytes:]) {
		t.Fatal("browser buffer did not retain the exact bounded tail and drop count")
	}
	snapshot, reconnected := pump.Subscribe()
	defer reconnected.Close()
	if snapshot.End != pumpOutputBytes || snapshot.Dropped != pumpOutputBytes-leash.MinScrollback || !bytes.Equal(snapshot.Data, expected[len(expected)-leash.MinScrollback:]) {
		t.Fatal("reconnect did not capture the exact final raw scrollback")
	}
	if live, dropped := readNativeSubscription(t, ctx, reconnected); len(live) != 0 || dropped != 0 {
		t.Fatal("post-exit reconnect replayed snapshot bytes as live output")
	}
}

func TestNativePumpSerializesConcurrentRawInput(t *testing.T) {
	process := startChild(t, childCommand(t, "pump-input"))
	var local bytes.Buffer
	ready := make(chan struct{})
	var readyOnce sync.Once
	pump, err := leash.NewPump(process, leash.MinScrollback, func(_ context.Context, data []byte) error {
		local.Write(data)
		if local.Len() >= len("ready\n") {
			readyOnce.Do(func() { close(ready) })
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	_, browser := pump.Subscribe()
	defer browser.Close()
	ctx, _, wait := startNativePump(t, pump)
	select {
	case <-ready:
	case <-ctx.Done():
		t.Fatal("raw child did not become ready")
	}
	results := make(chan error, 2)
	for _, source := range []byte{'L', 'B'} {
		go func() {
			for sequence := range uint32(50) {
				record := pumpRecord(source, sequence)
				if err := pump.Input(ctx, record[:]); err != nil {
					results <- err
					return
				}
				clear(record[:]) // Accepted bytes cannot alias the caller's buffer.
			}
			results <- nil
		}()
	}
	var inputErr error
	for range 2 {
		select {
		case err := <-results:
			inputErr = errors.Join(inputErr, err)
		case <-ctx.Done():
			t.Fatal("input producers did not finish before the native test deadline")
		}
	}
	if inputErr != nil {
		t.Fatal(inputErr)
	}
	if err := wait(); err != nil {
		t.Fatal(err)
	}
	result, err := process.Wait(ctx)
	if err != nil || result != (Result{ExitCode: 37}) {
		t.Fatalf("raw Ctrl+C or q was intercepted: %+v, %v", result, err)
	}
	output, dropped := readNativeSubscription(t, ctx, browser)
	if dropped != 0 || !bytes.Equal(output, local.Bytes()) || len(output) != len("ready\n")+100*48 || !bytes.HasPrefix(output, []byte("ready\n")) {
		t.Fatal("local/browser raw byte streams differ from child output")
	}
	next := map[byte]uint32{'L': 0, 'B': 0}
	for data := output[len("ready\n"):]; len(data) != 0; data = data[48:] {
		source := data[0]
		sequence, known := next[source]
		expected := pumpRecord(source, sequence)
		if !known || !bytes.Equal(data[:48], expected[:]) {
			t.Fatal("concurrent input chunks interleaved or changed order within a source")
		}
		next[source]++
	}
	if next['L'] != 50 || next['B'] != 50 || pump.PendingInput() != 0 {
		t.Fatal("accepted input was lost, duplicated, or retained after exit")
	}
}

func TestNativePumpCancellationDoesNotTerminateChild(t *testing.T) {
	process := startChild(t, childCommand(t, "idle"))
	ready := make(chan struct{})
	var once sync.Once
	pump, err := leash.NewPump(process, leash.MinScrollback, func(context.Context, []byte) error {
		once.Do(func() { close(ready) })
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel, wait := startNativePump(t, pump)
	select {
	case <-ready:
	case <-ctx.Done():
		t.Fatal("child did not become ready")
	}
	cancel()
	if err := wait(); !errors.Is(err, context.Canceled) {
		t.Fatalf("pump did not retain cancellation: %v", err)
	}
	select {
	case <-process.Done():
		t.Fatal("stopping terminal forwarding terminated the child")
	default:
	}
	if err := unix.Kill(process.PID(), 0); err != nil {
		t.Fatal("child is no longer alive after pump cancellation")
	}
	cleanup, stop := context.WithTimeout(t.Context(), 5*time.Second)
	defer stop()
	if err := process.Close(cleanup); err != nil {
		t.Fatal(err)
	}
	if result, err := process.Wait(cleanup); err != nil || result.Signal != int(unix.SIGKILL) {
		t.Fatalf("explicit process cleanup did not reap the child: %+v, %v", result, err)
	}
}
