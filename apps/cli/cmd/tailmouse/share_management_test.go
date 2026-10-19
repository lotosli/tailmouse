//go:build darwin || linux || windows

package main

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"tailmouse/apps/cli/internal/share"
)

func TestResourceManagementCommandStreamReportsActionsAndFailures(t *testing.T) {
	app := httptest.NewServer(http.NotFoundHandler())
	defer app.Close()
	for _, tc := range []struct {
		name, keys, wantError       string
		outputFailure, publishError bool
		wantCancel                  bool
		wantRotations, unavailable  int
	}{
		{name: "menu actions", keys: "\x1da1\x1dg1\x1dx1\x1dp\x1dr\x1di\x1d\x1d\x1dq", wantCancel: true, wantRotations: 1, unavailable: 3},
		{name: "interrupt without child", keys: "\x03", wantCancel: true},
		{name: "end of input"},
		{name: "output failure", keys: "\x1d", outputFailure: true, wantError: "local output failed"},
		{name: "rotation output failure", keys: "\x1di", publishError: true, wantCancel: true, wantRotations: 1, wantError: "local invitation output failed"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
			defer cancel()
			input, keys, err := os.Pipe()
			if err != nil {
				t.Fatal(err)
			}
			defer input.Close()
			defer keys.Close()
			output, err := os.CreateTemp(t.TempDir(), "console-")
			if err != nil {
				t.Fatal(err)
			}
			defer output.Close()
			console, err := openLeashConsole(input, output)
			if err != nil {
				t.Fatal(err)
			}
			defer console.Close()
			host, initialToken, err := share.NewHost(ctx, share.Options{Command: "web", Target: app.URL, Cwd: t.TempDir(), MaxClients: 2, Approval: "manual", TTL: time.Minute}, os.Environ())
			if err != nil {
				t.Fatal(err)
			}
			defer host.Close()
			host.Ready()
			var writer io.Writer = shareConsoleWriter{console: console, ctx: ctx}
			if tc.outputFailure {
				writer = failingWriter{}
			}
			rotations, validRotation := 0, true
			done := make(chan error, 1)
			go func() {
				done <- manageShare(ctx, console, host, writer, func(token string) error {
					rotations++
					validRotation = validRotation && len(token) == 43 && token != initialToken
					if tc.publishError {
						return errors.New("synthetic private publication failure")
					}
					return nil
				}, cancel)
			}()
			if _, err := keys.Write([]byte(tc.keys)); err != nil {
				t.Fatal(err)
			}
			if err := keys.Close(); err != nil {
				t.Fatal(err)
			}
			select {
			case err = <-done:
			case <-time.After(6 * time.Second):
				t.Fatal("local management did not join within its bounded input lifetime")
			}
			message := ""
			if err != nil {
				message = err.Error()
			}
			if message != tc.wantError || rotations != tc.wantRotations || !validRotation {
				t.Fatal("local actions lost their result, redaction or invitation rotation")
			}
			if errors.Is(ctx.Err(), context.Canceled) != tc.wantCancel || errors.Is(ctx.Err(), context.DeadlineExceeded) {
				t.Fatal("local management did not preserve the requested session lifetime")
			}
			data, err := os.ReadFile(output.Name())
			if err != nil {
				t.Fatal(err)
			}
			if strings.Count(string(data), "Visitor action unavailable.") != tc.unavailable {
				t.Fatal("unavailable visitor actions were not reported")
			}
			if tc.name == "menu actions" && (!strings.Contains(string(data), "Choose visitor 1–4:") || !strings.Contains(string(data), "[q] end")) {
				t.Fatal("local console did not present its visitor and session controls")
			}
		})
	}
}
