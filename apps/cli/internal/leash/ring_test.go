package leash

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"math"
	"math/rand/v2"
	"runtime"
	"sync"
	"testing"
	"time"
)

func TestRingCapacityAndCursorBounds(t *testing.T) {
	for _, capacity := range []int{-1, 0, MinScrollback - 1, MaxScrollback + 1} {
		if ring, err := NewRing(capacity); ring != nil || !errors.Is(err, ErrScrollback) {
			t.Fatalf("invalid capacity %d was accepted", capacity)
		}
	}
	for _, capacity := range []int{MinScrollback, DefaultScrollback, MaxScrollback} {
		ring, err := NewRing(capacity)
		if err != nil {
			t.Fatal(err)
		}
		if snapshot := ring.Snapshot(); len(snapshot.Data) != 0 || snapshot.End != 0 || snapshot.Dropped != 0 {
			t.Fatal("new ring is not empty")
		}
		for _, test := range []struct {
			cursor uint64
			limit  int
		}{{1, 1}, {0, 0}, {0, -1}, {0, capacity + 1}} {
			if _, err := ring.ReadFrom(test.cursor, test.limit); !errors.Is(err, ErrScrollback) {
				t.Fatal("invalid read was accepted")
			}
		}
		chunk, err := ring.ReadFrom(0, capacity)
		if err != nil || chunk.End != 0 || chunk.Dropped != 0 || len(chunk.Data) != 0 {
			t.Fatal("valid empty read failed")
		}
	}
	if DefaultScrollback != 1<<20 {
		t.Fatal("default differs from the PRD")
	}
}

func TestRingRawBytesWrapAndSnapshotCopies(t *testing.T) {
	ring, err := NewRing(MinScrollback)
	if err != nil {
		t.Fatal(err)
	}
	random := rand.New(rand.NewPCG(1, 2))
	oracle := []byte{}
	for _, size := range []int{0, 1, MinScrollback - 1, 1, 11, MinScrollback * 3, 32766, MinScrollback} {
		data := make([]byte, size)
		for index := range data {
			data[index] = byte(random.Uint32())
		}
		oracle = append(oracle, data...)
		if err := ring.Append(data); err != nil {
			t.Fatal(err)
		}
		clear(data)
		snapshot := ring.Snapshot()
		oldest := max(0, len(oracle)-MinScrollback)
		if snapshot.End != uint64(len(oracle)) || snapshot.Dropped != uint64(oldest) || !bytes.Equal(snapshot.Data, oracle[oldest:]) {
			t.Fatal("wrap, overwrite accounting, or append ownership failed")
		}
		clear(snapshot.Data)
		if !bytes.Equal(ring.Snapshot().Data, oracle[oldest:]) {
			t.Fatal("snapshot shares storage")
		}
		chunk, err := ring.ReadFrom(0, 7)
		if err != nil || chunk.Dropped != uint64(oldest) || chunk.End != uint64(min(oldest+7, len(oracle))) || !bytes.Equal(chunk.Data, oracle[oldest:min(oldest+7, len(oracle))]) {
			t.Fatal("limited live read or dropped count was incorrect")
		}
		clear(chunk.Data)
		if !bytes.Equal(ring.Snapshot().Data, oracle[oldest:]) {
			t.Fatal("live read shares storage")
		}
	}
	// Deliberately split Unicode and an alternate-screen ANSI sequence. The ring
	// preserves bytes; screen interpretation belongs to the terminal emulator.
	data := []byte("\xf0\x9f\x90\x88\x1b[?1049h\x1b[31mtest\x1b[0m\x1b[?1049l")
	before := ring.Snapshot()
	for _, value := range data {
		if err := ring.Append([]byte{value}); err != nil {
			t.Fatal(err)
		}
	}
	chunk, err := ring.ReadFrom(before.End, len(data))
	if err != nil || chunk.Dropped != 0 || !bytes.Equal(chunk.Data, data) {
		t.Fatal("terminal bytes were interpreted or changed")
	}
	if !bytes.Equal(before.Data, oracle[len(oracle)-MinScrollback:]) {
		t.Fatal("append mutated an earlier snapshot")
	}
}

func TestRingCursorOverflowFailsBeforeMutation(t *testing.T) {
	ring, err := NewRing(MinScrollback)
	if err != nil {
		t.Fatal(err)
	}
	ring.total = math.MaxUint64 - 1
	if err := ring.Append([]byte{1}); err != nil {
		t.Fatal(err)
	}
	before := ring.Snapshot()
	if err := ring.Append([]byte{2}); !errors.Is(err, ErrScrollback) {
		t.Fatal("overflow was accepted")
	}
	after := ring.Snapshot()
	if before.End != after.End || before.Dropped != after.Dropped || !bytes.Equal(before.Data, after.Data) {
		t.Fatal("overflow mutated the ring")
	}
	if err := ring.Append(nil); err != nil {
		t.Fatal("empty append overflowed")
	}
}

func TestRingConcurrentSnapshotToLiveHandoff(t *testing.T) {
	ring, err := NewRing(MinScrollback)
	if err != nil {
		t.Fatal(err)
	}
	oracle := make([]byte, 4*MinScrollback)
	for index := range oracle {
		oracle[index] = byte(index*31 + index/256)
	}
	if err := ring.Append(oracle[:100]); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	failures := make(chan error, 5)
	start := make(chan struct{})
	var workers sync.WaitGroup
	for range 4 {
		workers.Go(func() {
			initial := ring.Snapshot()
			cursor := initial.End
			if !bytes.Equal(initial.Data, oracle[initial.End-uint64(len(initial.Data)):initial.End]) {
				failures <- errors.New("inconsistent snapshot")
				return
			}
			<-start
			for cursor < uint64(len(oracle)) {
				if err := ctx.Err(); err != nil {
					failures <- err
					return
				}
				chunk, err := ring.ReadFrom(cursor, 97)
				if err != nil {
					failures <- err
					return
				}
				if chunk.End != cursor+chunk.Dropped+uint64(len(chunk.Data)) || !bytes.Equal(chunk.Data, oracle[chunk.End-uint64(len(chunk.Data)):chunk.End]) {
					failures <- fmt.Errorf("noncontiguous handoff at cursor %d", cursor)
					return
				}
				cursor = chunk.End
				runtime.Gosched()
			}
		})
	}
	workers.Go(func() {
		close(start)
		for cursor := 100; cursor < len(oracle); {
			end := min(cursor+113, len(oracle))
			if err := ring.Append(oracle[cursor:end]); err != nil {
				failures <- err
				return
			}
			cursor = end
			runtime.Gosched()
		}
	})
	workers.Wait()
	close(failures)
	for err := range failures {
		t.Fatal(err)
	}
}
