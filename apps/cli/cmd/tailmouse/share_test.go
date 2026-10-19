package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
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
	}{
		{"json receive", []string{"receive", "--json"}, "", ""},
		{"human indefinite", []string{"receive", "--ttl", "0"}, "", ""},
		{"custom relay file", []string{"receive", "--derp-map", "/synthetic/relay.json", "--derp-region", "7"}, "/synthetic/relay.json", ""},
		{"custom relay URL", []string{"receive", "--derp-map", "https://relay.example.test/map.json"}, "", "https://relay.example.test/map.json"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			fake := newFakeTransport()
			var output, diagnostic bytes.Buffer
			interrupts := make(chan os.Signal, 1)
			args := append(tc.args, t.TempDir())
			env := []string{"TAILMOUSE_FRONTEND_BASE=https://ui.example.com", "TAILMOUSE_CONTENT_BASE=https://preview.example.net"}
			code := runShare(t.Context(), nil, args, env, t.TempDir(), &output, &diagnostic, fake.start, interrupts, func() { interrupts <- os.Interrupt })
			if code != 0 || fake.closeCalls != 1 || diagnostic.Len() != 0 {
				t.Fatal("resource session failed to close cleanly", code)
			}
			if !fake.config.BindPeer || fake.config.DERPMapFile != tc.expectedMap || fake.config.DERPMapURL != tc.expectedURL {
				t.Fatal("resource transport lost its peer or relay boundary")
			}
			if tc.name == "json receive" {
				decoder := json.NewDecoder(&output)
				for _, name := range []string{"share.created", "share.ready", "share.closed"} {
					var event map[string]any
					if decoder.Decode(&event) != nil || event["event"] != name {
						t.Fatal("structured lifecycle ordering changed")
					}
					if name == "share.created" {
						url, ok := event["url"].(string)
						if !ok || !strings.HasPrefix(url, "https://s-") {
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
			code := runShare(t.Context(), nil, []string{"receive", t.TempDir()}, []string{"TAILMOUSE_CONTENT_BASE=https://preview.example.net"}, t.TempDir(), writer, &diagnostic, starter, interrupts, func() { interrupts <- os.Interrupt })
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
