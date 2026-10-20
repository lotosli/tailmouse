//go:build tailcatintegration

package tailcat

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"tailmouse/apps/cli/internal/invitation"
	"tailmouse/apps/cli/internal/session"
)

func TestHermeticTailcatExpiredHost(t *testing.T) {
	starter := LocalTestStarter(t)
	host, err := session.NewHost(t.Context(), session.Config{
		Mode: "leash", NoPassword: true, TTL: 5 * time.Second, ReconnectGrace: 30 * time.Second,
		SessionID: [16]byte{1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16},
	}, time.Now(), nil)
	if err != nil {
		t.Fatal(err)
	}
	server, err := starter(t.Context(), Config{
		DERPHosts: []string{"localhost"}, DERPRegion: 900,
		OnConnection: func(stream ByteStream) { host.Accept(stream) },
	})
	if err != nil {
		_ = host.Close("local_revoke")
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := host.Close("local_revoke"); err != nil {
			t.Error("expired application host failed to close")
		}
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		if err := server.Close(ctx); err != nil {
			t.Error("expired transport failed to close")
		}
		if _, err := server.CopyAddress(); !errors.Is(err, ErrClosed) {
			t.Error("expired transport retained invitation access after close")
		}
	})
	relay := server.Relay()
	if err := host.Listen(string(relay.Mode), relay.Host, time.Now()); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	if outcome := host.Wait(ctx); outcome != session.TTLExpired {
		t.Fatalf("host outcome = %v, want TTL expiry", outcome)
	}
	before := host.Authority.Inspect(time.Now())
	if before.State != session.Expired || before.Owner != 0 {
		t.Fatal("native TTL did not expire before browser launch")
	}
	// Leave the transport listening until cleanup so a real late HELLO reaches
	// the expired authority. The invitation deliberately outlives this Host:
	// browser-side card expiry cannot substitute for native admission denial.
	address, err := server.CopyAddress()
	if err != nil {
		t.Fatal(err)
	}
	defer eraseBytes(address)
	root := repositoryRoot(t)
	static := httptest.NewServer(http.FileServer(http.Dir(filepath.Join(root, "apps", "web", "dist"))))
	t.Cleanup(static.Close)
	request := struct {
		BaseURL  string `json:"baseURL"`
		Fragment string `json:"fragment"`
	}{static.URL, mouseCardFragment(t, string(address), invitation.ModeLeash)}
	payload, err := json.Marshal(request)
	request.Fragment = ""
	if err != nil {
		t.Fatal(err)
	}
	defer eraseBytes(payload)
	probeContext, cancelProbe := context.WithTimeout(t.Context(), 25*time.Second)
	defer cancelProbe()
	command := exec.CommandContext(probeContext, "node", filepath.Join(root, "tests", "integration", "tailcat", "expired-host.mjs"))
	command.Dir, command.WaitDelay = root, 3*time.Second
	command.Stdin = bytes.NewReader(payload)
	var output bytes.Buffer
	command.Stdout, command.Stderr = &output, &output
	if err := command.Run(); err != nil {
		// The probe prints only fixed local stages, never browser exceptions.
		message := strings.TrimSpace(output.String())
		if len(message) > 512 {
			message = message[:512]
		}
		t.Fatalf("expired-host browser probe: %v: %s", err, message)
	}
	if strings.TrimSpace(output.String()) != "expired-host browser acceptance: passed" {
		t.Fatal("expired-host browser probe emitted an invalid result")
	}
	after := host.Authority.Inspect(time.Now())
	if after.State != session.Expired || after.Outcome != session.TTLExpired || after.Owner != 0 ||
		!after.ExpiresAt.Equal(before.ExpiresAt) || len(host.Authority.Capabilities()) != 0 {
		t.Fatal("late browser handshake changed expired authority")
	}
	if host.InspectMetrics().FramesRX != 1 {
		t.Fatal("expired Host did not receive exactly one real HELLO")
	}
	select {
	case <-host.FirstHello():
		t.Fatal("expired handshake triggered mode startup")
	default:
	}
}
