// Package flow bounds concurrent transport writes and fairly admits ready
// streams. It cannot remove congestion inside the shared DERP connection.
package flow

import "context"

type request struct {
	ctx      context.Context
	priority int
	ready    chan bool
}
type Scheduler struct {
	ctx      context.Context
	cancel   context.CancelFunc
	requests chan request
	released chan int
	wake     chan struct{}
	done     chan struct{}
}

func New(parent context.Context) *Scheduler {
	ctx, cancel := context.WithCancel(parent)
	s := &Scheduler{ctx: ctx, cancel: cancel, requests: make(chan request, 64), released: make(chan int, 12), wake: make(chan struct{}, 1), done: make(chan struct{})}
	go s.run()
	return s
}
func (s *Scheduler) Write(ctx context.Context, priority int, write func() (int, error)) (int, error) {
	if priority < 0 || priority > 3 {
		priority = 3
	}
	r := request{ctx, priority, make(chan bool, 1)}
	select {
	case s.requests <- r:
	case <-ctx.Done():
		return 0, ctx.Err()
	case <-s.ctx.Done():
		return 0, s.ctx.Err()
	}
	select {
	case granted := <-r.ready:
		if !granted {
			return 0, context.Canceled
		}
		defer func() {
			select {
			case s.released <- priority:
			case <-s.ctx.Done():
			}
		}()
		if e := ctx.Err(); e != nil {
			return 0, e
		}
		return write()
	case <-ctx.Done():
		// The actor owns cancellation of queued work. Joining its decision avoids
		// leaking an admission slot when grant and cancellation race.
		select {
		case s.wake <- struct{}{}:
		default:
		}
		select {
		case granted := <-r.ready:
			if granted {
				select {
				case s.released <- priority:
				case <-s.ctx.Done():
				}
			}
		case <-s.ctx.Done():
		}
		return 0, ctx.Err()
	case <-s.ctx.Done():
		return 0, s.ctx.Err()
	}
}
func (s *Scheduler) Close() { s.cancel(); <-s.done }
func (s *Scheduler) run() {
	defer close(s.done)
	var queues [4][]request
	active := [4]int{}
	limits := [4]int{4, 2, 4, 2}
	cursor := 0
	weights := []int{0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 3}
	for {
		progressed := true
		for progressed {
			progressed = false
			for step := 0; step < len(weights); step++ {
				index := (cursor + step) % len(weights)
				p := weights[index]
				if len(queues[p]) == 0 {
					continue
				}
				r := queues[p][0]
				if r.ctx.Err() != nil {
					queues[p] = queues[p][1:]
					r.ready <- false
					progressed = true
					break
				}
				if active[p] >= limits[p] {
					continue
				}
				queues[p] = queues[p][1:]
				active[p]++
				r.ready <- true
				cursor = (index + 1) % len(weights)
				progressed = true
				break
			}
		}
		select {
		case <-s.ctx.Done():
			return
		case <-s.wake:
		case p := <-s.released:
			active[p]--
		case r := <-s.requests:
			// At most 64 waiters are admitted across all classes, regardless of a
			// malicious caller's number of active streams.
			n := 0
			for _, q := range queues {
				n += len(q)
			}
			if n >= 64 {
				r.ready <- false
			} else {
				queues[r.priority] = append(queues[r.priority], r)
			}
		}
	}
}
