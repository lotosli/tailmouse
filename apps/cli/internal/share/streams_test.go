package share

import (
	"context"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

func TestHTTPAndWebSocketStreams(t *testing.T) {
	app := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/ws" {
			c, e := websocket.Accept(w, r, &websocket.AcceptOptions{OriginPatterns: []string{r.Host}})
			if e != nil {
				return
			}
			defer c.CloseNow()
			kind, b, e := c.Read(r.Context())
			if e == nil {
				_ = c.Write(r.Context(), kind, b)
				_ = c.Close(websocket.StatusNormalClosure, "done")
			}
			return
		}
		if r.URL.Path == "/restricted" {
			w.Header().Set("Content-Security-Policy", "script-src 'none'")
		}
		if r.URL.Path == "/html" || r.URL.Path == "/restricted" {
			w.Header().Set("Content-Type", "text/html")
			w.Header().Set("ETag", "original")
			_, _ = io.WriteString(w, "<h1>preview</h1>")
			return
		}
		w.Header().Set("X-Duplicate", "one")
		w.Header().Add("X-Duplicate", "two")
		_, _ = io.Copy(w, r.Body)
	}))
	defer app.Close()
	o := Options{Command: "web", Target: app.URL, Cwd: t.TempDir(), MaxClients: 1, TTL: time.Minute, Approval: "auto"}
	h, token, e := NewHost(context.Background(), o, os.Environ())
	if e != nil {
		t.Fatal(e)
	}
	h.Ready()
	defer h.Close()
	_, welcome := welcomeHost(t, h, token, "peer")
	open := func(channel string) net.Conn {
		return openHost(t, h, "peer", Hello{Type: "hello", Version: 2, Session: h.ID(), Channel: channel, Resource: "web", Member: welcome.Member, Grant: welcome.Grant})
	}
	for _, path := range []string{"/echo", "/html", "/restricted"} {
		t.Run(path, func(t *testing.T) {
			c := open("http")
			defer c.Close()
			if e := WriteJSON(c, HTTPRequest{Type: "request", Method: "POST", Path: path}); e != nil {
				t.Fatal(e)
			}
			if e := WriteFrame(c, DataFrame, []byte("body")); e != nil {
				t.Fatal(e)
			}
			if e := WriteFrame(c, EndFrame, nil); e != nil {
				t.Fatal(e)
			}
			if path == "/restricted" {
				var rejected WireError
				objectFrom(t, c, &rejected)
				if rejected.Code != "WEB_UNSUPPORTED_SECURITY_POLICY" {
					t.Fatal("CSP bypass")
				}
				return
			}
			var response HTTPResponse
			objectFrom(t, c, &response)
			if response.Status != 200 {
				t.Fatal("HTTP failed")
			}
			var body strings.Builder
			for {
				f, e := ReadFrame(c)
				if e != nil {
					t.Fatal(e)
				}
				if f.Kind == EndFrame {
					break
				}
				if f.Kind != DataFrame {
					t.Fatal("unexpected response")
				}
				body.Write(f.Data)
			}
			if path == "/echo" && body.String() != "body" {
				t.Fatal("body corruption")
			}
			if path == "/html" && !strings.HasPrefix(body.String(), `<script src="/.tailmouse/shim.js"></script>`) {
				t.Fatal("shim not before application")
			}
		})
	}
	socket := open("websocket")
	defer socket.Close()
	if e := WriteJSON(socket, WebSocketRequest{Type: "websocket", Path: "/ws", Protocols: []string{}}); e != nil {
		t.Fatal(e)
	}
	var opened SocketMessage
	objectFrom(t, socket, &opened)
	if opened.Type != "websocket.open" {
		t.Fatal("socket unavailable")
	}
	if e := WriteJSON(socket, SocketMessage{Type: "websocket.message", Text: true, Size: 5}); e != nil {
		t.Fatal(e)
	}
	if e := WriteFrame(socket, DataFrame, []byte("hello")); e != nil {
		t.Fatal(e)
	}
	if e := WriteFrame(socket, EndFrame, nil); e != nil {
		t.Fatal(e)
	}
	var message SocketMessage
	objectFrom(t, socket, &message)
	if !message.Text || message.Size != 5 {
		t.Fatal("message metadata")
	}
	f, e := ReadFrame(socket)
	if e != nil || string(f.Data) != "hello" {
		t.Fatal("message corrupted")
	}
	f, e = ReadFrame(socket)
	if e != nil || f.Kind != EndFrame {
		t.Fatal("message end missing")
	}
}
