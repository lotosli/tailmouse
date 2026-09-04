package session

import (
	"encoding/binary"
	"math"
	"testing"
	"time"
)

func TestLatencyUsesLocalTimeAndBoundedWindow(t *testing.T) {
	var latency Latency
	if latency.Inspect() != (LatencySnapshot{}) {
		t.Fatal("empty latency is not empty")
	}
	start := time.Now()
	for index := 1; index <= 100; index++ {
		now := start.Add(time.Duration(index) * time.Second)
		ping := latency.Ping(now)
		if binary.BigEndian.Uint64(ping.Payload) != uint64(index) || binary.BigEndian.Uint64(ping.Payload[8:]) != uint64(index-1)*uint64(time.Second) {
			t.Fatal("PING layout is incorrect")
		}
		if !latency.Pong(ping.Payload, now.Add(time.Duration(index)*time.Millisecond)) {
			t.Fatal("valid pong rejected")
		}
		if latency.Pong(ping.Payload, now.Add(time.Second)) {
			t.Fatal("duplicate pong counted")
		}
	}
	got := latency.Inspect()
	if got.Samples != 100 || got.P50MS != 70 || got.P95MS != 97 || math.Abs(got.RTTMS-96) > 0.001 || math.Abs(got.JitterMS-1) > 0.001 {
		t.Fatalf("statistics = %#v", got)
	}
}

func TestLatencyRejectsStaleAlteredAndInvalidPongs(t *testing.T) {
	var latency Latency
	now := time.Now()
	first := latency.Ping(now)
	for range 60 {
		latency.Ping(now)
	}
	if latency.Pong(first.Payload, now) || latency.Pong(nil, now) || latency.Pong(make([]byte, 16), now) {
		t.Fatal("invalid pong counted")
	}
	before := latency.Ping(now)
	latest := latency.Ping(now)
	changed := append([]byte(nil), latest.Payload...)
	changed[15]++
	if latency.Pong(changed, now) || latency.Pong(latest.Payload, now.Add(-time.Second)) {
		t.Fatal("altered or negative pong counted")
	}
	if !latency.Pong(latest.Payload, now.Add(10*time.Millisecond)) || latency.Pong(before.Payload, now.Add(20*time.Millisecond)) {
		t.Fatal("out-of-order pong counted")
	}
	latency.sequence = math.MaxUint64
	if binary.BigEndian.Uint64(latency.Ping(now).Payload) != 1 {
		t.Fatal("sequence wrapped to zero")
	}
}

func TestLatencyEWMA(t *testing.T) {
	var latency Latency
	now := time.Now()
	for _, milliseconds := range []time.Duration{100, 200, 50} {
		ping := latency.Ping(now)
		latency.Pong(ping.Payload, now.Add(milliseconds*time.Millisecond))
	}
	got := latency.Inspect()
	if got.RTTMS != 106 || got.JitterMS != 46 || got.P50MS != 100 || got.P95MS != 200 {
		t.Fatalf("EWMA = %#v", got)
	}
}
