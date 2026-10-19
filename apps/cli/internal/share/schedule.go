package share

import (
	"context"
	"tailmouse/apps/cli/internal/flow"
	"time"
)

type scheduledStream struct {
	Stream
	ctx       context.Context
	scheduler *flow.Scheduler
	priority  int
}

func (s *scheduledStream) Write(b []byte) (int, error) {
	return s.scheduler.Write(s.ctx, s.priority, func() (int, error) {
		if connection, ok := s.Stream.(interface{ SetWriteDeadline(time.Time) error }); ok {
			budget := 30 * time.Second
			if s.priority <= 1 {
				budget = 5 * time.Second
			}
			if err := connection.SetWriteDeadline(time.Now().Add(budget)); err != nil {
				return 0, err
			}
		}
		return s.Stream.Write(b)
	})
}
func (s *scheduledStream) bulk() { s.priority = 3 }
