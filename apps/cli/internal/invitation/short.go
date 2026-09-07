package invitation

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"strings"
	"time"
)

const (
	OfficialWebBase     = "https://link.tailmouse.com/"
	shortAPI            = OfficialWebBase + "api/v1/short-invitations"
	shortBodyLimit      = 2048
	shortRequestTimeout = 10 * time.Second
	shortLeaseDuration  = 15 * time.Minute
	shortRenewInterval  = 5 * time.Minute
	shortSafetyMargin   = time.Minute
)

var (
	ErrShortRequest  = errors.New("short invitation request failed")
	ErrShortResponse = errors.New("invalid short invitation response")
	ErrShortLease    = errors.New("short invitation lease cannot be preserved")
)

// ShortClient is the concrete official HTTPS boundary. The transport argument
// exists for deterministic HTTP tests; neither origin nor policy is configurable.
type ShortClient struct {
	http http.Client
	now  func() time.Time
	wait func(context.Context, time.Duration) error
}

func NewShortClient(transport http.RoundTripper) *ShortClient {
	return &ShortClient{
		http: http.Client{Transport: transport, Timeout: shortRequestTimeout,
			CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }},
		now: time.Now,
		wait: func(ctx context.Context, duration time.Duration) error {
			timer := time.NewTimer(duration)
			defer timer.Stop()
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-timer.C:
				return nil
			}
		},
	}
}

// UsesShortInvitation is product selection, not authentication. Host access
// policy remains authoritative and the access code is never an API input.
func UsesShortInvitation(mode Mode, noPassword bool, base string) bool {
	normalized, err := normalizedBaseURL(base)
	return err == nil && mode == ModeLeash && !noPassword && normalized == OfficialWebBase
}

// ShortLease owns the management capability. Maintain must be joined before
// Delete; both are called only by the composition root's lifecycle owner.
type ShortLease struct {
	client    *ShortClient
	code      string
	token     []byte
	expiresAt time.Time
}

func (*ShortLease) Format(state fmt.State, _ rune) {
	_, _ = io.WriteString(state, "[redacted short invitation lease]")
}

// Publish sends only the invitation and fixed access-mode declaration. Success
// replaces the private full URL with its locator; failure changes no presentation.
// A non-nil lease owns cleanup authority even when an error is returned; the
// caller must Delete it during startup rollback with a fresh bounded context.
func (client *ShortClient) Publish(ctx context.Context, invitation *Invitation) (*ShortLease, error) {
	if invitation == nil || invitation.mode != ModeLeash || !validOfficialInvitation(invitation.url, client.now()) {
		return nil, ErrInvalidCard
	}
	body, err := json.Marshal(struct {
		Invitation string `json:"invitation"`
		Access     string `json:"access"`
	}{string(invitation.url), "code"})
	if err != nil {
		return nil, ErrShortRequest
	}
	defer clear(body)
	fields, err := client.request(ctx, http.MethodPost, "", nil, body, http.StatusCreated, "code", "managementToken", "expiresAt")
	if err != nil {
		return nil, err
	}
	defer eraseFields(fields)
	var code, token string
	if json.Unmarshal(fields["code"], &code) != nil || !validShortCode(code) ||
		json.Unmarshal(fields["managementToken"], &token) != nil || !validManagementToken(token) {
		return nil, ErrShortResponse
	}
	lease := &ShortLease{client: client, code: code, token: []byte(token)}
	expiresAt, err := client.expiry(fields["expiresAt"], true)
	if err != nil {
		return lease, err
	}
	lease.expiresAt = expiresAt
	clear(invitation.url)
	invitation.url = []byte(OfficialWebBase + code)
	invitation.short = true
	return lease, nil
}

// Resolve is bounded and read-only; opening a locator never extends its lease.
func (client *ShortClient) Resolve(ctx context.Context, code string) (*Invitation, error) {
	if !validShortCode(code) {
		return nil, ErrShortRequest
	}
	fields, err := client.request(ctx, http.MethodGet, code, nil, nil, http.StatusOK, "invitation", "expiresAt")
	if err != nil {
		return nil, err
	}
	defer eraseFields(fields)
	if _, err := client.expiry(fields["expiresAt"], false); err != nil {
		return nil, err
	}
	var full string
	if json.Unmarshal(fields["invitation"], &full) != nil || !validOfficialInvitation([]byte(full), client.now()) {
		return nil, ErrShortResponse
	}
	card, err := ParseFragment(strings.TrimPrefix(full, OfficialWebBase), client.now())
	if err != nil {
		return nil, ErrShortResponse
	}
	return &Invitation{url: []byte(full), mode: card.Mode, expiresAt: card.ExpiresAt}, nil
}

func (lease *ShortLease) Renew(ctx context.Context) error {
	if len(lease.token) == 0 {
		return ErrErased
	}
	fields, err := lease.client.request(ctx, http.MethodPut, lease.code, lease.token, nil, http.StatusOK, "expiresAt")
	if err != nil {
		return err
	}
	defer eraseFields(fields)
	expiresAt, err := lease.client.expiry(fields["expiresAt"], true)
	if err != nil {
		return err
	}
	lease.expiresAt = expiresAt
	return nil
}

// Maintain makes at most three attempts per renewal, preserving the first
// failure. Cancellation joins the current bounded request before cleanup.
func (lease *ShortLease) Maintain(ctx context.Context) error {
	for {
		if err := lease.client.wait(ctx, shortRenewInterval); err != nil {
			return err
		}
		var first error
		for attempt := 0; attempt < 3; attempt++ {
			remaining := lease.expiresAt.Sub(lease.client.now()) - shortSafetyMargin
			if remaining <= shortRequestTimeout {
				if first != nil {
					return first
				}
				return ErrShortLease
			}
			if err := lease.Renew(ctx); err == nil {
				first = nil
				break
			} else if first == nil {
				first = err
			}
			if ctx.Err() != nil {
				return ctx.Err()
			}
			if attempt == 2 {
				return first
			}
			backoff := time.Duration(attempt+1) * 30 * time.Second
			if lease.expiresAt.Sub(lease.client.now()) <= shortSafetyMargin+backoff+shortRequestTimeout {
				return first
			}
			if err := lease.client.wait(ctx, backoff); err != nil {
				return err
			}
		}
	}
}

// Delete attempts one request even after the session context is canceled; the
// caller supplies a fresh bounded cleanup context. Capability erasure is final.
func (lease *ShortLease) Delete(ctx context.Context) error {
	if len(lease.token) == 0 {
		return nil
	}
	defer func() { clear(lease.token); lease.token = nil; lease.code = ""; lease.expiresAt = time.Time{} }()
	_, err := lease.client.request(ctx, http.MethodDelete, lease.code, lease.token, nil, http.StatusNoContent)
	return err
}

func (client *ShortClient) request(ctx context.Context, method, code string, token, body []byte, status int, names ...string) (map[string]json.RawMessage, error) {
	if ctx == nil || len(body) > shortBodyLimit {
		return nil, ErrShortRequest
	}
	ctx, cancel := context.WithTimeout(ctx, shortRequestTimeout)
	defer cancel()
	endpoint := shortAPI
	if code != "" {
		endpoint += "/" + code
	}
	request, err := http.NewRequestWithContext(ctx, method, endpoint, bytes.NewReader(body))
	if err != nil {
		return nil, ErrShortRequest
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Cache-Control", "no-store")
	if len(body) > 0 {
		request.Header.Set("Content-Type", "application/json")
	}
	if len(token) > 0 {
		request.Header.Set("Authorization", "Bearer "+string(token))
	}
	defer request.Header.Del("Authorization")
	response, err := client.http.Do(request)
	if err != nil {
		if ctx.Err() != nil {
			return nil, errors.Join(ErrShortRequest, ctx.Err())
		}
		return nil, ErrShortRequest
	}
	defer response.Body.Close()
	if response.StatusCode != status || response.ContentLength > shortBodyLimit || !noStore(response.Header.Get("Cache-Control")) {
		return nil, ErrShortResponse
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, shortBodyLimit+1))
	defer clear(data)
	if err != nil || len(data) > shortBodyLimit {
		return nil, ErrShortResponse
	}
	if status == http.StatusNoContent {
		if len(data) != 0 {
			return nil, ErrShortResponse
		}
		return nil, nil
	}
	mediaType, _, err := mime.ParseMediaType(response.Header.Get("Content-Type"))
	if err != nil || mediaType != "application/json" {
		return nil, ErrShortResponse
	}
	return strictFields(data, names)
}

func strictFields(data []byte, names []string) (map[string]json.RawMessage, error) {
	decoder := json.NewDecoder(bytes.NewReader(data))
	start, err := decoder.Token()
	if err != nil || start != json.Delim('{') {
		return nil, ErrShortResponse
	}
	fields := make(map[string]json.RawMessage, len(names))
	fail := func() (map[string]json.RawMessage, error) { eraseFields(fields); return nil, ErrShortResponse }
	for decoder.More() {
		key, err := decoder.Token()
		if err != nil {
			return fail()
		}
		name, ok := key.(string)
		if !ok {
			return fail()
		}
		allowed := false
		for _, expected := range names {
			if name == expected {
				allowed = true
				break
			}
		}
		if !allowed || fields[name] != nil {
			return fail()
		}
		var value json.RawMessage
		if decoder.Decode(&value) != nil {
			return fail()
		}
		fields[name] = value
	}
	if _, err := decoder.Token(); err != nil {
		return fail()
	}
	if _, err := decoder.Token(); !errors.Is(err, io.EOF) || len(fields) != len(names) {
		return fail()
	}
	return fields, nil
}

func eraseFields(fields map[string]json.RawMessage) {
	for _, value := range fields {
		clear(value)
	}
}

func (client *ShortClient) expiry(raw []byte, renewed bool) (time.Time, error) {
	var milliseconds int64
	if json.Unmarshal(raw, &milliseconds) != nil {
		return time.Time{}, ErrShortResponse
	}
	expires := time.UnixMilli(milliseconds)
	remaining := expires.Sub(client.now())
	if remaining <= 0 || remaining > shortLeaseDuration+time.Minute || renewed && remaining < shortLeaseDuration-time.Minute {
		return time.Time{}, ErrShortResponse
	}
	return expires, nil
}

func validShortCode(code string) bool {
	if len(code) != 6 {
		return false
	}
	for _, value := range code {
		if !(value >= '0' && value <= '9' || value >= 'A' && value <= 'Z' || value >= 'a' && value <= 'z') {
			return false
		}
	}
	return true
}

func validManagementToken(token string) bool {
	if len(token) != 43 {
		return false
	}
	decoded, err := base64.RawURLEncoding.Strict().DecodeString(token)
	defer clear(decoded)
	return err == nil && len(decoded) == 32
}

func validOfficialInvitation(value []byte, now time.Time) bool {
	if len(value) >= MaxInvitationBytes || !bytes.HasPrefix(value, []byte(OfficialWebBase+"#/v1/")) {
		return false
	}
	card, err := ParseFragment(string(value[len(OfficialWebBase):]), now)
	return err == nil && card.Mode == ModeLeash && card.ProtocolMin == LeashProtocol && card.ProtocolMax == LeashProtocol
}

func noStore(value string) bool {
	for _, directive := range strings.Split(value, ",") {
		if strings.EqualFold(strings.TrimSpace(directive), "no-store") {
			return true
		}
	}
	return false
}
