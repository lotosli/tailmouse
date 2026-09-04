package main

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"tailmouse/apps/cli/internal/invitation"
	"tailmouse/apps/cli/internal/protocol"
	tailcattransport "tailmouse/apps/cli/internal/transport/tailcat"
)

const syntheticAddress = "tcSyntheticM1Credential"

func TestRunRejectsInvalidCommandsAndConfigurationBeforeTransport(t *testing.T) {
	for _, args := range [][]string{
		nil, {"unknown"}, {"escape", "extra"}, {"escape", "--web-base-url", "https://user@example.com"},
		{"escape", "--web-base-url", "https://example.com/#secret"}, {"escape", "--ttl", "-1s"},
		{"leash"}, {"leash", "--scrollback-bytes", "65535", "--", "unused"}, {"escape", "--unknown"},
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
	if code := run(context.Background(), nil, []string{"escape"}, nil, t.TempDir(), nil, io.Discard, startTailcat); code != exitInternal {
		t.Fatal("invalid output boundary accepted")
	}
}

func TestRunNegotiatesEscapeUsingTheDisplayedInvitation(t *testing.T) {
	for _, mode := range []string{"escape"} {
		t.Run(mode, func(t *testing.T) {
			fake := newFakeTransport()
			output := &cardCapture{card: make(chan invitation.MouseCard, 1)}
			peerDone := make(chan error, 1)
			go func() { peerDone <- exerciseCLIConnection(output.card, fake, false) }()
			args := []string{mode, "--web-base-url", "https://mouse.example/", "--no-qr"}
			wantCode := exitOK
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			var stderr bytes.Buffer
			code := run(ctx, nil, args, nil, t.TempDir(), output, &stderr, fake.start)
			if code != wantCode || !strings.Contains(stderr.String(), "browser    active") || !strings.Contains(stderr.String(), "relay      official / relay.example.com") || strings.Contains(stderr.String(), syntheticAddress) {
				t.Fatalf("session code = %d, diagnostic bytes = %d", code, stderr.Len())
			}
			select {
			case err := <-peerDone:
				if err != nil {
					t.Fatal(err)
				}
			case <-ctx.Done():
				t.Fatal("browser worker did not terminate")
			}
			if strings.Count(output.String(), "Open: https://mouse.example/#/v1/") != 1 || !strings.Contains(output.String(), "Anyone with this link can access this session until it expires.\nTreat it like a password.\n") {
				t.Fatal("invitation display incomplete")
			}
			if fake.closeCalls != 1 {
				t.Fatal("transport was not closed exactly once")
			}
		})
	}
}

func TestRunPreservesProtocolOutcomeAndClassifiesCloseFailure(t *testing.T) {
	for _, test := range []struct {
		name      string
		malformed bool
		closeErr  error
		code      int
	}{
		{"malformed frame", true, nil, exitProtocol},
		{"protocol root with close failure", true, errors.New("tcSyntheticPrivateDetail"), exitProtocol},
		{"transport close failure", false, errors.New("tcSyntheticPrivateDetail"), exitTransport},
	} {
		t.Run(test.name, func(t *testing.T) {
			fake := newFakeTransport()
			fake.closeErr = test.closeErr
			output := &cardCapture{card: make(chan invitation.MouseCard, 1)}
			done := make(chan error, 1)
			go func() { done <- exerciseCLIConnection(output.card, fake, test.malformed) }()
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			var stderr bytes.Buffer
			code := run(ctx, nil, []string{"escape", "--no-qr"}, nil, t.TempDir(), output, &stderr, fake.start)
			if code != test.code || strings.Contains(stderr.String(), "tcSyntheticPrivateDetail") {
				t.Fatalf("root failure classification = %d", code)
			}
			select {
			case err := <-done:
				if err != nil {
					t.Fatal(err)
				}
			case <-ctx.Done():
				t.Fatal("browser did not exit")
			}
			if fake.closeCalls != 1 {
				t.Fatal("failure cleanup repeated or omitted transport close")
			}
		})
	}
}

// The worker learns credentials solely from the in-memory invitation surface,
// just as a real browser does. It never prints them, even when a test fails.
func exerciseCLIConnection(cards <-chan invitation.MouseCard, fake *fakeTransport, malformed bool, presentation ...protocol.GamePresentation) error {
	var card invitation.MouseCard
	select {
	case card = <-cards:
	case <-time.After(2 * time.Second):
		return errors.New("invitation was not displayed")
	}
	if card.Version == 0 {
		return errors.New("displayed invitation was invalid")
	}
	server, browser := net.Pipe()
	defer browser.Close()
	_ = browser.SetDeadline(time.Now().Add(2 * time.Second))
	fake.config.OnConnection(server)
	payload, _ := json.Marshal(map[string]any{
		"protocol_min": 1, "protocol_max": 1, "session_id": hex.EncodeToString(card.SessionID[:]), "mode": string(card.Mode),
		"client": map[string]string{"name": "test-browser", "version": "1", "platform": "test", "user_agent": ""},
	})
	ctx := context.Background()
	if err := protocol.WriteFrame(ctx, browser, protocol.PeerBrowser, protocol.StateAwaitClientHello, protocol.Frame{Type: protocol.TypeClientHello, Payload: payload}); err != nil {
		return err
	}
	clear(payload)
	welcome, err := protocol.ReadFrame(ctx, browser, protocol.PeerBrowser, protocol.StateAwaitServerWelcome)
	if err != nil || welcome.Type != protocol.TypeServerWelcome {
		return errors.New("CLI did not negotiate welcome")
	}
	state := protocol.StateActiveEscape
	if card.Mode == invitation.ModeLeash {
		state = protocol.StateActiveLeash
		if !bytes.Contains(welcome.Payload, []byte("\"capabilities\":[\"terminal_output\"]")) {
			return errors.New("CLI lost readonly authority")
		}
	} else {
		for _, expected := range []protocol.MessageType{protocol.TypeGameInit, protocol.TypeGameSnapshot, protocol.TypeGameEvent} {
			frame, err := protocol.ReadFrame(ctx, browser, protocol.PeerBrowser, state)
			if err != nil || frame.Type != expected {
				return errors.New("CLI omitted ordered game initialization")
			}
			if frame.Type == protocol.TypeGameInit {
				initial, err := protocol.DecodeGameInit(frame)
				want := protocol.GamePresentation{Control: "touch", PhoneRender: true, ShowNet: true}
				if len(presentation) != 0 {
					want = presentation[0]
				}
				if err != nil || initial.Presentation != want {
					return errors.New("CLI lost game presentation policy")
				}
			}
		}
	}
	if malformed {
		if _, err := browser.Write([]byte{0, 0, 0, 1}); err != nil {
			return errors.New("malformed test write failed")
		}
		response, err := protocol.ReadFrame(ctx, browser, protocol.PeerBrowser, state)
		if err != nil {
			return err
		}
		if code, _ := protocol.ErrorCodeOf(protocol.DecodeError(response)); code != protocol.CodeBadFrame {
			return errors.New("CLI did not reject malformed frame")
		}
		return nil
	}
	frame, _ := protocol.CloseFrame("normal")
	if err := protocol.WriteFrame(ctx, browser, protocol.PeerBrowser, state, frame); err != nil {
		return err
	}
	response, err := protocol.ReadFrame(ctx, browser, protocol.PeerBrowser, protocol.StateClosing)
	if err != nil || response.Type != protocol.TypeClose {
		return errors.New("CLI omitted close acknowledgement")
	}
	return nil
}

func TestEscapePresentationFlagsReachTheNegotiatedGame(t *testing.T) {
	for _, test := range []struct {
		args []string
		want protocol.GamePresentation
	}{
		{[]string{"--control=tilt", "--phone-render=false", "--show-net=false"}, protocol.GamePresentation{Control: "tilt"}},
		{[]string{"--phone-render=true", "--show-net=false"}, protocol.GamePresentation{Control: "touch", PhoneRender: true}},
		{[]string{"--phone-render=false", "--show-net=true"}, protocol.GamePresentation{Control: "touch", ShowNet: true}},
	} {
		fake := newFakeTransport()
		output := &cardCapture{card: make(chan invitation.MouseCard, 1)}
		done := make(chan error, 1)
		go func() { done <- exerciseCLIConnection(output.card, fake, false, test.want) }()
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		args := append([]string{"escape", "--no-qr"}, test.args...)
		code := run(ctx, nil, args, nil, t.TempDir(), output, io.Discard, fake.start)
		select {
		case err := <-done:
			if err != nil {
				t.Fatal(err)
			}
		case <-ctx.Done():
			t.Fatal("game policy negotiation timed out")
		}
		cancel()
		if code != exitOK {
			t.Fatalf("game configuration exit = %d", code)
		}
	}
}

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
