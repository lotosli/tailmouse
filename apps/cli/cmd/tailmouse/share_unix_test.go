//go:build linux || darwin

package main

import (
	"context"
	"errors"
	nativepty "github.com/creack/pty"
	"io"
	"os"
	"strings"
	"tailmouse/apps/cli/internal/share"
	"testing"
	"time"
)

func TestResourceLocalManagementUsesRawTTYAndReportsFailures(t *testing.T) {
	for _, tc := range []struct {
		name, keys   string
		output       io.Writer
		publishError bool
		wantError    bool
	}{
		{"menu-and-selection", "\x1da1\x1dg1\x1dx1\x1dp\x1dr\x1di\x1d\x1d\x1dq", io.Discard, false, false},
		{"interrupt-without-child", "\x03", io.Discard, false, false},
		{"output-failure", "\x1d", failingWriter{}, false, true},
		{"rotation-output-failure", "\x1di", io.Discard, true, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			master, slave, err := nativepty.Open()
			if err != nil {
				t.Fatal(err)
			}
			defer master.Close()
			defer slave.Close()
			console, err := openLeashConsole(slave, slave)
			if err != nil {
				t.Fatal(err)
			}
			defer console.Close()
			ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
			defer cancel()
			host, _, err := share.NewHost(ctx, share.Options{Command: "receive", Directory: t.TempDir(), Cwd: t.TempDir(), MaxFile: 1024, MaxTotal: 2048, MaxFiles: 10, MaxClients: 2, Approval: "manual", TTL: time.Minute}, os.Environ())
			if err != nil {
				t.Fatal(err)
			}
			defer host.Close()
			host.Ready()
			done := make(chan error, 1)
			rotations := 0
			go func() {
				done <- manageShare(ctx, console, host, tc.output, func(secret string) error {
					if len(secret) != 43 {
						return errors.New("invalid rotation")
					}
					rotations++
					if tc.publishError {
						return errors.New("output unavailable")
					}
					return nil
				}, cancel)
			}()
			if _, err = master.Write([]byte(tc.keys)); err != nil {
				t.Fatal(err)
			}
			select {
			case err = <-done:
			case <-ctx.Done():
				if !errors.Is(ctx.Err(), context.Canceled) {
					t.Fatal("local management timed out")
				}
				// The end action cancels the session before returning its result.
				// Join that return independently of the intentional cancellation.
				select {
				case err = <-done:
				case <-time.After(time.Second):
					t.Fatal("local management failed to join")
				}
			}
			if (err != nil) != tc.wantError {
				t.Fatal("local management error classification")
			}
			if strings.Contains(tc.keys, "\x1di") && rotations != 1 {
				t.Fatal("rotation was not published exactly once")
			}
		})
	}
}
