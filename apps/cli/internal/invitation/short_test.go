package invitation

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"reflect"
	"strings"
	"testing"
	"testing/synctest"
	"time"

	"github.com/skip2/go-qrcode"
)

type shortRoundTrip func(*http.Request) (*http.Response, error)

func (roundTrip shortRoundTrip) RoundTrip(request *http.Request) (*http.Response, error) {
	return roundTrip(request)
}

func shortResponse(status int, body string) *http.Response {
	return &http.Response{StatusCode: status, Header: http.Header{"Cache-Control": {"no-store"}, "Content-Type": {"application/json"}}, Body: io.NopCloser(strings.NewReader(body))}
}

func shortFixture(t *testing.T) (*Invitation, string) {
	t.Helper()
	card := validTestCard(t, ModeLeash)
	card.ExpiresAt = 0
	value, err := New(OfficialWebBase, card)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(value.Erase)
	return value, string(value.url)
}

func TestShortSelection(t *testing.T) {
	for _, mode := range []Mode{ModeLeash, ModeLeash} {
		for _, noPassword := range []bool{false, true} {
			for _, base := range []string{OfficialWebBase, strings.TrimSuffix(OfficialWebBase, "/"), "http://link.tailmouse.com/", "https://link.tailmouse.com/app/", "https://mouse.example/", "https://link.tailmouse.com:444/", "https://link.tailmouse.com/?x=y", "https://user@link.tailmouse.com/"} {
				want := mode == ModeLeash && !noPassword && (base == OfficialWebBase || base+"/" == OfficialWebBase)
				if UsesShortInvitation(mode, noPassword, base) != want {
					t.Fatal("short selection changed a mode, access, or origin boundary")
				}
			}
		}
	}
}

func TestShortOperationsRetainOnlyApprovedSecrets(t *testing.T) {
	value, full := shortFixture(t)
	token := base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{0x73}, 32))
	now := time.Unix(1_800_000_000, 0)
	var calls []string
	client := NewShortClient(shortRoundTrip(func(request *http.Request) (*http.Response, error) {
		calls = append(calls, request.Method)
		if request.URL.Scheme != "https" || request.URL.Host != "link.tailmouse.com" || request.URL.RawQuery != "" || request.URL.Fragment != "" || request.Header.Get("Cache-Control") != "no-store" {
			t.Fatal("request escaped the official HTTPS boundary")
		}
		deadline, ok := request.Context().Deadline()
		if !ok || time.Until(deadline) > 10*time.Second {
			t.Fatal("request lacks bounded timeout")
		}
		body, err := io.ReadAll(request.Body)
		if err != nil {
			t.Fatal(err)
		}
		defer clear(body)
		if request.Method == http.MethodPost {
			fields, err := strictFields(body, []string{"invitation", "access"})
			if err != nil || string(fields["access"]) != `"code"` || request.Header.Get("Authorization") != "" {
				t.Fatal("publication sent unauthorized fields or a management capability")
			}
			var received string
			if json.Unmarshal(fields["invitation"], &received) != nil || received != full {
				t.Fatal("publication changed the invitation")
			}
			return shortResponse(201, fmt.Sprintf(`{"code":"T6wxZ8","managementToken":%q,"expiresAt":%d}`, token, now.Add(shortLeaseDuration).UnixMilli())), nil
		}
		if request.URL.Path != "/api/v1/short-invitations/T6wxZ8" || len(body) != 0 {
			t.Fatal("operation changed locator case or sent a body")
		}
		if request.Method == http.MethodGet {
			if request.Header.Get("Authorization") != "" {
				t.Fatal("resolution sent management authority")
			}
			return shortResponse(200, fmt.Sprintf(`{"invitation":%q,"expiresAt":%d}`, full, now.Add(shortLeaseDuration).UnixMilli())), nil
		}
		if request.Header.Get("Authorization") != "Bearer "+token {
			t.Fatal("management capability not isolated in the authorization header")
		}
		if request.Method == http.MethodPut {
			return shortResponse(200, fmt.Sprintf(`{"expiresAt":%d}`, now.Add(shortLeaseDuration).UnixMilli())), nil
		}
		return shortResponse(204, ""), nil
	}))
	client.now = func() time.Time { return now }
	retained := value.url
	lease, err := client.Publish(t.Context(), value)
	if err != nil {
		t.Fatal(err)
	}
	if !allZero(retained) || string(value.url) != OfficialWebBase+"T6wxZ8" {
		t.Fatal("publication did not erase the full presentation")
	}
	for _, format := range []string{"%v", "%+v", "%#v"} {
		if strings.Contains(fmt.Sprintf(format, lease), token) {
			t.Fatal("lease formatting leaked its capability")
		}
	}
	var output bytes.Buffer
	if err := value.Render(&output, now, DisplayOptions{Relay: "official", AccessMode: "code", NoQR: true}); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(output.String(), full) || strings.Contains(output.String(), token) || strings.Count(output.String(), "Open: "+OfficialWebBase+"T6wxZ8") != 1 || !strings.Contains(output.String(), "Cloudflare temporarily stores") {
		t.Fatal("short presentation boundary is incorrect")
	}
	resolved, err := client.Resolve(t.Context(), "T6wxZ8")
	if err != nil || string(resolved.url) != full {
		t.Fatal("resolution changed the full invitation")
	}
	resolved.Erase()
	if err := lease.Renew(t.Context()); err != nil {
		t.Fatal(err)
	}
	retainedToken := lease.token
	if err := lease.Delete(t.Context()); err != nil {
		t.Fatal(err)
	}
	if !allZero(retainedToken) || len(lease.token) != 0 {
		t.Fatal("delete retained management bytes")
	}
	if err := lease.Delete(t.Context()); err != nil {
		t.Fatal(err)
	}
	if !errors.Is(lease.Renew(t.Context()), ErrErased) {
		t.Fatal("erased lease renewed")
	}
	if !reflect.DeepEqual(calls, []string{"POST", "GET", "PUT", "DELETE"}) {
		t.Fatal("operations were duplicated or omitted")
	}
}

func TestShortMalformedResponsesFailWithoutLeaks(t *testing.T) {
	value, full := shortFixture(t)
	now := time.Unix(1_800_000_000, 0)
	token := strings.Repeat("A", 43)
	valid := fmt.Sprintf(`{"code":"T6wxZ8","managementToken":%q,"expiresAt":%d}`, token, now.Add(shortLeaseDuration).UnixMilli())
	for _, test := range []struct {
		name   string
		status int
		body   string
		mutate func(*http.Response)
	}{
		{"bad status", 500, full, nil},
		{"redirect", 302, full, func(r *http.Response) { r.Header.Set("Location", "https://wrong.example/") }},
		{"bad content type", 201, valid, func(r *http.Response) { r.Header.Set("Content-Type", "text/plain") }},
		{"cached", 201, valid, func(r *http.Response) { r.Header.Set("Cache-Control", "public, max-age=60") }},
		{"oversized", 201, strings.Repeat("x", 2049), nil},
		{"declared oversized", 201, valid, func(r *http.Response) { r.ContentLength = 2049 }},
		{"unknown field", 201, strings.TrimSuffix(valid, "}") + `,"accessCode":"synthetic-secret"}`, nil},
		{"duplicate field", 201, strings.TrimSuffix(valid, "}") + `,"code":"A12345"}`, nil},
		{"trailing value", 201, valid + " {}", nil},
		{"bad code", 201, strings.Replace(valid, "T6wxZ8", "A/B123", 1), nil},
		{"bad token", 201, strings.Replace(valid, token, strings.Repeat("B", 43), 1), nil},
		{"missing field", 201, `{"code":"T6wxZ8"}`, nil},
		{"invalid json", 201, "[", nil},
		{"broken field", 201, `{"code":}`, nil},
		{"truncated object", 201, `{"code":"T6wxZ8"`, nil},
	} {
		t.Run(test.name, func(t *testing.T) {
			calls := 0
			client := NewShortClient(shortRoundTrip(func(*http.Request) (*http.Response, error) {
				calls++
				response := shortResponse(test.status, test.body)
				if test.mutate != nil {
					test.mutate(response)
				}
				return response, nil
			}))
			client.now = func() time.Time { return now }
			lease, err := client.Publish(t.Context(), value)
			if err == nil || lease != nil || calls != 1 || strings.Contains(err.Error(), full) || strings.Contains(err.Error(), token) || string(value.url) != full {
				t.Fatal("malformed service reply changed authority or disclosed credentials")
			}
		})
	}
}

func TestShortInvalidExpiryRetainsRollbackAuthority(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	token := strings.Repeat("A", 43)
	for _, expiry := range []string{"0", fmt.Sprint(now.Add(time.Hour).UnixMilli()), fmt.Sprint(now.Add(5 * time.Minute).UnixMilli()), "1.5"} {
		t.Run(expiry, func(t *testing.T) {
			value, full := shortFixture(t)
			var calls []string
			var deletion *http.Request
			client := NewShortClient(shortRoundTrip(func(request *http.Request) (*http.Response, error) {
				calls = append(calls, request.Method)
				switch len(calls) {
				case 1:
					if request.Method != http.MethodPost {
						t.Fatal("publication did not precede rollback")
					}
					return shortResponse(201, fmt.Sprintf(`{"code":"T6wxZ8","managementToken":%q,"expiresAt":%s}`, token, expiry)), nil
				case 2:
					deletion = request
					if request.Method != http.MethodDelete || request.URL.Path != "/api/v1/short-invitations/T6wxZ8" || request.Header.Get("Authorization") != "Bearer "+token {
						t.Fatal("rollback lost authenticated deletion authority")
					}
					return shortResponse(204, ""), nil
				default:
					t.Fatal("rollback retried or renewed an invalid lease")
					return nil, ErrShortRequest
				}
			}))
			client.now = func() time.Time { return now }
			lease, err := client.Publish(t.Context(), value)
			if err != ErrShortResponse || lease == nil || !lease.expiresAt.IsZero() || string(value.url) != full || value.short || strings.Contains(err.Error(), token) || strings.Contains(err.Error(), full) {
				t.Fatal("invalid expiry changed presentation or lost rollback authority")
			}
			retainedToken := lease.token
			cleanup, cancel := context.WithTimeout(context.Background(), shortRequestTimeout)
			defer cancel()
			if cleanupErr := lease.Delete(cleanup); cleanupErr != nil {
				t.Fatal(cleanupErr)
			}
			if !reflect.DeepEqual(calls, []string{"POST", "DELETE"}) || !allZero(retainedToken) || len(lease.token) != 0 || deletion.Header.Get("Authorization") != "" {
				t.Fatal("rollback omitted deletion or retained management authority")
			}
		})
	}
}

func TestShortPublicationRollbackAfterCancellation(t *testing.T) {
	for _, outcome := range []string{"success", "failure", "timeout"} {
		t.Run(outcome, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				value, full := shortFixture(t)
				token := strings.Repeat("A", 43)
				ctx, cancel := context.WithCancel(t.Context())
				defer cancel()
				calls := 0
				client := NewShortClient(shortRoundTrip(func(request *http.Request) (*http.Response, error) {
					calls++
					if calls == 1 && request.Method == http.MethodPost {
						return shortResponse(201, fmt.Sprintf(`{"code":"T6wxZ8","managementToken":%q,"expiresAt":0}`, token)), nil
					}
					deadline, bounded := request.Context().Deadline()
					if calls != 2 || request.Method != http.MethodDelete || request.Context().Err() != nil || !bounded || time.Until(deadline) > shortRequestTimeout {
						t.Fatal("rollback reused canceled context or lacked a bounded deletion")
					}
					if outcome == "success" {
						return shortResponse(204, ""), nil
					}
					if outcome == "timeout" {
						<-request.Context().Done()
					}
					return nil, errors.New("synthetic-secret-cleanup-detail")
				}))
				lease, publicationErr := client.Publish(ctx, value)
				if publicationErr != ErrShortResponse || lease == nil {
					t.Fatal("invalid expiry lost its root failure or rollback authority")
				}
				cancel()
				retainedToken := lease.token
				cleanup, stopCleanup := context.WithTimeout(context.Background(), shortRequestTimeout)
				defer stopCleanup()
				started := time.Now()
				cleanupErr := lease.Delete(cleanup)
				if outcome == "success" && cleanupErr != nil || outcome != "success" && !errors.Is(cleanupErr, ErrShortRequest) {
					t.Fatal("rollback cleanup outcome was hidden")
				}
				if outcome == "timeout" && (!errors.Is(cleanupErr, context.DeadlineExceeded) || time.Since(started) != shortRequestTimeout) {
					t.Fatal("rollback deletion lost its exact timeout or cause")
				}
				if publicationErr != ErrShortResponse || calls != 2 || !allZero(retainedToken) || len(lease.token) != 0 || string(value.url) != full || value.short {
					t.Fatal("cleanup changed the publication failure or retained authority")
				}
				if cleanupErr != nil && (strings.Contains(cleanupErr.Error(), "synthetic-secret") || strings.Contains(cleanupErr.Error(), full) || strings.Contains(cleanupErr.Error(), token)) {
					t.Fatal("cleanup failure disclosed credentials")
				}
			})
		})
	}
}

func TestShortInvalidRequestsAndResolution(t *testing.T) {
	value, _ := shortFixture(t)
	client := NewShortClient(shortRoundTrip(func(*http.Request) (*http.Response, error) { return nil, errors.New("synthetic-secret-network-detail") }))
	if lease, err := client.Publish(t.Context(), nil); err == nil || lease != nil {
		t.Fatal("nil publication accepted")
	}
	if lease, err := client.Publish(t.Context(), testInvitation(t, ModeLeash)); err == nil || lease != nil {
		t.Fatal("nonofficial origin publication accepted")
	}
	if lease, err := client.Publish(t.Context(), value); !errors.Is(err, ErrShortRequest) || lease != nil || strings.Contains(err.Error(), "synthetic-secret") {
		t.Fatal("network error escaped redaction")
	}
	if _, err := client.Resolve(t.Context(), "x/1234"); !errors.Is(err, ErrShortRequest) {
		t.Fatal("unsafe code accepted")
	}
	for _, body := range []string{`{"invitation":"https://wrong.example/#/v1/a","expiresAt":1800000900000}`, `{"invitation":12,"expiresAt":1800000900000}`, `{"invitation":"invalid","expiresAt":0}`} {
		client.http.Transport = shortRoundTrip(func(*http.Request) (*http.Response, error) { return shortResponse(200, body), nil })
		client.now = func() time.Time { return time.Unix(1_800_000_000, 0) }
		if invitation, err := client.Resolve(t.Context(), "T6wxZ8"); !errors.Is(err, ErrShortResponse) || invitation != nil {
			t.Fatal("invalid resolution accepted")
		}
	}
	//lint:ignore SA1012 Deliberately verify rejection of a nil caller context.
	if _, err := client.request(nil, "POST", "", nil, nil, 201); !errors.Is(err, ErrShortRequest) {
		t.Fatal("nil context accepted")
	}
	if _, err := client.request(t.Context(), "POST", "", nil, make([]byte, 2049), 201); !errors.Is(err, ErrShortRequest) {
		t.Fatal("oversized request accepted")
	}
	client.http.Transport = shortRoundTrip(func(*http.Request) (*http.Response, error) { return shortResponse(204, "unexpected"), nil })
	if _, err := client.request(t.Context(), "DELETE", "", nil, nil, 204); !errors.Is(err, ErrShortResponse) {
		t.Fatal("delete body accepted")
	}
}

func TestShortTimeoutCancellationAndLeaseSchedule(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		client := NewShortClient(shortRoundTrip(func(request *http.Request) (*http.Response, error) {
			<-request.Context().Done()
			return nil, errors.New("synthetic-secret")
		}))
		started := time.Now()
		if _, err := client.Resolve(t.Context(), "T6wxZ8"); !errors.Is(err, context.DeadlineExceeded) || time.Since(started) != 10*time.Second {
			t.Fatal("HTTP request exceeded or missed its exact timeout")
		}
		ctx, cancel := context.WithCancel(t.Context())
		cancel()
		if _, err := client.Resolve(ctx, "T6wxZ8"); !errors.Is(err, context.Canceled) {
			t.Fatal("request cancellation lost its cause")
		}
	})
	for _, successful := range []bool{false, true} {
		t.Run(fmt.Sprint(successful), func(t *testing.T) {
			now := time.Unix(1_800_000_000, 0)
			attempts := 0
			var waits []time.Duration
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			client := NewShortClient(shortRoundTrip(func(*http.Request) (*http.Response, error) {
				attempts++
				if successful && attempts == 2 {
					return shortResponse(200, fmt.Sprintf(`{"expiresAt":%d}`, now.Add(shortLeaseDuration).UnixMilli())), nil
				}
				if attempts == 1 {
					return nil, errors.New("synthetic-first-secret")
				}
				return shortResponse(400, "synthetic-later-secret"), nil
			}))
			client.now = func() time.Time { return now }
			client.wait = func(ctx context.Context, duration time.Duration) error {
				waits = append(waits, duration)
				now = now.Add(duration)
				if successful && len(waits) == 3 {
					cancel()
					return ctx.Err()
				}
				return nil
			}
			lease := &ShortLease{client: client, code: "T6wxZ8", token: []byte(strings.Repeat("A", 43)), expiresAt: now.Add(shortLeaseDuration)}
			err := lease.Maintain(ctx)
			if successful {
				if !errors.Is(err, context.Canceled) || attempts != 2 || !reflect.DeepEqual(waits, []time.Duration{5 * time.Minute, 30 * time.Second, 5 * time.Minute}) {
					t.Fatal("successful retry failed to resume the five-minute schedule")
				}
			} else {
				if !errors.Is(err, ErrShortRequest) || attempts != 3 || !reflect.DeepEqual(waits, []time.Duration{5 * time.Minute, 30 * time.Second, time.Minute}) {
					t.Fatal("renewal retries lost the first failure or exceeded their attempt budget")
				}
			}
		})
	}
}

func TestShortLeaseSafetyAndCleanupFailure(t *testing.T) {
	for _, remaining := range []time.Duration{5 * time.Minute, 6*time.Minute + 20*time.Second} {
		now := time.Unix(1_800_000_000, 0)
		attempts := 0
		client := NewShortClient(shortRoundTrip(func(*http.Request) (*http.Response, error) { attempts++; return nil, errors.New("synthetic-secret") }))
		client.now = func() time.Time { return now }
		client.wait = func(ctx context.Context, duration time.Duration) error { now = now.Add(duration); return nil }
		lease := &ShortLease{client: client, code: "T6wxZ8", token: []byte(strings.Repeat("A", 43)), expiresAt: now.Add(remaining)}
		err := lease.Maintain(t.Context())
		if err == nil || attempts > 1 {
			t.Fatal("unsafe lease renewed or retried beyond its safety deadline")
		}
		retained := lease.token
		if err := lease.Delete(t.Context()); !errors.Is(err, ErrShortRequest) || !allZero(retained) {
			t.Fatal("failed delete retained the capability or hid its error")
		}
	}
	client := NewShortClient(nil)
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if err := client.wait(ctx, time.Hour); !errors.Is(err, context.Canceled) {
		t.Fatal("renewal wait ignored cancellation")
	}
}

func decodeTerminalBitmap(t *testing.T, rendered string) [][]bool {
	t.Helper()
	var result [][]bool
	for _, line := range strings.Split(strings.TrimSuffix(rendered, "\n"), "\n") {
		if !strings.HasPrefix(line, "\x1b[30;47m") || !strings.HasSuffix(line, "\x1b[0m") {
			t.Fatal("QR row did not set monochrome colors and restore ANSI")
		}
		line = strings.TrimSuffix(strings.TrimPrefix(line, "\x1b[30;47m"), "\x1b[0m")
		var top, bottom []bool
		for _, value := range line {
			switch value {
			case ' ':
				top = append(top, false)
				bottom = append(bottom, false)
			case '▀':
				top = append(top, true)
				bottom = append(bottom, false)
			case '▄':
				top = append(top, false)
				bottom = append(bottom, true)
			case '█':
				top = append(top, true)
				bottom = append(bottom, true)
			default:
				t.Fatal("QR renderer used an unexpected terminal glyph")
			}
		}
		result = append(result, top, bottom)
	}
	// A square QR has odd dimension; the final half-row is white padding.
	if len(result) == len(result[0])+1 {
		for _, dark := range result[len(result)-1] {
			if dark {
				t.Fatal("QR odd-row padding is not white")
			}
		}
		result = result[:len(result)-1]
	}
	return result
}

func TestCompactQRUsesSmallestSymbolAndExactTerminalModules(t *testing.T) {
	for _, source := range []string{"a", OfficialWebBase + "T6wxZ8", string(testInvitation(t, ModeLeash).url)} {
		bitmap, err := qrBitmap([]byte(source))
		if err != nil {
			t.Fatal(err)
		}
		version := (len(bitmap) - 17) / 4
		if version > 1 {
			if _, err := qrcode.NewWithForcedVersion(source, version-1, qrcode.Medium); err == nil {
				t.Fatal("QR encoder chose a larger symbol than required")
			}
		}
		assertQRFormatM(t, bitmap)
		withBorder := addQuietZone(bitmap)
		var rendered bytes.Buffer
		writeTerminalQR(&rendered, withBorder)
		decoded := decodeTerminalBitmap(t, rendered.String())
		if !reflect.DeepEqual(decoded, withBorder) {
			t.Fatal("terminal half-block rendering changed QR modules or quiet zone")
		}
		if strings.Count(rendered.String(), "\n") != (len(withBorder)+1)/2 {
			t.Fatal("terminal QR was not packed two module rows per line")
		}
	}
}
