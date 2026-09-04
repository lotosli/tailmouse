package session

import (
	"encoding/binary"
	"math"
	"slices"
	"sync"
	"time"

	"tailmouse/apps/cli/internal/protocol"
)

const latencyWindow = 60

type LatencySnapshot struct {
	Samples  uint64  `json:"samples"`
	RTTMS    float64 `json:"rtt_ms"`
	JitterMS float64 `json:"jitter_ms"`
	P50MS    float64 `json:"p50_ms"`
	P95MS    float64 `json:"p95_ms"`
}

type pendingPing struct {
	sequence uint64
	stamp    uint64
	sent     time.Time
}

// Latency retains at most sixty outstanding pings and sixty valid samples.
// The timestamp is echoed for matching; elapsed time always uses local clocks.
type Latency struct {
	mu                 sync.Mutex
	origin             time.Time
	sequence, accepted uint64
	pending            [latencyWindow]pendingPing
	window             [latencyWindow]float64
	previous           float64
	snapshot           LatencySnapshot
}

func (latency *Latency) Ping(now time.Time) protocol.Frame {
	latency.mu.Lock()
	defer latency.mu.Unlock()
	if latency.origin.IsZero() {
		latency.origin = now
	}
	latency.sequence++
	if latency.sequence == 0 {
		latency.sequence = 1
		latency.accepted = 0
	}
	stamp := uint64(max(0, now.Sub(latency.origin).Nanoseconds()))
	latency.pending[latency.sequence%latencyWindow] = pendingPing{latency.sequence, stamp, now}
	payload := make([]byte, 16)
	binary.BigEndian.PutUint64(payload, latency.sequence)
	binary.BigEndian.PutUint64(payload[8:], stamp)
	return protocol.Frame{Type: protocol.TypePing, Payload: payload}
}

func (latency *Latency) Pong(payload []byte, now time.Time) bool {
	if len(payload) != 16 {
		return false
	}
	sequence, stamp := binary.BigEndian.Uint64(payload), binary.BigEndian.Uint64(payload[8:])
	latency.mu.Lock()
	defer latency.mu.Unlock()
	ping := &latency.pending[sequence%latencyWindow]
	if sequence == 0 || sequence <= latency.accepted || ping.sequence != sequence || ping.stamp != stamp || now.Before(ping.sent) {
		return false
	}
	sample := float64(now.Sub(ping.sent)) / float64(time.Millisecond)
	*ping = pendingPing{}
	latency.accepted = sequence
	if latency.snapshot.Samples == 0 {
		latency.snapshot.RTTMS = sample
	} else {
		latency.snapshot.RTTMS += 0.2 * (sample - latency.snapshot.RTTMS)
		latency.snapshot.JitterMS += 0.2 * (math.Abs(sample-latency.previous) - latency.snapshot.JitterMS)
	}
	latency.previous = sample
	latency.window[latency.snapshot.Samples%latencyWindow] = sample
	latency.snapshot.Samples++
	return true
}

func (latency *Latency) Inspect() LatencySnapshot {
	latency.mu.Lock()
	defer latency.mu.Unlock()
	result := latency.snapshot
	count := int(min(result.Samples, uint64(latencyWindow)))
	if count == 0 {
		return result
	}
	window := latency.window
	slices.Sort(window[:count])
	result.P50MS = window[int(math.Ceil(float64(count)*0.50))-1]
	result.P95MS = window[int(math.Ceil(float64(count)*0.95))-1]
	return result
}

func (latency *Latency) ResetPending() {
	latency.mu.Lock()
	defer latency.mu.Unlock()
	latency.pending = [latencyWindow]pendingPing{}
	latency.accepted = latency.sequence
}
