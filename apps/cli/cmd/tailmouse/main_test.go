package main

import (
	"bytes"
	"context"
	"io"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"tailmouse/apps/cli/internal/invitation"
	tailcattransport "tailmouse/apps/cli/internal/transport/tailcat"
)

const syntheticAddress = "tcSyntheticM1Credential"

func TestRunRejectsInvalidCommandsAndConfigurationBeforeTransport(t *testing.T) {
	for _, args := range [][]string{
		nil, {"unknown"}, {"escape"}, {"leash", "--web-base-url", "https://user@example.com", "--", "unused"},
		{"leash", "--web-base-url", "https://example.com/#secret", "--", "unused"}, {"leash", "--ttl", "-1s", "--", "unused"},
		{"leash"}, {"leash", "--scrollback-bytes", "65535", "--", "unused"}, {"leash", "--unknown", "--", "unused"},
	} {
		called := false
		code := run(context.Background(), nil, args, nil, t.TempDir(), io.Discard, io.Discard,
			func(context.Context, tailcattransport.Config) (transportServer, error) {
				called = true
				return nil, nil
			})
		if code != exitConfig || called {
			t.Fatalf("configuration failure code = %d, initialized = %v", code, called)
		}
	}
	if code := run(context.Background(), nil, []string{"version"}, nil, t.TempDir(), nil, io.Discard, startTailcat); code != exitInternal {
		t.Fatal("invalid output boundary accepted")
	}
}

// The worker learns credentials solely from the in-memory invitation surface,
// just as a real browser does. It never prints them, even when a test fails.

type cardCapture struct {
	bytes.Buffer
	card chan invitation.MouseCard
	sent bool
}

func (capture *cardCapture) Write(value []byte) (int, error) {
	count, err := capture.Buffer.Write(value)
	if !capture.sent {
		for _, line := range strings.Split(capture.String(), "\n") {
			if strings.HasPrefix(line, "Open: ") && strings.HasSuffix(capture.String(), "\n") {
				capture.sent = true
				var card invitation.MouseCard
				if parsed, parseErr := url.Parse(strings.TrimPrefix(line, "Open: ")); parseErr == nil {
					card, _ = invitation.ParseFragment("#"+parsed.Fragment, time.Now())
				}
				capture.card <- card
			}
		}
	}
	return count, err
}

type fakeTransport struct {
	mu         sync.Mutex
	config     tailcattransport.Config
	address    []byte
	copyErr    error
	closeErr   error
	closeCalls int
	onClose    func()
	relay      tailcattransport.Relay
}

func newFakeTransport() *fakeTransport {
	return &fakeTransport{address: []byte(syntheticAddress), relay: tailcattransport.Relay{Mode: tailcattransport.RelayOfficial, Host: "relay.example.com"}}
}
func (fake *fakeTransport) start(_ context.Context, config tailcattransport.Config) (transportServer, error) {
	fake.config = config
	return fake, nil
}
func (fake *fakeTransport) Relay() tailcattransport.Relay { return fake.relay }
func (fake *fakeTransport) CopyAddress() ([]byte, error) {
	return bytes.Clone(fake.address), fake.copyErr
}
func (fake *fakeTransport) Close(context.Context) error {
	fake.mu.Lock()
	defer fake.mu.Unlock()
	fake.closeCalls++
	if fake.onClose != nil {
		fake.onClose()
	}
	return fake.closeErr
}
