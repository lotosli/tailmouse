package share

import (
	"context"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"
)

func testHost(t *testing.T, manual bool) (*Host, string) {
	t.Helper()
	o := Options{Command: "web", Cwd: t.TempDir(), MaxClients: 2, TTL: time.Minute, Approval: "auto", FrontendBase: "https://ui.example.com", ContentBase: "https://preview.example.net"}
	if manual {
		o.Approval = "manual"
	}
	h, token, e := NewHost(context.Background(), o, os.Environ())
	if e != nil {
		t.Fatal(e)
	}
	// Policy and fake-clock heartbeat tests need a declared resource without
	// depending on a POSIX filesystem or real network I/O inside synctest.
	transport := &http.Transport{}
	transport.RegisterProtocol("http", hostTestHTTP{})
	h.web = &WebResource{target: &url.URL{Scheme: "http", Host: "127.0.0.1:8080"}, origin: "http://127.0.0.1:8080", transport: transport, jars: map[string]http.CookieJar{}, available: true}
	h.Ready()
	t.Cleanup(func() {
		if e := h.Close(); e != nil {
			t.Error(e)
		}
	})
	return h, token
}

type hostTestHTTP struct{}

func (hostTestHTTP) RoundTrip(request *http.Request) (*http.Response, error) {
	return &http.Response{StatusCode: http.StatusOK, Header: http.Header{"Content-Type": {"text/plain"}}, Body: io.NopCloser(strings.NewReader("abc")), ContentLength: 3, Request: request}, nil
}
func openHost(t *testing.T, h *Host, peer string, hello Hello) net.Conn {
	t.Helper()
	client, server := net.Pipe()
	_ = client.SetDeadline(time.Now().Add(3 * time.Second))
	go h.Serve(server, peer)
	t.Cleanup(func() { _ = client.Close() })
	if _, e := io.WriteString(client, Preface); e != nil {
		t.Fatal(e)
	}
	if e := WriteJSON(client, hello); e != nil {
		t.Fatal(e)
	}
	return client
}
func objectFrom(t *testing.T, r io.Reader, out any) {
	t.Helper()
	f, e := ReadFrame(r)
	if e != nil {
		t.Fatal(e)
	}
	if Decode(f, out) != nil {
		t.Fatal("invalid server message")
	}
}
func welcomeHost(t *testing.T, h *Host, token, peer string) (net.Conn, Welcome) {
	t.Helper()
	c := openHost(t, h, peer, Hello{Type: "hello", Version: 2, Session: h.ID(), Channel: "control", Token: token})
	var w Welcome
	objectFrom(t, c, &w)
	if w.Type != "welcome" || w.Version != 2 || len(w.Manifest.Resources) != 1 {
		t.Fatal("missing authenticated manifest")
	}
	return c, w
}
func TestHostGrantsBindPeerResourceAndGeneration(t *testing.T) {
	h, token := testHost(t, false)
	_, welcome := welcomeHost(t, h, token, "peer-a")
	grant := Hello{Type: "hello", Version: 2, Session: h.ID(), Channel: "http", Resource: "web", Member: welcome.Member, Grant: welcome.Grant}
	other := openHost(t, h, "peer-b", grant)
	var denied WireError
	objectFrom(t, other, &denied)
	if denied.Code != "UNAUTHORIZED" {
		t.Fatal("grant was transferable")
	}
	forbidden := grant
	forbidden.Channel = "terminal"
	forbidden.Resource = "cli"
	c := openHost(t, h, "peer-a", forbidden)
	objectFrom(t, c, &denied)
	if denied.Code != "UNAUTHORIZED" {
		t.Fatal("undeclared resource authorized")
	}
	stream := openHost(t, h, "peer-a", grant)
	if e := WriteJSON(stream, HTTPRequest{Type: "request", Method: "GET", Path: "/"}); e != nil {
		t.Fatal(e)
	}
	if e := WriteFrame(stream, EndFrame, nil); e != nil {
		t.Fatal(e)
	}
	var response HTTPResponse
	objectFrom(t, stream, &response)
	data, err := ReadFrame(stream)
	if err != nil || response.Status != http.StatusOK || data.Kind != DataFrame || string(data.Data) != "abc" {
		t.Fatal("valid resource grant did not deliver its response")
	}
	end, err := ReadFrame(stream)
	if err != nil || end.Kind != EndFrame {
		t.Fatal("response did not finish")
	}
	fresh := h.Rotate()
	if fresh == token {
		t.Fatal("rotation reused token")
	}
	stale := openHost(t, h, "peer-a", grant)
	objectFrom(t, stale, &denied)
	if denied.Code != "UNAUTHORIZED" {
		t.Fatal("old grant survived rotation")
	}
	bad := openHost(t, h, "peer-a", Hello{Type: "hello", Version: 2, Session: h.ID(), Channel: "control", Token: token})
	objectFrom(t, bad, &denied)
	if denied.Code != "UNAUTHORIZED" {
		t.Fatal("old invitation survived rotation")
	}
	welcomeHost(t, h, fresh, "peer-a")
}
func TestHostManualApprovalCapacityAndPause(t *testing.T) {
	h, token := testHost(t, true)
	h.options.MaxClients = 1
	c := openHost(t, h, "peer-a", Hello{Type: "hello", Version: 2, Session: h.ID(), Channel: "control", Token: token})
	var waiting struct {
		Type   string `json:"type"`
		Member string `json:"member"`
	}
	objectFrom(t, c, &waiting)
	if waiting.Type != "waiting" {
		t.Fatal("manual approval bypassed")
	}
	busy := openHost(t, h, "peer-b", Hello{Type: "hello", Version: 2, Session: h.ID(), Channel: "control", Token: token})
	var denied WireError
	objectFrom(t, busy, &denied)
	if denied.Code != "SESSION_BUSY" {
		t.Fatal("capacity exceeded")
	}
	if !h.Approve() {
		t.Fatal("approval unavailable")
	}
	var welcome Welcome
	objectFrom(t, c, &welcome)
	if welcome.Type != "welcome" {
		t.Fatal("approval did not admit")
	}
	h.TakeLocal()
	if h.CanInput(welcome.Member) {
		t.Fatal("local seat did not revoke input")
	}
	if !h.GrantControl() {
		t.Fatal("local regrant failed")
	}
	h.Rotate()
	h.Pause()
	paused := openHost(t, h, "peer-c", Hello{Type: "hello", Version: 2, Session: h.ID(), Channel: "control", Token: token})
	objectFrom(t, paused, &denied)
	if denied.Code != "UNAUTHORIZED" {
		t.Fatal("paused admission accepted")
	}
}
func TestHostReconnectReplacesOnlySamePeer(t *testing.T) {
	h, token := testHost(t, false)
	old, w := welcomeHost(t, h, token, "peer")
	replacement := openHost(t, h, "peer", Hello{Type: "hello", Version: 2, Session: h.ID(), Channel: "control", Member: w.Member, Grant: w.Grant})
	var resumed Welcome
	objectFrom(t, replacement, &resumed)
	if resumed.Member != w.Member {
		t.Fatal("reconnect allocated new member")
	}
	if _, e := ReadFrame(old); e == nil {
		t.Fatal("old control survived replacement")
	}
	if _, e := h.Invitation("synthetic-redacted-address", token); e != nil {
		t.Fatal("invitation encoding")
	}
	h.mu.Lock()
	h.expires = time.Now().Add(-time.Second)
	h.mu.Unlock()
	expired := openHost(t, h, "peer", Hello{Type: "hello", Version: 2, Session: h.ID(), Channel: "control", Token: token})
	var denied WireError
	objectFrom(t, expired, &denied)
	if denied.Code != "EXPIRED" {
		t.Fatal("expiry accepted")
	}
}
