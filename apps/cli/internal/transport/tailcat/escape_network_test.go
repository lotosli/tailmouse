//go:build tailcatintegration

package tailcat

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"tailmouse/apps/cli/internal/escape"
	"tailmouse/apps/cli/internal/invitation"
	"tailmouse/apps/cli/internal/session"
)

// Every PRD 17.5 latency/jitter/loss/bandwidth combination is exercised. A
// separate profile covers the explicit PRD 8.12 150/30 responsiveness case.
func TestEscapeNetworkMatrix(t *testing.T) {
	index := 0
	for _, rtt := range []int{20, 80, 150, 300} {
		for _, jitter := range []int{0, 20, 60} {
			for _, loss := range []int{0, 1, 5} {
				for _, bandwidth := range []int{64, 256, 1024} {
					profile := impairmentProfile{RTTMS: rtt, JitterMS: jitter, Loss: loss, Kbit: bandwidth}
					name := fmt.Sprintf("rtt%d-jitter%d-loss%d-kbit%d", rtt, jitter, loss, bandwidth)
					layout := escape.MapNames()[index%5]
					index++
					t.Run(name, func(t *testing.T) { testEscapeNetwork(t, profile, layout, "matrix") })
				}
			}
		}
	}
	t.Run("rtt150-jitter30-loss0-kbit256", func(t *testing.T) {
		testEscapeNetwork(t, impairmentProfile{RTTMS: 150, JitterMS: 30, Kbit: 256}, "courtyard", "matrix")
	})
}

func TestEscapeNetworkOutages(t *testing.T) {
	for _, duration := range []int{300, 3000, 31000} {
		t.Run(fmt.Sprintf("pause-%d", duration), func(t *testing.T) {
			testEscapeNetwork(t, impairmentProfile{RTTMS: 80, JitterMS: 20, Kbit: 256}, "switchbacks", fmt.Sprintf("pause-%d", duration))
		})
	}
	t.Run("fresh-stream-reconnect", func(t *testing.T) {
		testEscapeNetwork(t, impairmentProfile{RTTMS: 80, JitterMS: 20, Kbit: 256}, "switchbacks", "reconnect")
	})
}

func TestEscapeNetworkRelayDisconnect(t *testing.T) {
	testEscapeNetwork(t, impairmentProfile{RTTMS: 80, JitterMS: 20, Kbit: 256}, "switchbacks", "relay-disconnect")
}

func testEscapeNetwork(t *testing.T, profile impairmentProfile, layout, scenario string) {
	t.Helper()
	link := &relayImpairment{}
	link.configure(profile)
	region := runLocalDERP(t, link.handler)
	host, err := session.NewHost(t.Context(), session.Config{
		Mode: "escape", TTL: 5 * time.Minute, ReconnectGrace: 30 * time.Second,
		SessionID: [16]byte{1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16},
	}, time.Now(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := host.ConfigureEscape(session.EscapeConfig{
		Map: layout, Seed: 42, Round: 45 * time.Second, Control: "touch", PhoneRender: true, ShowNet: true,
	}); err != nil {
		t.Fatal(err)
	}
	var streamMu sync.Mutex
	var activeStream ByteStream
	server, err := start(t.Context(), Config{
		DERPHosts: []string{"localhost"}, DERPRegion: 900,
		OnConnection: func(stream ByteStream) {
			streamMu.Lock()
			activeStream = stream
			streamMu.Unlock()
			host.Accept(stream)
		},
	}, func(config Config) (backend, Relay, error) {
		created, relay, err := newBackend(config)
		if err == nil {
			created.(*realBackend).server.Region = region
		}
		return created, relay, err
	})
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan session.Outcome, 1)
	t.Cleanup(func() {
		hostStarted := time.Now()
		hostErr := host.Close("local_revoke")
		if time.Since(hostStarted) > 3*time.Second {
			t.Error("impaired application cleanup exceeded its deadline")
		}
		if hostErr != nil {
			// Deliberate loss can prevent the final application CLOSE/EOF from
			// arriving too. A reported timeout must still revoke and join; it
			// is not evidence of a graceful close. Loss-free cases remain strict.
			if hostErr == session.ErrShutdown && profile.Loss > 0 {
				t.Log("application cleanup: reported bounded shutdown failure; streams joined")
			} else if !t.Failed() {
				t.Error("impaired application host cleanup failed unexpectedly")
			}
		}
		state := host.Authority.Inspect(time.Now())
		if (state.State != session.Closed && state.State != session.Expired) || state.Owner != 0 || len(host.Authority.Capabilities()) != 0 {
			t.Error("impaired application cleanup retained session authority")
		}
		if err := host.Close("local_revoke"); err != hostErr {
			t.Error("repeated impaired application close changed its outcome")
		}
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		started := time.Now()
		closeErr := server.Close(ctx)
		// PRD 12's drain deadline still applies when the final encrypted TCP
		// ACK is lost. Verify the reported timeout AND complete resource and
		// credential cleanup, not an impossible guarantee of ACK delivery.
		if time.Since(started) > 3*time.Second {
			t.Error("impaired transport cleanup exceeded its deadline")
		}
		if closeErr != nil {
			if errors.Is(closeErr, ErrDrain) && !errors.Is(closeErr, ErrClose) {
				t.Log("transport cleanup: reported bounded drain timeout; backend closed")
			} else if !t.Failed() {
				t.Error("impaired transport backend failed to close")
			}
		}
		if _, err := server.CopyAddress(); !errors.Is(err, ErrClosed) {
			t.Error("closed impaired transport retained invitation access")
		}
		if err := server.Close(ctx); err != closeErr {
			t.Error("repeated impaired close changed its recorded outcome")
		}
		select {
		case <-done:
		case <-time.After(time.Second):
			t.Error("impaired host wait did not stop")
		}
	})
	if err := host.Listen("custom-host", "localhost", time.Now()); err != nil {
		t.Fatal(err)
	}
	go func() { done <- host.Wait(t.Context()) }()
	root := repositoryRoot(t)
	mux := http.NewServeMux()
	mux.Handle("/", http.FileServer(http.Dir(filepath.Join(root, "apps", "web", "dist"))))
	// These endpoints exist only in the Go integration process, never the PWA
	// or release executable. Observations are explicit credential-free values.
	mux.HandleFunc("GET /__test/state", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		_ = json.NewEncoder(w).Encode(struct {
			View    session.EscapeView     `json:"view"`
			Metrics session.Metrics        `json:"metrics"`
			Network [2]impairmentDirection `json:"network"`
			NowMS   int64                  `json:"nowMS"`
		}{host.InspectEscapeView(), host.InspectMetrics(), link.inspect(), time.Now().UnixMilli()})
	})
	for _, duration := range []time.Duration{300 * time.Millisecond, 3 * time.Second, 31 * time.Second} {
		mux.HandleFunc(fmt.Sprintf("POST /__test/pause/%d", duration.Milliseconds()), func(w http.ResponseWriter, r *http.Request) {
			link.pause(duration)
			w.WriteHeader(http.StatusNoContent)
		})
	}
	mux.HandleFunc("POST /__test/disconnect", func(w http.ResponseWriter, r *http.Request) {
		streamMu.Lock()
		stream := activeStream
		streamMu.Unlock()
		if stream == nil {
			http.Error(w, "No active test stream", http.StatusConflict)
			return
		}
		_ = stream.Close()
		w.WriteHeader(http.StatusNoContent)
	})
	mux.HandleFunc("POST /__test/disconnect-relay", func(w http.ResponseWriter, r *http.Request) {
		if err := link.disconnect(); err != nil {
			http.Error(w, "Test DERP transport disconnect failed", http.StatusConflict)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	})
	static := httptest.NewServer(mux)
	t.Cleanup(static.Close)
	address, err := server.CopyAddress()
	if err != nil {
		t.Fatal(err)
	}
	defer eraseBytes(address)
	request := struct {
		BaseURL  string            `json:"baseURL"`
		Fragment string            `json:"fragment"`
		Profile  impairmentProfile `json:"profile"`
		Scenario string            `json:"scenario"`
	}{static.URL, mouseCardFragment(t, string(address), invitation.ModeEscape), profile, scenario}
	payload, err := json.Marshal(request)
	request.Fragment = ""
	if err != nil {
		t.Fatal(err)
	}
	defer eraseBytes(payload)
	node, err := exec.LookPath("node")
	if err != nil {
		t.Fatal("node is required for Escape network acceptance")
	}
	ctx, cancel := context.WithTimeout(t.Context(), 90*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, node, filepath.Join(root, "tests", "integration", "tailcat", "escape-network.mjs"))
	command.Dir, command.Stdin, command.WaitDelay = root, bytes.NewReader(payload), 3*time.Second
	var output bytes.Buffer
	command.Stdout, command.Stderr = &output, &output
	if err := command.Run(); err != nil {
		// The probe emits only fixed stages/codes and allowlisted measurements.
		t.Fatalf("Escape network probe failed: %v: %.2048s", err, output.String())
	}
	if !strings.Contains(output.String(), "escape network acceptance: passed") {
		t.Fatal("Escape network probe omitted its completion evidence")
	}
	t.Log(strings.TrimSpace(output.String()))
}
