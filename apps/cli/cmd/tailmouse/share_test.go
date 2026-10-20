package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"runtime"
	"strings"
	tailcattransport "tailmouse/apps/cli/internal/transport/tailcat"
	"testing"
)

func TestResourceJSONErrorsAreRedactedAndStructured(t *testing.T) {
	for _, args := range [][]string{{"cli", "--json"}, {"receive", "--json", "/absent/private-receive"}} {
		var output, diagnostic bytes.Buffer
		code := run(t.Context(), nil, args, nil, t.TempDir(), &output, &diagnostic, startTailcat)
		if code == 0 {
			t.Fatal("invalid command accepted")
		}
		var event struct{ Event, Code string }
		if json.Unmarshal(output.Bytes(), &event) != nil || event.Event != "share.error" || event.Code == "" {
			t.Fatal("structured failure missing")
		}
		if strings.Contains(output.String()+diagnostic.String(), "private-receive") {
			t.Fatal("private path leaked")
		}
	}
}

func TestResourceStartupLifetimeAndTransportBoundary(t *testing.T) {
	for _, tc := range []struct {
		name        string
		args        []string
		expectedMap string
		expectedURL string
		hosted      bool
	}{
		{"json receive", []string{"receive", "--json"}, "", "", false},
		{"json web", []string{"web", "--json"}, "", "", false},
		{"json hosted web without config", []string{"web", "--json"}, "", "", true},
		{"human indefinite", []string{"web", "--ttl", "0"}, "", "", false},
		{"custom relay file", []string{"web", "--derp-map", "/synthetic/relay.json", "--derp-region", "7"}, "/synthetic/relay.json", "", false},
		{"custom relay URL", []string{"web", "--derp-map", "https://relay.example.test/map.json"}, "", "https://relay.example.test/map.json", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if tc.args[0] == "receive" && runtime.GOOS != "linux" && runtime.GOOS != "darwin" {
				t.Skip("Receive requires private Unix staging; Web covers the common lifecycle on this platform")
			}
			fake := newFakeTransport()
			var output, diagnostic bytes.Buffer
			interrupts := make(chan os.Signal, 1)
			target := t.TempDir()
			if tc.args[0] == "web" {
				app := httptest.NewServer(http.NotFoundHandler())
				defer app.Close()
				target = app.URL
			}
			args := append(tc.args, target)
			env := []string{"TAILMOUSE_FRONTEND_BASE=https://ui.example.com", "TAILMOUSE_CONTENT_BASE=https://preview.example.net"}
			if tc.hosted {
				env = nil
			}
			code := runShare(t.Context(), nil, args, env, t.TempDir(), &output, &diagnostic, fake.start, interrupts, func() { interrupts <- os.Interrupt })
			if code != 0 || fake.closeCalls != 1 || diagnostic.Len() != 0 {
				t.Fatal("resource session failed to close cleanly", code)
			}
			if !fake.config.BindPeer || fake.config.DERPMapFile != tc.expectedMap || fake.config.DERPMapURL != tc.expectedURL {
				t.Fatal("resource transport lost its peer or relay boundary")
			}
			if strings.HasPrefix(tc.name, "json ") {
				decoder := json.NewDecoder(&output)
				for _, name := range []string{"share.created", "share.ready", "share.closed"} {
					var event map[string]any
					if decoder.Decode(&event) != nil || event["event"] != name {
						t.Fatal("structured lifecycle ordering changed")
					}
					if name == "share.created" {
						url, ok := event["url"].(string)
						prefix := "https://s-"
						if tc.hosted {
							prefix = "https://tailmouse.com/.tailmouse/workspace/#"
						}
						if !ok || !strings.HasPrefix(url, prefix) {
							t.Fatal("sharing surface missing")
						}
					} else if len(event) != 1 {
						t.Fatal("lifecycle leaked invitation fields")
					}
				}
			} else if tc.name == "human indefinite" && (!strings.Contains(output.String(), "NO EXPIRATION")) {
				t.Fatal("permission or indefinite-lifetime warning missing")
			}
		})
	}
}
func TestResourceStartupFailuresPreserveRootAndRedactDetails(t *testing.T) {
	app := httptest.NewServer(http.NotFoundHandler())
	defer app.Close()
	for _, tc := range []struct {
		name                        string
		startErr, copyErr, closeErr error
		badWriter                   bool
		want                        int
	}{
		{"transport start", errors.New("private transport material"), nil, nil, false, 4},
		{"address unavailable", nil, errors.New("private transport material"), nil, false, 4},
		{"output failed", nil, nil, nil, true, 6},
		{"close failed", nil, nil, errors.New("private transport material"), false, 4},
		{"output root survives close", nil, nil, errors.New("private transport material"), true, 6},
	} {
		t.Run(tc.name, func(t *testing.T) {
			fake := newFakeTransport()
			fake.copyErr = tc.copyErr
			fake.closeErr = tc.closeErr
			var output, diagnostic bytes.Buffer
			var writer io.Writer = &output
			if tc.badWriter {
				writer = failingWriter{}
			}
			starter := fake.start
			if tc.startErr != nil {
				starter = func(context.Context, tailcattransport.Config) (transportServer, error) { return nil, tc.startErr }
			}
			interrupts := make(chan os.Signal, 1)
			code := runShare(t.Context(), nil, []string{"web", app.URL}, []string{"TAILMOUSE_CONTENT_BASE=https://preview.example.net"}, t.TempDir(), writer, &diagnostic, starter, interrupts, func() { interrupts <- os.Interrupt })
			if code != tc.want || strings.Contains(output.String()+diagnostic.String(), "private transport material") {
				t.Fatal("root status or redaction changed", code)
			}
			if tc.startErr == nil && fake.closeCalls != 1 {
				t.Fatal("failure leaked transport")
			}
		})
	}
}
func TestResourceHelpAndApprovalRejectBeforeTransport(t *testing.T) {
	for _, tc := range []struct {
		args   []string
		writer io.Writer
		want   int
	}{
		{[]string{"receive", "--help"}, io.Discard, 0},
		{[]string{"receive", "--help"}, failingWriter{}, 6},
		{[]string{"receive", "--approval", "manual", "/synthetic"}, io.Discard, 2},
		{[]string{"web", "192.0.2.1:8080"}, io.Discard, 5},
	} {
		called := false
		starter := func(context.Context, tailcattransport.Config) (transportServer, error) {
			called = true
			return nil, errors.New("must not start")
		}
		code := runShare(t.Context(), nil, tc.args, []string{"TAILMOUSE_CONTENT_BASE=https://preview.example.net"}, t.TempDir(), tc.writer, io.Discard, starter, nil, func() {})
		if called || code != tc.want {
			t.Fatal("prerequisite did not fail before network startup", code)
		}
	}
}
