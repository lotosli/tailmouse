package leash

import (
	"bytes"
	"context"
	"errors"
	"io"
	"slices"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type pumpPTY struct {
	read  func(context.Context, []byte) (int, error)
	write func(context.Context, []byte) error
	done  chan struct{}
}

func (process *pumpPTY) Read(ctx context.Context, data []byte) (int, error) {
	return process.read(ctx, data)
}
func (process *pumpPTY) Write(ctx context.Context, data []byte) error {
	return process.write(ctx, data)
}
func (process *pumpPTY) Done() <-chan struct{} { return process.done }

func boundedPumpContext(t *testing.T) context.Context {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	t.Cleanup(cancel)
	return ctx
}

func runPump(t *testing.T, pump *Pump) (context.CancelFunc, <-chan error) {
	t.Helper()
	ctx, cancel := context.WithCancel(boundedPumpContext(t))
	done := make(chan error, 1)
	joined := make(chan struct{})
	go func() { defer close(joined); done <- pump.Run(ctx) }()
	t.Cleanup(func() { cancel(); <-joined })
	return cancel, done
}

func pumpSource(t *testing.T, local func(context.Context, []byte) error) (*Pump, chan []byte, *pumpPTY) {
	t.Helper()
	source := make(chan []byte)
	process := &pumpPTY{done: make(chan struct{}), write: func(context.Context, []byte) error { return nil }}
	process.read = func(ctx context.Context, data []byte) (int, error) {
		select {
		case <-ctx.Done():
			return 0, ctx.Err()
		case chunk, ok := <-source:
			if !ok {
				return 0, io.EOF
			}
			return copy(data, chunk), nil
		}
	}
	pump, err := NewPump(process, MinScrollback, local)
	if err != nil {
		t.Fatal(err)
	}
	return pump, source, process
}

func TestPumpInputIncludesInflightAndPreservesCopies(t *testing.T) {
	pump, source, process := pumpSource(t, func(context.Context, []byte) error { return nil })
	writes := make(chan []byte, 64)
	release := make(chan struct{})
	var active, maximum atomic.Int32
	process.write = func(ctx context.Context, data []byte) error {
		count := active.Add(1)
		defer active.Add(-1)
		maximum.Store(max(maximum.Load(), count))
		writes <- slices.Clone(data)
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-release:
			return nil
		}
	}
	want := make([]byte, MaxInputBytes)
	for index := range want {
		want[index] = byte(index*31 + index/257)
	}
	for cursor := 0; cursor < len(want); {
		end := min(cursor+TerminalChunkBytes, len(want))
		data := slices.Clone(want[cursor:end])
		if err := pump.Input(t.Context(), data); err != nil {
			t.Fatal(err)
		}
		clear(data)
		cursor = end
	}
	_, done := runPump(t, pump)
	ctx := boundedPumpContext(t)
	var first []byte
	select {
	case first = <-writes:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	if pump.PendingInput() != MaxInputBytes {
		t.Fatal("in-flight bytes escaped capacity accounting")
	}
	if err := pump.Input(t.Context(), []byte{1}); !errors.Is(err, ErrBackpressure) {
		t.Fatal("full input buffer accepted excess bytes")
	}
	close(release)
	actual := slices.Clone(first)
	for len(actual) < len(want) {
		select {
		case data := <-writes:
			actual = append(actual, data...)
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
	}
	if !bytes.Equal(actual, want) || maximum.Load() != 1 {
		t.Fatal("input copy, FIFO ordering or single-writer invariant failed")
	}
	// A second complete pass crosses the fixed input buffer's wrap boundary.
	for index := 0; index < 9; index++ {
		data := bytes.Repeat([]byte{byte(index + 1)}, TerminalChunkBytes)
		for {
			err := pump.Input(ctx, data)
			if err == nil {
				break
			}
			if !errors.Is(err, ErrBackpressure) {
				t.Fatal(err)
			}
			select {
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			case <-time.After(time.Millisecond):
			}
		}
		var received []byte
		for len(received) < len(data) {
			select {
			case part := <-writes:
				received = append(received, part...)
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
		}
		if !bytes.Equal(received, data) {
			t.Fatal("input wrap changed accepted byte order")
		}
	}
	close(source)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if pump.PendingInput() != 0 {
		t.Fatal("closed pump retained input")
	}
	if err := pump.Input(t.Context(), []byte{1}); !errors.Is(err, ErrPumpClosed) {
		t.Fatal("closed pump accepted input")
	}
	if err := pump.Run(t.Context()); !errors.Is(err, ErrPumpRunning) {
		t.Fatal("pump allowed a second reader")
	}
}

func TestPumpRestartMarkerPrecedesNewGenerationOutput(t *testing.T) {
	var local bytes.Buffer
	pump, source, _ := pumpSource(t, func(_ context.Context, data []byte) error { _, err := local.Write(data); return err })
	if err := pump.RestartMarker(t.Context(), 1); !errors.Is(err, ErrInput) {
		t.Fatal("first generation accepted a restart marker")
	}
	if err := pump.RestartMarker(t.Context(), 2); err != nil {
		t.Fatal(err)
	}
	close(source)
	if err := pump.Run(t.Context()); err != nil {
		t.Fatal(err)
	}
	if err := pump.RestartMarker(t.Context(), 3); !errors.Is(err, ErrInput) {
		t.Fatal("running pump accepted an out-of-order marker")
	}
	snapshot, subscriber := pump.Subscribe()
	defer subscriber.Close()
	if !bytes.Equal(snapshot.Data, local.Bytes()) || !bytes.Contains(snapshot.Data, []byte("TailMouse restarted process · generation 2")) {
		t.Fatal("restart marker was not shared by local/history output")
	}
}

func TestPumpSlowSubscriberNeverBlocksOutput(t *testing.T) {
	var local bytes.Buffer
	pump, source, _ := pumpSource(t, func(_ context.Context, data []byte) error { _, err := local.Write(data); return err })
	snapshot, subscriber := pump.Subscribe()
	defer subscriber.Close()
	if len(snapshot.Data) != 0 || snapshot.End != 0 {
		t.Fatal("initial snapshot was not empty")
	}
	_, done := runPump(t, pump)
	ctx := boundedPumpContext(t)
	want := make([]byte, 3*BrowserBufferBytes+137)
	for index := range want {
		want[index] = byte(index*17 + index/127)
	}
	for cursor := 0; cursor < len(want); {
		end := min(cursor+TerminalChunkBytes, len(want))
		select {
		case source <- want[cursor:end]:
		case <-ctx.Done():
			t.Fatal("slow subscriber blocked the producer")
		}
		cursor = end
	}
	close(source)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(local.Bytes(), want) {
		t.Fatal("slow browser lost local output")
	}
	var received []byte
	var dropped uint64
	for {
		chunk, err := subscriber.Read(ctx, TerminalChunkBytes)
		dropped += chunk.Dropped
		received = append(received, chunk.Data...)
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
	}
	if !bytes.Equal(received, want[len(want)-BrowserBufferBytes:]) || dropped != uint64(len(want)-BrowserBufferBytes) {
		t.Fatal("delivery buffer or exact drop accounting failed")
	}
	history, next := pump.Subscribe()
	defer next.Close()
	if history.End != uint64(len(want)) || history.Dropped != uint64(len(want)-MinScrollback) || !bytes.Equal(history.Data, want[len(want)-MinScrollback:]) {
		t.Fatal("configured history and browser delivery were not independently bounded")
	}
	if _, err := subscriber.Read(ctx, 1); !errors.Is(err, ErrSubscriptionClosed) {
		t.Fatal("replacement did not invalidate the old subscriber")
	}
	subscriber.Close()
	if _, err := next.Read(ctx, 1); !errors.Is(err, io.EOF) {
		t.Fatal("closing the old subscription affected its replacement")
	}
}

func TestPumpSnapshotLiveAndBrowserCancellation(t *testing.T) {
	appended := make(chan struct{}, 16)
	pump, source, process := pumpSource(t, func(context.Context, []byte) error { appended <- struct{}{}; return nil })
	_, done := runPump(t, pump)
	ctx := boundedPumpContext(t)
	source <- []byte("before")
	<-appended
	snapshot, subscriber := pump.Subscribe()
	if string(snapshot.Data) != "before" || snapshot.End != 6 {
		t.Fatal("snapshot was inconsistent")
	}
	snapshot.Data[0] = 'X'
	after, replace := pump.Subscribe()
	if string(after.Data) != "before" {
		t.Fatal("snapshot shared ring storage")
	}
	if _, err := subscriber.Read(ctx, 1); !errors.Is(err, ErrSubscriptionClosed) {
		t.Fatal("old live read survived replacement")
	}
	timeout, cancel := context.WithTimeout(ctx, 10*time.Millisecond)
	defer cancel()
	if _, err := replace.Read(timeout, 16); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatal("browser read did not cancel")
	}
	source <- []byte("after")
	<-appended
	chunk, err := replace.Read(ctx, 16)
	if err != nil || string(chunk.Data) != "after" || chunk.End != 11 || chunk.Dropped != 0 {
		t.Fatal("snapshot/live boundary repeated or skipped bytes")
	}
	waiting := make(chan error, 1)
	go func() { _, err := replace.Read(ctx, 16); waiting <- err }()
	replace.Close()
	if err := <-waiting; !errors.Is(err, ErrSubscriptionClosed) {
		t.Fatal("subscription close did not wake read")
	}
	if err := pump.Input(ctx, []byte("q")); err != nil {
		t.Fatal("browser cancellation closed host input")
	}
	select {
	case <-process.done:
		t.Fatal("browser cancellation ended process")
	default:
	}
	close(source)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

func TestPumpInvalidInputAndSubscriptionBounds(t *testing.T) {
	local := func(context.Context, []byte) error { return nil }
	pump, _, process := pumpSource(t, local)
	if value, err := NewPump(nil, MinScrollback, local); value != nil || err == nil {
		t.Fatal("nil PTY accepted")
	}
	if value, err := NewPump(process, MinScrollback, nil); value != nil || err == nil {
		t.Fatal("nil local sink accepted")
	}
	if value, err := NewPump(process, 0, local); value != nil || !errors.Is(err, ErrScrollback) {
		t.Fatal("invalid history accepted")
	}
	for _, data := range [][]byte{nil, {}, make([]byte, TerminalChunkBytes+1)} {
		if err := pump.Input(t.Context(), data); !errors.Is(err, ErrInput) {
			t.Fatal("invalid input size accepted")
		}
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if err := pump.Input(ctx, []byte{1}); !errors.Is(err, context.Canceled) {
		t.Fatal("canceled input accepted")
	}
	_, subscriber := pump.Subscribe()
	defer subscriber.Close()
	for _, limit := range []int{-1, 0, TerminalChunkBytes + 1} {
		if _, err := subscriber.Read(t.Context(), limit); !errors.Is(err, ErrInput) {
			t.Fatal("invalid delivery chunk size accepted")
		}
	}
	if _, err := subscriber.Read(ctx, 1); !errors.Is(err, context.Canceled) {
		t.Fatal("canceled browser read accepted")
	}
	close(process.done)
	if err := pump.Input(t.Context(), []byte{1}); !errors.Is(err, ErrPumpClosed) {
		t.Fatal("exited child accepted input")
	}
}

func TestPumpRootFailuresAndCleanup(t *testing.T) {
	root := errors.New("synthetic root failure")
	cases := []struct {
		name     string
		read     func(context.Context, []byte) (int, error)
		local    func(context.Context, []byte) error
		write    func(context.Context, []byte) error
		expected error
	}{
		{name: "read", read: func(context.Context, []byte) (int, error) { return 0, root }, expected: root},
		{name: "read panic", read: func(context.Context, []byte) (int, error) { panic("synthetic panic") }},
		{name: "negative count", read: func(context.Context, []byte) (int, error) { return -1, nil }},
		{name: "large count", read: func(_ context.Context, data []byte) (int, error) { return len(data) + 1, nil }},
		{name: "no progress", read: func(context.Context, []byte) (int, error) { return 0, nil }, expected: io.ErrNoProgress},
		{name: "local", local: func(context.Context, []byte) error { return root }, expected: root},
		{name: "local panic", local: func(context.Context, []byte) error { panic("synthetic panic") }},
		{name: "write", write: func(context.Context, []byte) error { return root }, expected: root},
		{name: "write panic", write: func(context.Context, []byte) error { panic("synthetic panic") }},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			local := test.local
			if local == nil {
				local = func(context.Context, []byte) error { return nil }
			}
			pump, _, process := pumpSource(t, local)
			if test.read != nil {
				process.read = test.read
			}
			if test.local != nil {
				process.read = func(_ context.Context, data []byte) (int, error) { data[0] = 1; return 1, nil }
			}
			if test.write != nil {
				process.write = test.write
			}
			if err := pump.Input(t.Context(), []byte("pending")); err != nil {
				t.Fatal(err)
			}
			_, done := runPump(t, pump)
			err := <-done
			if err == nil || test.expected != nil && !errors.Is(err, test.expected) {
				t.Fatalf("root failure changed: %v", err)
			}
			if pump.PendingInput() != 0 {
				t.Fatal("failure retained pending input")
			}
			if err := pump.Input(t.Context(), []byte{1}); !errors.Is(err, ErrPumpClosed) {
				t.Fatal("failed pump still accepts input")
			}
		})
	}
}

func TestPumpCancellationAndNormalExitDuringWrite(t *testing.T) {
	t.Run("owner cancellation", func(t *testing.T) {
		pump, _, process := pumpSource(t, func(context.Context, []byte) error { return nil })
		entered := make(chan struct{})
		process.write = func(ctx context.Context, _ []byte) error { close(entered); <-ctx.Done(); return ctx.Err() }
		if err := pump.Input(t.Context(), []byte{1}); err != nil {
			t.Fatal(err)
		}
		cancel, done := runPump(t, pump)
		<-entered
		cancel()
		if err := <-done; !errors.Is(err, context.Canceled) {
			t.Fatal("cancellation root was lost")
		}
		if pump.PendingInput() != 0 {
			t.Fatal("cancellation retained in-flight input")
		}
	})
	t.Run("child exit", func(t *testing.T) {
		pump, source, process := pumpSource(t, func(context.Context, []byte) error { return nil })
		entered := make(chan struct{})
		process.write = func(context.Context, []byte) error { close(process.done); close(entered); return io.EOF }
		if err := pump.Input(t.Context(), []byte{1}); err != nil {
			t.Fatal(err)
		}
		_, done := runPump(t, pump)
		<-entered
		source <- []byte("final output")
		close(source)
		if err := <-done; err != nil {
			t.Fatal("normal process exit became an internal write failure")
		}
		snapshot, subscriber := pump.Subscribe()
		defer subscriber.Close()
		if string(snapshot.Data) != "final output" {
			t.Fatal("normal exit lost final output")
		}
	})
}

func TestPumpConcurrentInputsRemainWholeAndOrderedPerSource(t *testing.T) {
	var actual bytes.Buffer
	pump, source, process := pumpSource(t, func(context.Context, []byte) error { return nil })
	process.write = func(_ context.Context, data []byte) error { _, err := actual.Write(data); return err }
	var producers sync.WaitGroup
	for _, base := range []byte{1, 33} {
		producers.Go(func() {
			for index := byte(0); index < 16; index++ {
				if err := pump.Input(t.Context(), bytes.Repeat([]byte{base + index}, 64)); err != nil {
					t.Error(err)
					return
				}
			}
		})
	}
	producers.Wait()
	// Run after enqueue so normal EOF cannot race admission in this ordering test.
	_, done := runPump(t, pump)
	ctx := boundedPumpContext(t)
	for pump.PendingInput() != 0 {
		select {
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		case <-time.After(time.Millisecond):
		}
	}
	close(source)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if actual.Len() != 32*64 {
		t.Fatal("input count changed")
	}
	next := map[byte]byte{0: 1, 1: 33}
	for block := 0; block < 32; block++ {
		data := actual.Bytes()[block*64 : (block+1)*64]
		group := byte(0)
		if data[0] >= 33 {
			group = 1
		}
		if data[0] != next[group] || !bytes.Equal(data, bytes.Repeat([]byte{data[0]}, 64)) {
			t.Fatal("input chunks interleaved or reordered within a source")
		}
		next[group]++
	}
}
