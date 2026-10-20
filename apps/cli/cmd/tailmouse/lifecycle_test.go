package main

import (
	"context"
	"io"
	"strings"
	"testing"
	"time"

	tailcattransport "tailmouse/apps/cli/internal/transport/tailcat"
)

func TestRunLeashCleansUpAfterInvitationAndProtocolFailures(t *testing.T) {
	for _, test := range []struct {
		name    string
		address string
		output  io.Writer
		code    int
	}{
		{"oversized invitation", strings.Repeat("x", 2000), io.Discard, exitInvitation},
		{"display failure", syntheticAddress, failingWriter{}, exitInvitation},
	} {
		t.Run(test.name, func(t *testing.T) {
			fake := newFakeTransport()
			fake.address = []byte(test.address)
			starter := func(_ context.Context, config tailcattransport.Config) (transportServer, error) {
				return fake, nil
			}
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			defer cancel()
			if code := run(ctx, nil, []string{"leash", "--no-password", "--no-qr", "--", "unused"}, nil, t.TempDir(), test.output, io.Discard, starter); code != test.code {
				t.Fatalf("failure code = %d, want %d", code, test.code)
			}
			if fake.closeCalls != 1 {
				t.Fatal("invitation/protocol failure did not close transport exactly once")
			}
		})
	}
}

func TestRunLeashLifetimeExpiresAndClosesTransport(t *testing.T) {
	fake := newFakeTransport()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	starter := func(context.Context, tailcattransport.Config) (transportServer, error) { return fake, nil }
	// Revocation after the invitation is visible proves the initialized cleanup
	// path, not only validation of an already-canceled invocation.
	output := cancelOnWrite{cancel: cancel}
	code := run(ctx, nil, []string{"leash", "--no-password", "--ttl", "0", "--no-qr", "--", "unused"}, nil, t.TempDir(), output, io.Discard, starter)
	if code != exitExpired || fake.closeCalls != 1 {
		t.Fatal("revocation failed to close the unlimited-lifetime session")
	}
}

type cancelOnWrite struct{ cancel context.CancelFunc }

func (writer cancelOnWrite) Write(value []byte) (int, error) { writer.cancel(); return len(value), nil }
