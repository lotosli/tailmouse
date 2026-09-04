//go:build windows

package main

import (
	"context"
	"io"
	"os"

	"tailmouse/apps/cli/internal/config"
	"tailmouse/apps/cli/internal/leash"
	"tailmouse/apps/cli/internal/session"
)

// Windows must fail explicitly until the accepted ConPTY/Job Object milestone
// supplies this boundary; a Unix subprocess or pipes are not a substitute.
func watchLeash(_ context.Context, _ *session.Host, _ config.Options, _ *leash.Command, _ *os.File, _ io.Writer, _ *diagnostics, _ <-chan os.Signal, _ func(session.Outcome, func() session.Outcome)) (int, session.Outcome) {
	return config.ExitPTY, session.InternalFailure
}
