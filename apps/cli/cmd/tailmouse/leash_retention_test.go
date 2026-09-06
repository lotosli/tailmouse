package main

import (
	"testing"
	"testing/synctest"
	"time"
)

func TestLeashRetentionTimerUsesExactFakeTimeBoundaries(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		if timer, tick := leashRetentionTimer(true, time.Hour); timer != nil || tick != nil {
			t.Fatal("Host-lived retention installed a hidden timer")
		}

		immediate, immediateTick := leashRetentionTimer(false, 0)
		defer immediate.Stop()
		synctest.Wait()
		select {
		case <-immediateTick:
		default:
			t.Fatal("literal zero did not expire immediately")
		}

		bounded, boundedTick := leashRetentionTimer(false, time.Hour)
		defer bounded.Stop()
		select {
		case <-boundedTick:
			t.Fatal("bounded retention expired before its deadline")
		default:
		}
		time.Sleep(time.Hour)
		select {
		case <-boundedTick:
		default:
			t.Fatal("bounded retention did not expire at its exact deadline")
		}
	})
}
