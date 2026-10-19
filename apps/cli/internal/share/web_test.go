package share

import (
	"encoding/pem"
	"net/url"
	"os"
	"path/filepath"

	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

func TestWebPreflightCookiesAndOriginContainment(t *testing.T) {
	var hits atomic.Int64
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		switch r.URL.Path {
		case "/login":
			http.SetCookie(w, &http.Cookie{Name: "session", Value: "synthetic", Path: "/", HttpOnly: true})
			w.WriteHeader(204)
		case "/private":
			if c, e := r.Cookie("session"); e != nil || c.Value != "synthetic" {
				w.WriteHeader(401)
			} else {
				_, _ = io.WriteString(w, "authenticated")
			}
		case "/redirect":
			http.Redirect(w, r, "http://forbidden.invalid/", http.StatusFound)
		default:
			_, _ = io.Copy(w, r.Body)
		}
	}))
	defer upstream.Close()
	web, e := NewWeb(context.Background(), upstream.URL+"/initial?q=1#section", false, "")
	if e != nil {
		t.Fatal(e)
	}
	defer web.Close()
	if hits.Load() != 0 {
		t.Fatal("preflight sent HTTP")
	}
	if web.InitialPath() != "/initial?q=1#section" {
		t.Fatal("initial navigation")
	}
	request := func(member, path string) int {
		t.Helper()
		res, e := web.Do(context.Background(), member, HTTPRequest{Type: "request", Method: "GET", Path: path}, nil)
		if e != nil {
			t.Fatal(e)
		}
		defer res.Body.Close()
		return res.StatusCode
	}
	if request("a", "/login") != 204 || request("a", "/private") != 200 || request("b", "/private") != 401 {
		t.Fatal("cookie isolation")
	}
	for _, path := range []string{"https://forbidden.invalid/", "//forbidden.invalid/", "/\\forbidden", "/.tailmouse/shim.js"} {
		if _, e := web.Do(context.Background(), "a", HTTPRequest{Type: "request", Method: "GET", Path: path}, nil); e != ErrWebPolicy {
			t.Fatal("target escape accepted")
		}
	}
	if _, e = web.Do(context.Background(), "a", HTTPRequest{Type: "request", Method: "GET", Path: "/redirect"}, nil); e != ErrWebPolicy {
		t.Fatal("redirect escaped", e)
	}
	web.Forget("a")
	if request("a", "/private") != 401 {
		t.Fatal("revoked cookie retained")
	}
	response, e := web.Do(context.Background(), "a", HTTPRequest{Type: "request", Method: "POST", Path: "/echo", Headers: [][2]string{{"Cookie", "must-not-forward"}, {"X-Test", "ok"}}}, strings.NewReader("hello"))
	if e != nil {
		t.Fatal(e)
	}
	defer response.Body.Close()
	b, e := io.ReadAll(response.Body)
	if e != nil || string(b) != "hello" {
		t.Fatal("streaming body")
	}
}
func TestWebTLSAndValidation(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { t.Error("unexpected HTTP preflight") }))
	defer server.Close()
	if _, e := NewWeb(context.Background(), server.URL, false, ""); e != ErrWebTLS {
		t.Fatal("untrusted TLS accepted")
	}
	if _, e := NewWeb(context.Background(), "http://0.0.0.0:8080", false, ""); e != ErrConfig {
		t.Fatal("wildcard accepted")
	}
	for _, method := range []string{"CONNECT", "TRACE", "G ET"} {
		web, e := NewWeb(context.Background(), "http://127.0.0.1:1", false, "")
		if e != nil {
			t.Fatal(e)
		}
		if _, e = web.Do(context.Background(), "a", HTTPRequest{Type: "request", Method: method, Path: "/"}, nil); e != ErrWebPolicy {
			t.Fatal("unsafe method")
		}
		web.Close()
	}
	if canInject(http.Header{"Content-Security-Policy": []string{"default-src 'none'; script-src 'nonce-abc'"}}) {
		t.Fatal("CSP bypass")
	}
	if !canInject(http.Header{"Content-Security-Policy": []string{"default-src 'self'"}}) {
		t.Fatal("same-origin scripts rejected")
	}
	if safeHeader("Bad\nName", "ok") || safeHeader("X-Test", "x\r\ny") || !blockedHeader("Proxy-Authorization") {
		t.Fatal("header validation")
	}
}

func TestWebAuthorityHeadersAndCanceledStreaming(t *testing.T) {
	received := make(chan *http.Request, 2)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		received <- r.Clone(context.Background())
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, "data: ready\n\n")
		w.(http.Flusher).Flush()
		<-r.Context().Done()
	}))
	defer server.Close()
	web, err := NewWeb(t.Context(), server.URL, false, "")
	if err != nil {
		t.Fatal(err)
	}
	defer web.Close()
	web.contentOrigin = "https://preview.example.test"
	ctx, cancel := context.WithCancel(t.Context())
	res, err := web.Do(ctx, "member", HTTPRequest{Type: "request", Method: "GET", Path: "/events", Headers: [][2]string{
		{"Origin", web.contentOrigin}, {"Referer", web.contentOrigin + "/page?q=1"}, {"Cookie", "private=never"}, {"Host", "forbidden.invalid"}, {"Connection", "X-Hop"}, {"X-Hop", "never"}, {"X-Allowed", "yes"},
	}}, nil)
	if err != nil {
		cancel()
		t.Fatal(err)
	}
	request := <-received
	if request.Host != web.target.Host || request.Header.Get("Origin") != server.URL || request.Header.Get("Referer") != server.URL+"/page?q=1" || request.Header.Get("Cookie") != "" || request.Header.Get("X-Hop") != "" || request.Header.Get("X-Allowed") != "yes" {
		t.Fatal("authority or hop header escape")
	}
	first := make([]byte, len("data: ready\n\n"))
	if _, err := io.ReadFull(res.Body, first); err != nil || string(first) != "data: ready\n\n" {
		t.Fatal("SSE was not streamed", err)
	}
	cancel()
	_, err = io.ReadAll(res.Body)
	_ = res.Body.Close()
	if err == nil || !web.Available() {
		t.Fatal("request cancellation changed resource availability")
	}
	for _, header := range [][2]string{{"Origin", "https://foreign.invalid"}, {"Referer", "https://foreign.invalid/path"}, {"X-Bad", "line\r\nInjected: yes"}} {
		_, err := web.Do(t.Context(), "member", HTTPRequest{Type: "request", Method: "GET", Path: "/", Headers: [][2]string{header}}, nil)
		if err != ErrWebPolicy {
			t.Fatal("invalid caller authority accepted")
		}
	}
	if len(received) != 0 {
		t.Fatal("rejected metadata reached upstream")
	}
}
func TestWebExplicitCAAndUnavailableReprobe(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(204) }))
	defer server.Close()
	ca := filepath.Join(t.TempDir(), "ca.pem")
	if err := os.WriteFile(ca, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: server.Certificate().Raw}), 0600); err != nil {
		t.Fatal(err)
	}
	web, err := NewWeb(t.Context(), server.URL, false, ca)
	if err != nil {
		t.Fatal(err)
	}
	defer web.Close()
	if !web.Available() || web.Reprobe(t.Context()) != nil {
		t.Fatal("trusted TLS preflight failed")
	}
	res, err := web.Do(t.Context(), "member", HTTPRequest{Type: "request", Method: "GET", Path: "/"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	_ = res.Body.Close()
	if res.StatusCode != 204 {
		t.Fatal("explicit root did not authorize TLS")
	}
	if _, err := NewWeb(t.Context(), server.URL, false, ca+"-missing"); err != ErrWebTLS {
		t.Fatal("missing CA ignored")
	}
	if _, err := NewWeb(t.Context(), "http://192.0.2.1:8080", false, ""); err != ErrWebPolicy {
		t.Fatal("remote IP accepted without opt-in")
	}
	if _, err := web.transport.DialContext(t.Context(), "tcp", "127.0.0.2:80"); err != ErrWebPolicy {
		t.Fatal("frozen target dial escaped")
	}
	server.Close()
	if err := web.Reprobe(t.Context()); err == nil || web.Available() {
		t.Fatal("failed reprobe reported ready")
	}
}
func TestWebCookieOmitAndSecureScope(t *testing.T) {
	var forwarded bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		forwarded = r.Header.Get("Cookie") != ""
		http.SetCookie(w, &http.Cookie{Name: "session", Value: "synthetic", Path: "/"})
		w.WriteHeader(204)
	}))
	defer server.Close()
	web, err := NewWeb(t.Context(), server.URL, false, "")
	if err != nil {
		t.Fatal(err)
	}
	defer web.Close()
	for _, credentials := range []string{"include", "omit", "include"} {
		res, err := web.Do(t.Context(), "member", HTTPRequest{Type: "request", Method: "GET", Path: "/", Credentials: credentials}, nil)
		if err != nil {
			t.Fatal(err)
		}
		_ = res.Body.Close()
		if credentials == "omit" && forwarded {
			t.Fatal("credentials omit forwarded host cookies")
		}
	}
	if !forwarded {
		t.Fatal("member cookie jar lost authorized cookie")
	}
	u, _ := url.Parse("https://cookies.example.test/private/login")
	jar := web.jar("isolated")
	jar.SetCookies(u, []*http.Cookie{{Name: "secure", Value: "yes", Secure: true, Path: "/private"}, {Name: "insecure", Value: "no", SameSite: http.SameSiteNoneMode, Path: "/"}})
	if cookies := jar.Cookies(u); len(cookies) != 1 || cookies[0].Name != "secure" {
		t.Fatal("insecure SameSite=None cookie was accepted")
	}
	u.Scheme = "http"
	if len(jar.Cookies(u)) != 0 {
		t.Fatal("secure cookie escaped TLS")
	}
}
