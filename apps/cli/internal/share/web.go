package share

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"golang.org/x/net/publicsuffix"
)

var (
	ErrWebPolicy      = errors.New("WEB_POLICY")
	ErrWebTLS         = errors.New("WEB_TLS")
	ErrWebUnavailable = errors.New("WEB_UNAVAILABLE")
)

type WebResource struct {
	contentOrigin string
	previewPrefix string
	target        *url.URL
	origin        string
	transport     *http.Transport
	mu            sync.Mutex
	jars          map[string]http.CookieJar
	available     bool
}
type HTTPRequest struct {
	Credentials string      `json:"credentials,omitempty"`
	Type        string      `json:"type"`
	Method      string      `json:"method"`
	Path        string      `json:"path"`
	Headers     [][2]string `json:"headers"`
}
type HTTPResponse struct {
	Type    string      `json:"type"`
	Status  int         `json:"status"`
	Headers [][2]string `json:"headers"`
}

func NewWeb(ctx context.Context, target string, allowRemote bool, caFile string) (*WebResource, error) {
	u, e := ParseTarget(target)
	if e != nil {
		return nil, e
	}
	host := u.Hostname()
	port := u.Port()
	if port == "" {
		port = "80"
		if u.Scheme == "https" {
			port = "443"
		}
	}
	lookup, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	ips, e := net.DefaultResolver.LookupIPAddr(lookup, host)
	if e != nil || len(ips) == 0 {
		return nil, ErrWebUnavailable
	}
	for _, v := range ips {
		if v.Zone != "" || v.IP.IsUnspecified() || v.IP.IsMulticast() || !allowRemote && !v.IP.IsLoopback() {
			return nil, ErrWebPolicy
		}
	}
	roots, e := x509.SystemCertPool()
	if e != nil {
		roots = x509.NewCertPool()
	}
	if caFile != "" {
		pem, e := os.ReadFile(caFile)
		if e != nil || !roots.AppendCertsFromPEM(pem) {
			return nil, ErrWebTLS
		}
	}
	config := &tls.Config{MinVersion: tls.VersionTLS12, RootCAs: roots, ServerName: host}
	dial := func(ctx context.Context, _, address string) (net.Conn, error) {
		h, p, e := net.SplitHostPort(address)
		if e != nil || !strings.EqualFold(h, host) || p != port {
			return nil, ErrWebPolicy
		}
		var last error
		for _, ip := range ips {
			conn, e := (&net.Dialer{Timeout: 5 * time.Second, KeepAlive: 30 * time.Second}).DialContext(ctx, "tcp", net.JoinHostPort(ip.IP.String(), port))
			if e == nil {
				return conn, nil
			}
			last = e
			if ctx.Err() != nil {
				break
			}
		}
		return nil, last
	}
	transport := &http.Transport{Proxy: nil, DialContext: dial, TLSClientConfig: config, DisableCompression: true, ForceAttemptHTTP2: false, MaxIdleConns: 64, MaxIdleConnsPerHost: 16, MaxConnsPerHost: 64, IdleConnTimeout: 30 * time.Second, ResponseHeaderTimeout: 30 * time.Second, MaxResponseHeaderBytes: 64 << 10, TLSHandshakeTimeout: 5 * time.Second}
	w := &WebResource{target: u, origin: u.Scheme + "://" + u.Host, transport: transport, jars: map[string]http.CookieJar{}}
	// Probe only TCP/TLS. Sending an HTTP request during validation can mutate
	// an application; its first HTTP request must be the guest's actual intent.
	probe, cancelProbe := context.WithTimeout(ctx, 5*time.Second)
	defer cancelProbe()
	conn, e := dial(probe, "tcp", net.JoinHostPort(host, port))
	if e != nil {
		return w, nil
	}
	defer conn.Close()
	if u.Scheme == "https" {
		secured := tls.Client(conn, config)
		if secured.HandshakeContext(probe) != nil {
			return nil, ErrWebTLS
		}
	}
	w.available = true
	return w, nil
}
func (w *WebResource) InitialPath() string {
	p := w.target.RequestURI()
	if w.target.Fragment != "" {
		p += "#" + w.target.Fragment
	}
	return p
}
func (w *WebResource) Available() bool { w.mu.Lock(); defer w.mu.Unlock(); return w.available }
func (w *WebResource) Close() {
	w.transport.CloseIdleConnections()
	w.mu.Lock()
	clear(w.jars)
	w.mu.Unlock()
}
func (w *WebResource) Forget(member string) { w.mu.Lock(); delete(w.jars, member); w.mu.Unlock() }
func (w *WebResource) jar(member string) http.CookieJar {
	w.mu.Lock()
	defer w.mu.Unlock()
	jar := w.jars[member]
	if jar == nil {
		native, _ := cookiejar.New(&cookiejar.Options{PublicSuffixList: publicsuffix.List})
		jar = &sameOriginJar{native}
		w.jars[member] = jar
	}
	return jar
}
func (w *WebResource) requestURL(path string) (*url.URL, error) {
	if len(path) > 8192 || !strings.HasPrefix(path, "/") || strings.HasPrefix(path, "//") || strings.ContainsAny(path, "\\\r\n\x00") {
		return nil, ErrWebPolicy
	}
	u, e := url.ParseRequestURI(path)
	if e != nil || u.IsAbs() || u.Host != "" || u.Fragment != "" || strings.HasPrefix(u.Path, "/.tailmouse/") {
		return nil, ErrWebPolicy
	}
	u.Scheme = w.target.Scheme
	u.Host = w.target.Host
	return u, nil
}
func (w *WebResource) Do(ctx context.Context, member string, input HTTPRequest, body io.Reader) (*http.Response, error) {
	switch input.Method {
	case "GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS":
	default:
		return nil, ErrWebPolicy
	}
	u, e := w.requestURL(input.Path)
	if e != nil {
		return nil, e
	}
	if input.Type != "request" || len(input.Headers) > 128 || (input.Credentials != "" && input.Credentials != "omit" && input.Credentials != "same-origin" && input.Credentials != "include") {
		return nil, ErrWebPolicy
	}
	req, e := http.NewRequestWithContext(ctx, input.Method, u.String(), body)
	if e != nil {
		return nil, ErrWebPolicy
	}
	hop := map[string]bool{}
	for _, header := range input.Headers {
		if strings.EqualFold(header[0], "Connection") {
			for _, name := range strings.Split(header[1], ",") {
				hop[strings.ToLower(strings.TrimSpace(name))] = true
			}
		}
	}
	for _, h := range input.Headers {
		if !safeHeader(h[0], h[1]) {
			return nil, ErrWebPolicy
		}
		if blockedHeader(h[0]) || hop[strings.ToLower(h[0])] {
			continue
		}
		req.Header.Add(h[0], h[1])
	}
	req.Header.Set("Accept-Encoding", "identity")
	// The browser's isolated content origin is a representation of this one
	// authorized origin. Do not forward content-domain authority or cookies.
	if source := req.Header.Get("Origin"); source != "" {
		if source != w.origin && (w.contentOrigin == "" || source != w.contentOrigin) {
			return nil, ErrWebPolicy
		}
		req.Header.Set("Origin", w.origin)
	}
	if source := req.Header.Get("Referer"); source != "" {
		ref, err := url.Parse(source)
		if err != nil || ref.User != nil {
			return nil, ErrWebPolicy
		}
		origin := ref.Scheme + "://" + ref.Host
		if origin != w.origin && (w.contentOrigin == "" || origin != w.contentOrigin) {
			return nil, ErrWebPolicy
		}
		req.Header.Set("Referer", w.origin+ref.RequestURI())
	}
	var jar http.CookieJar
	if input.Credentials != "omit" {
		jar = w.jar(member)
	}
	client := &http.Client{Transport: w.transport, Jar: jar, CheckRedirect: func(next *http.Request, via []*http.Request) error {
		if len(via) >= 10 || next.URL.Scheme != u.Scheme || !strings.EqualFold(next.URL.Host, u.Host) || next.URL.User != nil {
			return ErrWebPolicy
		}
		if strings.HasPrefix(next.URL.Path, "/.tailmouse/") {
			return ErrWebPolicy
		}
		return nil
	}}
	response, e := client.Do(req)
	if ctx.Err() == nil {
		w.mu.Lock()
		w.available = e == nil
		w.mu.Unlock()
	}
	if e != nil {
		if errors.Is(e, ErrWebPolicy) {
			return nil, ErrWebPolicy
		}
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		var certificate *tls.CertificateVerificationError
		if errors.As(e, &certificate) {
			return nil, ErrWebTLS
		}
		return nil, ErrWebUnavailable
	}
	return response, nil
}
func safeHeader(k, v string) bool {
	if k == "" || len(k) > 128 || len(v) > 8192 || strings.ContainsAny(v, "\r\n\x00") {
		return false
	}
	for _, c := range k {
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || strings.ContainsRune("!#$%&'*+-.^_`|~", c)) {
			return false
		}
	}
	return true
}
func blockedHeader(k string) bool {
	switch strings.ToLower(k) {
	case "host", "cookie", "connection", "proxy-connection", "proxy-authorization", "proxy-authenticate", "transfer-encoding", "content-length", "keep-alive", "te", "trailer", "upgrade":
		return true
	}
	return strings.HasPrefix(strings.ToLower(k), "sec-")
}
func responseHeaders(h http.Header) [][2]string {
	out := [][2]string{}
	for k, vs := range h {
		if (blockedHeader(k) && !strings.EqualFold(k, "Content-Length")) || strings.EqualFold(k, "Set-Cookie") {
			continue
		}
		for _, v := range vs {
			out = append(out, [2]string{k, v})
		}
	}
	return out
}
func (w *WebResource) Reprobe(ctx context.Context) (result error) {
	defer func() {
		if ctx.Err() == nil {
			w.mu.Lock()
			w.available = result == nil
			w.mu.Unlock()
		}
	}()
	port := w.target.Port()
	if port == "" {
		port = "80"
		if w.target.Scheme == "https" {
			port = "443"
		}
	}
	conn, e := w.transport.DialContext(ctx, "tcp", net.JoinHostPort(w.target.Hostname(), port))
	if e != nil {
		return ErrWebUnavailable
	}
	defer conn.Close()
	if w.target.Scheme == "https" {
		if e = tls.Client(conn, w.transport.TLSClientConfig).HandshakeContext(ctx); e != nil {
			return ErrWebTLS
		}
	}
	w.mu.Lock()
	w.available = true
	w.mu.Unlock()
	return nil
}
func (w *WebResource) OriginSummary() string { return w.origin }

// Only same-origin application requests reach this jar. Cross-site/SSO and
// JavaScript cookies are outside W2; insecure SameSite=None cookies are rejected.
type sameOriginJar struct{ *cookiejar.Jar }

func (j *sameOriginJar) SetCookies(u *url.URL, cookies []*http.Cookie) {
	accepted := make([]*http.Cookie, 0, len(cookies))
	for _, cookie := range cookies {
		if cookie.SameSite == http.SameSiteNoneMode && !cookie.Secure {
			continue
		}
		accepted = append(accepted, cookie)
	}
	j.Jar.SetCookies(u, accepted)
}
