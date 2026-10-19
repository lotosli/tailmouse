package flow

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"testing/synctest"
	"time"
)

func TestControlContinuesWhenBulkWritesStall(t *testing.T) {
	s := New(t.Context())
	defer s.Close()
	release := make(chan struct{})
	started := make(chan struct{}, 2)
	var group sync.WaitGroup
	for range 2 {
		group.Go(func() {
			_, _ = s.Write(t.Context(), 3, func() (int, error) { started <- struct{}{}; <-release; return 1, nil })
		})
	}
	for range 2 {
		<-started
	}
	ctx, cancel := context.WithTimeout(t.Context(), time.Second)
	defer cancel()
	n, e := s.Write(ctx, 0, func() (int, error) { return 2, nil })
	close(release)
	group.Wait()
	if e != nil || n != 2 {
		t.Fatal("stalled bulk blocked control")
	}
}

func TestQueuedCancellationDoesNotWaitForStalledWrites(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		s := New(t.Context())
		defer s.Close()
		release := make(chan struct{})
		started := make(chan struct{}, 2)
		var group sync.WaitGroup
		for range 2 {
			group.Go(func() {
				_, _ = s.Write(t.Context(), 3, func() (int, error) { started <- struct{}{}; <-release; return 1, nil })
			})
		}
		<-started
		<-started
		ctx, cancel := context.WithCancel(t.Context())
		done := make(chan error, 1)
		go func() {
			_, err := s.Write(ctx, 99, func() (int, error) { t.Error("canceled queued write ran"); return 0, nil })
			done <- err
		}()
		synctest.Wait()
		cancel()
		synctest.Wait()
		select {
		case err := <-done:
			if !errors.Is(err, context.Canceled) {
				t.Error(err)
			}
		default:
			t.Error("cancellation remained blocked behind stalled writes")
		}
		close(release)
		group.Wait()
	})
}
func TestFairBoundedWritesAndCancellation(t *testing.T) {
	s := New(t.Context())
	var active, max atomic.Int64
	var group sync.WaitGroup
	for i := 0; i < 60; i++ {
		group.Go(func() {
			_, e := s.Write(t.Context(), 1+i%3, func() (int, error) {
				v := active.Add(1)
				for {
					old := max.Load()
					if v <= old || max.CompareAndSwap(old, v) {
						break
					}
				}
				active.Add(-1)
				return 1, nil
			})
			if e != nil {
				t.Error(e)
			}
		})
	}
	group.Wait()
	if max.Load() > 8 {
		t.Fatal("write concurrency unbounded")
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if _, e := s.Write(ctx, 2, func() (int, error) { t.Error("canceled operation ran"); return 0, nil }); !errors.Is(e, context.Canceled) {
		t.Fatal(e)
	}
	s.Close()
	if _, e := s.Write(t.Context(), 3, func() (int, error) { t.Error("closed scheduler ran"); return 0, nil }); !errors.Is(e, context.Canceled) {
		t.Fatal(e)
	}
}
