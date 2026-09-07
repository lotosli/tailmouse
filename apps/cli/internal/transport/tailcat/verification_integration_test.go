//go:build tailcatintegration

package tailcat

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	upstream "github.com/tailscale/tailcat"
	"tailmouse/apps/cli/internal/invitation"
	"tailscale.com/derp/derpserver"
	"tailscale.com/types/key"
	"tailscale.com/types/logger"
)

// The relay uses the same upstream setters as derper --verify-clients --socket.
// Only its tailscaled membership lookup is controlled; no personal daemon,
// tailnet, admission callback replacement, or production TLS exception is used.
func TestHermeticTailcatClientVerification(t *testing.T) {
	hostKey, controlKey := key.NewNode(), key.NewNode()
	var allowed, denied, accepted atomic.Uint32
	var invalidLookup, invalidControl atomic.Bool
	directory, err := os.MkdirTemp("", "tm-verify-")
	if err != nil {
		t.Fatal("cannot create the owned verifier directory")
	}
	t.Cleanup(func() {
		if err := os.Remove(directory); err != nil {
			t.Error("owned verifier directory cleanup failed")
		}
	})
	socket := filepath.Join(directory, "api.sock")
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal("cannot listen on the owned verifier socket")
	}
	api := &http.Server{
		ReadHeaderTimeout: 2 * time.Second,
		ErrorLog:          logger.StdLogger(logger.Discard),
		Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Method != http.MethodGet || r.URL.Path != "/localapi/v0/whois" || len(r.URL.Query()) != 1 {
				invalidLookup.Store(true)
				http.Error(w, "unexpected lookup", http.StatusBadRequest)
				return
			}
			identity := r.URL.Query().Get("addr")
			if identity == hostKey.Public().String() || identity == controlKey.Public().String() {
				allowed.Add(1)
				w.Header().Set("Content-Type", "application/json")
				_, _ = io.WriteString(w, `{}`)
				return
			}
			denied.Add(1)
			http.Error(w, "peer not found", http.StatusNotFound)
		}),
	}
	apiDone := make(chan error, 1)
	go func() { apiDone <- api.Serve(listener) }()
	t.Cleanup(func() {
		if err := api.Close(); err != nil {
			t.Error("owned verifier failed to close")
		}
		select {
		case err := <-apiDone:
			if !errors.Is(err, http.ErrServerClosed) {
				t.Error("owned verifier returned an unexpected serve result")
			}
		case <-time.After(time.Second):
			t.Error("owned verifier did not join")
		}
	})
	var relayServer *derpserver.Server
	region := runLocalDERP(t, func(server *derpserver.Server) http.Handler {
		relayServer = server
		server.SetVerifyClient(true)
		server.SetTailscaledSocketPath(socket)
		return derpserver.AddWebSocketSupport(server, derpserver.Handler(server))
	})
	server, err := start(t.Context(), Config{
		DERPHosts: []string{"localhost"},
		OnConnection: func(stream ByteStream) {
			defer stream.Close()
			accepted.Add(1)
			connection, ok := stream.(net.Conn)
			if !ok || connection.SetDeadline(time.Now().Add(3*time.Second)) != nil {
				invalidControl.Store(true)
				return
			}
			var input [4]byte
			if _, err := io.ReadFull(stream, input[:]); err != nil || string(input[:]) != "ping" {
				invalidControl.Store(true)
				return
			}
			if _, err := io.WriteString(stream, "pong"); err != nil {
				invalidControl.Store(true)
			}
		},
	}, func(config Config) (backend, Relay, error) {
		created, relay, err := newBackend(config)
		if err == nil {
			real := created.(*realBackend).server
			real.Key, real.Region = hostKey, region
		}
		return created, relay, err
	})
	if err != nil {
		t.Fatal("verification fixture transport failed to start")
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		if err := server.Close(ctx); err != nil {
			t.Error("verification fixture transport failed to close")
		}
	})
	// Tailcat's first meow can precede the Host's asynchronous DERP arrival.
	// Observe the actual relay registration before making the one-shot control
	// assertion; do not retry a failed application exchange.
	ready, cancelReady := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancelReady()
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	for !relayServer.IsClientConnectedForTest(hostKey.Public()) {
		select {
		case <-ready.Done():
			t.Fatalf("verified Host did not register: allowed=%d denied=%d invalid_lookup=%t", allowed.Load(), denied.Load(), invalidLookup.Load())
		case <-ticker.C:
		}
	}
	ticker.Stop()
	cancelReady()
	address, err := server.CopyAddress()
	if err != nil {
		t.Fatal("verification fixture address unavailable")
	}
	defer eraseBytes(address)
	control := &upstream.Client{Key: controlKey, Server: upstream.Addr(address), Logf: logger.Discard}
	t.Cleanup(func() {
		if err := control.Close(); err != nil {
			t.Error("verified positive-control client failed to close")
		}
	})
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	connection, err := control.DialTCPPort(ctx, VirtualPort)
	if err != nil {
		t.Fatalf("verified positive-control connection failed: allowed=%d denied=%d invalid_lookup=%t admitted=%d canceled=%t deadline=%t", allowed.Load(), denied.Load(), invalidLookup.Load(), accepted.Load(), errors.Is(err, context.Canceled), errors.Is(err, context.DeadlineExceeded))
	}
	defer connection.Close()
	if err := connection.SetDeadline(time.Now().Add(3 * time.Second)); err != nil {
		t.Fatal("positive-control deadline unavailable")
	}
	if _, err := io.WriteString(connection, "ping"); err != nil {
		t.Fatal("positive-control write failed")
	}
	var response [4]byte
	if _, err := io.ReadFull(connection, response[:]); err != nil || string(response[:]) != "pong" {
		t.Fatal("positive-control exchange failed")
	}
	if err := connection.Close(); err != nil {
		t.Fatal("positive-control stream failed to close")
	}
	if allowed.Load() < 2 || denied.Load() != 0 || invalidLookup.Load() || invalidControl.Load() || accepted.Load() != 1 {
		t.Fatal("positive control did not prove successful relay client verification")
	}

	root := repositoryRoot(t)
	static := httptest.NewServer(http.FileServer(http.Dir(filepath.Join(root, "apps", "web", "dist"))))
	t.Cleanup(static.Close)
	request := struct {
		BaseURL  string `json:"baseURL"`
		Fragment string `json:"fragment"`
		Address  string `json:"address"`
	}{static.URL, mouseCardFragment(t, string(address), invitation.ModeEscape), string(address)}
	payload, err := json.Marshal(request)
	request.Fragment, request.Address = "", ""
	if err != nil {
		t.Fatal("verification browser input could not be encoded")
	}
	defer eraseBytes(payload)
	probe, cancelProbe := context.WithTimeout(t.Context(), 80*time.Second)
	defer cancelProbe()
	command := exec.CommandContext(probe, "node", filepath.Join(root, "tests", "integration", "tailcat", "verify-clients.mjs"))
	command.Dir, command.WaitDelay = root, 3*time.Second
	command.Stdin = bytes.NewReader(payload)
	var output bytes.Buffer
	command.Stdout, command.Stderr = &output, &output
	if err := command.Run(); err != nil {
		// The probe emits fixed classifications, never upstream/browser errors.
		message := strings.TrimSpace(output.String())
		if len(message) > 512 {
			message = message[:512]
		}
		t.Fatalf("client-verification browser probe: %v: %s", err, message)
	}
	if strings.TrimSpace(output.String()) != "client-verification browser acceptance: passed" {
		t.Fatal("client-verification browser probe emitted an invalid result")
	}
	if denied.Load() == 0 || invalidLookup.Load() || invalidControl.Load() || accepted.Load() != 1 {
		t.Fatal("unaffiliated browser was not rejected before application admission")
	}
}
