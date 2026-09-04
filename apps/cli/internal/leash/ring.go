package leash

import (
	"errors"
	"math"
	"sync"
)

const (
	MinScrollback     = 64 << 10
	DefaultScrollback = 1 << 20
	MaxScrollback     = 16 << 20
)

var ErrScrollback = errors.New("invalid leash scrollback size or cursor")

// Ring stores raw terminal bytes, including incomplete UTF-8 and ANSI sequences.
// Only the owning PTY reader appends. Snapshots and live readers may run concurrently.
type Ring struct {
	mu    sync.Mutex
	data  []byte
	total uint64
}

// Chunk is a private copy of [End-len(Data), End). Dropped is the number of
// requested earlier bytes that were overwritten before this read.
type Chunk struct {
	Data    []byte
	End     uint64
	Dropped uint64
}

func NewRing(capacity int) (*Ring, error) {
	if capacity < MinScrollback || capacity > MaxScrollback {
		return nil, ErrScrollback
	}
	return &Ring{data: make([]byte, capacity)}, nil
}

func (ring *Ring) Append(data []byte) error {
	ring.mu.Lock()
	defer ring.mu.Unlock()
	if uint64(len(data)) > math.MaxUint64-ring.total {
		return ErrScrollback
	}
	end := ring.total + uint64(len(data))
	if len(data) > len(ring.data) {
		data = data[len(data)-len(ring.data):]
	}
	start := int((end - uint64(len(data))) % uint64(len(ring.data)))
	first := copy(ring.data[start:], data)
	copy(ring.data, data[first:])
	ring.total = end
	return nil
}

// Snapshot and its end cursor are captured under the same lock. Reading from
// that cursor returns only subsequent bytes, even when append races the handoff.
func (ring *Ring) Snapshot() Chunk {
	ring.mu.Lock()
	defer ring.mu.Unlock()
	return ring.read(0, len(ring.data))
}

func (ring *Ring) ReadFrom(cursor uint64, limit int) (Chunk, error) {
	ring.mu.Lock()
	defer ring.mu.Unlock()
	if cursor > ring.total || limit <= 0 || limit > len(ring.data) {
		return Chunk{}, ErrScrollback
	}
	return ring.read(cursor, limit), nil
}

func (ring *Ring) read(cursor uint64, limit int) Chunk {
	oldest := ring.total - min(ring.total, uint64(len(ring.data)))
	skipped := uint64(0)
	if cursor < oldest {
		skipped, cursor = oldest-cursor, oldest
	}
	count := int(min(ring.total-cursor, uint64(limit)))
	data := make([]byte, count)
	start := int(cursor % uint64(len(ring.data)))
	first := copy(data, ring.data[start:])
	copy(data[first:], ring.data)
	return Chunk{Data: data, End: cursor + uint64(count), Dropped: skipped}
}
