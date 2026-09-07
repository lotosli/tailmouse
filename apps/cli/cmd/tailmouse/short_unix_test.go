//go:build darwin || linux

package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"sync"
	"syscall"
	"testing"
	"testing/synctest"
	"time"

	"tailmouse/apps/cli/internal/config"
	"tailmouse/apps/cli/internal/invitation"
	"tailmouse/apps/cli/internal/leash"
)

func TestOfficialShortCLIRenewalRevokesBeforeExpiry(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		output, err := os.OpenFile(os.DevNull, os.O_WRONLY, 0)
		if err != nil {
			t.Fatal(err)
		}
		defer output.Close()
		options, _, err := config.Resolve([]string{"leash", "--no-qr", "--json", "--start-on=connect", "--", "unused-command"}, nil, t.TempDir())
		if err != nil {
			t.Fatal(err)
		}
		command, err := leash.NewCommand(options.Leash.Argv, t.TempDir(), "", nil, nil)
		if err != nil {
			t.Fatal(err)
		}
		var diagnostics bytes.Buffer
		fake := newFakeTransport()
		fake.closeErr = errors.New("synthetic-secret-transport-cleanup")
		var requests []string
		started := time.Now()
		expiresAt := started.Add(15 * time.Minute)
		client := invitation.NewShortClient(shortCLITransport(func(request *http.Request) (*http.Response, error) {
			requests = append(requests, request.Method)
			if request.Method == http.MethodPost {
				return &http.Response{StatusCode: 201, Header: http.Header{"Cache-Control": {"no-store"}, "Content-Type": {"application/json"}}, Body: io.NopCloser(strings.NewReader(fmt.Sprintf(`{"code":"T6wxZ8","managementToken":%q,"expiresAt":%d}`, strings.Repeat("A", 43), expiresAt.UnixMilli())))}, nil
			}
			if request.Method == http.MethodDelete {
				if !time.Now().Before(expiresAt.Add(-time.Minute)) {
					t.Fatal("Host deletion crossed the lease safety deadline")
				}
				return nil, errors.New("synthetic-secret-delete")
			}
			return nil, errors.New("synthetic-secret-first-renewal")
		}))
		code := runSessionWithShortClient(t.Context(), nil, options, command, &credentialTerminal{output: output}, output, &diagnostics, fake.start, nil, func() {}, client)
		if code != exitInvitation || fake.closeCalls != 1 || strings.Join(requests, ",") != "POST,PUT,PUT,PUT,DELETE" || time.Since(started) != 6*time.Minute+30*time.Second {
			t.Fatal("renewal failure did not revoke once within its bounded retry window")
		}
		if !strings.Contains(diagnostics.String(), `"reason":"short_invitation_renewal"`) || !strings.Contains(diagnostics.String(), "short_invitation_delete") || strings.Contains(diagnostics.String(), "synthetic-secret") {
			t.Fatal("renewal root cause was hidden, replaced, or disclosed sensitive detail")
		}
	})
}

func TestOfficialShortCLIJoinsCanceledRenewalBeforeDelete(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		output, err := os.OpenFile(os.DevNull, os.O_WRONLY, 0)
		if err != nil {
			t.Fatal(err)
		}
		defer output.Close()
		options, _, err := config.Resolve([]string{"leash", "--no-qr", "--start-on=connect", "--", "unused-command"}, nil, t.TempDir())
		if err != nil {
			t.Fatal(err)
		}
		command, err := leash.NewCommand(options.Leash.Argv, t.TempDir(), "", nil, nil)
		if err != nil {
			t.Fatal(err)
		}
		ctx, cancel := context.WithCancel(t.Context())
		defer cancel()
		time.AfterFunc(5*time.Minute+5*time.Second, cancel)
		renewalFinished := false
		deleted := false
		client := invitation.NewShortClient(shortCLITransport(func(request *http.Request) (*http.Response, error) {
			switch request.Method {
			case http.MethodPost:
				return &http.Response{StatusCode: 201, Header: http.Header{"Cache-Control": {"no-store"}, "Content-Type": {"application/json"}}, Body: io.NopCloser(strings.NewReader(fmt.Sprintf(`{"code":"T6wxZ8","managementToken":%q,"expiresAt":%d}`, strings.Repeat("A", 43), time.Now().Add(15*time.Minute).UnixMilli())))}, nil
			case http.MethodPut:
				<-request.Context().Done()
				renewalFinished = true
				return nil, request.Context().Err()
			case http.MethodDelete:
				if !renewalFinished || request.Context().Err() != nil {
					t.Fatal("cleanup raced renewal or reused a canceled request context")
				}
				deleted = true
				return &http.Response{StatusCode: 204, Header: http.Header{"Cache-Control": {"no-store"}}, Body: io.NopCloser(strings.NewReader(""))}, nil
			default:
				t.Fatal("unexpected short request")
				return nil, errors.New("unexpected request")
			}
		}))
		var diagnostics bytes.Buffer
		fake := newFakeTransport()
		code := runSessionWithShortClient(ctx, nil, options, command, &credentialTerminal{output: output}, output, &diagnostics, fake.start, nil, func() {}, client)
		if code != exitExpired || !deleted || strings.Contains(diagnostics.String(), "short_invitation_renewal") {
			t.Fatal("cancellation replaced the owner outcome or omitted deletion")
		}
	})
}

type shortCLITransport func(*http.Request) (*http.Response, error)

func (transport shortCLITransport) RoundTrip(request *http.Request) (*http.Response, error) {
	return transport(request)
}

func TestOfficialShortCLIPublicationAndCleanup(t *testing.T) {
	for _, test := range []struct {
		name                                                                 string
		flags                                                                []string
		publicationFails, deletionFails, displayFails, signal, invalidExpiry bool
		want                                                                 int
	}{
		{name: "publication failure before child", flags: []string{"--start-on=now"}, publicationFails: true, want: exitInvitation},
		{name: "invalid expiry rollback before child", flags: []string{"--start-on=now"}, invalidExpiry: true, want: exitInvitation},
		{name: "invalid expiry preserves root on delete failure", flags: []string{"--start-on=now"}, invalidExpiry: true, deletionFails: true, want: exitInvitation},
		{name: "normal post-exit completion", flags: []string{"--start-on=now", "--post-exit-ttl=1ms"}, want: 7},
		{name: "delete failure preserves child", flags: []string{"--start-on=now", "--post-exit-ttl=1ms"}, deletionFails: true, want: 7},
		{name: "once completion", flags: []string{"--start-on=now", "--once"}, want: 7},
		{name: "expiry while waiting", flags: []string{"--start-on=connect", "--ttl=1100ms"}, want: exitExpired},
		{name: "signal revocation", flags: []string{"--start-on=connect"}, signal: true, want: exitExpired},
		{name: "startup rollback", flags: []string{"--start-on=now"}, displayFails: true, want: exitInvitation},
	} {
		t.Run(test.name, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
			defer cancel()
			outputRead, outputWrite, err := os.Pipe()
			if err != nil {
				t.Fatal(err)
			}
			defer outputRead.Close()
			defer outputWrite.Close()
			credentialRead, credentialWrite, err := os.Pipe()
			if err != nil {
				t.Fatal(err)
			}
			defer credentialRead.Close()
			defer credentialWrite.Close()
			inputRead, inputWrite, err := os.Pipe()
			if err != nil {
				t.Fatal(err)
			}
			defer inputRead.Close()
			inputWrite.Close()
			var output, credentialOutput, diagnostics bytes.Buffer
			outputDone, credentialDone := make(chan struct{}), make(chan struct{})
			go func() { io.Copy(&output, outputRead); close(outputDone) }()
			go func() { io.Copy(&credentialOutput, credentialRead); close(credentialDone) }()
			signals := make(chan os.Signal, 1)
			var requests []string
			var requestMutex sync.Mutex
			token := base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{0x73}, 32))
			client := invitation.NewShortClient(shortCLITransport(func(request *http.Request) (*http.Response, error) {
				requestMutex.Lock()
				requests = append(requests, request.Method)
				requestMutex.Unlock()
				body, err := io.ReadAll(request.Body)
				if err != nil {
					t.Fatal(err)
				}
				defer clear(body)
				if strings.Contains(string(body), "access_code") || strings.Contains(string(body), "accessCode") {
					t.Fatal("publication sent an access code field")
				}
				if request.Method == http.MethodPost {
					var fields map[string]json.RawMessage
					if json.Unmarshal(body, &fields) != nil || len(fields) != 2 || string(fields["access"]) != `"code"` {
						t.Fatal("publication request did not have exactly its approved fields")
					}
					if test.publicationFails {
						return nil, errors.New("synthetic-secret-service-error")
					}
					expiresAt := time.Now().Add(15 * time.Minute).UnixMilli()
					if test.invalidExpiry {
						expiresAt = 0
					}
					return &http.Response{StatusCode: 201, Header: http.Header{"Cache-Control": {"no-store"}, "Content-Type": {"application/json"}}, Body: io.NopCloser(strings.NewReader(fmt.Sprintf(`{"code":"T6wxZ8","managementToken":%q,"expiresAt":%d}`, token, expiresAt)))}, nil
				}
				if request.Method != http.MethodDelete || len(body) != 0 || request.Header.Get("Authorization") != "Bearer "+token {
					t.Fatal("cleanup did not use the sole management operation")
				}
				if test.deletionFails {
					return nil, errors.New("synthetic-secret-delete-error")
				}
				return &http.Response{StatusCode: 204, Header: http.Header{"Cache-Control": {"no-store"}}, Body: io.NopCloser(strings.NewReader(""))}, nil
			}))
			args := append([]string{"leash", "--no-qr", "--json"}, test.flags...)
			args = append(args, "--", "/bin/sh", "-c", "printf 'short-test-child-started\\n'; exit 7")
			options, _, err := config.Resolve(args, nil, t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			command, err := leash.NewCommand(options.Leash.Argv, t.TempDir(), "", nil, nil)
			if err != nil {
				t.Fatal(err)
			}
			fake := newFakeTransport()
			var target io.Writer = outputWrite
			if test.displayFails {
				target = failingWriter{}
			}
			if test.signal {
				signals <- syscall.SIGTERM
			}
			code := runSessionWithShortClient(ctx, inputRead, options, command, &credentialTerminal{output: credentialWrite}, target, &diagnostics, fake.start, signals, func() {}, client)
			outputWrite.Close()
			credentialWrite.Close()
			<-outputDone
			<-credentialDone
			if code != test.want || fake.closeCalls != 1 {
				t.Fatalf("short CLI exit = %d, want %d; transport closes = %d", code, test.want, fake.closeCalls)
			}
			if test.publicationFails || test.invalidExpiry {
				wantRequests := 1
				if test.invalidExpiry {
					wantRequests = 2
				}
				if len(requests) != wantRequests || requests[0] != "POST" || (test.invalidExpiry && requests[1] != "DELETE") || output.Len() != 0 || !strings.Contains(diagnostics.String(), "short_invitation_publication") {
					t.Fatal("publication failure did not stop before child and invitation output")
				}
			} else {
				if len(requests) != 2 || requests[0] != "POST" || requests[1] != "DELETE" {
					t.Fatal("Host end did not delete exactly once")
				}
				if !test.displayFails && strings.Count(output.String(), "Open: https://link.tailmouse.com/T6wxZ8") != 1 {
					t.Fatal("CLI did not present exactly one short URL")
				}
			}
			if test.deletionFails && !strings.Contains(diagnostics.String(), "short_invitation_delete") {
				t.Fatal("cleanup failure was hidden")
			}
			credentialText := credentialOutput.String()
			prefix := "Access code  "
			index := strings.Index(credentialText, prefix)
			if index < 0 {
				t.Fatal("controlling-terminal credential was omitted")
			}
			codeText := strings.SplitN(credentialText[index+len(prefix):], "\n", 2)[0]
			for _, text := range []string{output.String(), diagnostics.String()} {
				for _, secret := range []string{codeText, token, syntheticAddress, "#/v1/", "synthetic-secret"} {
					if strings.Contains(text, secret) {
						t.Fatal("public output leaked credential or service detail")
					}
				}
			}
			if (test.publicationFails || test.invalidExpiry || test.displayFails) && strings.Contains(output.String(), "short-test-child-started") {
				t.Fatal("child started before a usable short invitation was displayed")
			}
		})
	}
}
