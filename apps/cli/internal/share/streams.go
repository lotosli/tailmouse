package share

import (
	"compress/gzip"
	"compress/zlib"
	"context"
	"errors"
	"html"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/coder/websocket"
)

func (h *Host) serveUpload(ctx context.Context, stream Stream, member string) {
	f, e := ReadFrame(stream)
	if e != nil {
		return
	}
	var m Message
	if Decode(f, &m) != nil {
		return
	}
	if m.Type == "upload.status" || m.Type == "upload.finish" && m.Upload != "" {
		r, e := h.receiver.Status(member, m.Upload)
		if e != nil {
			_ = sendError(stream, e.Error())
		} else {
			_ = WriteJSON(stream, r)
		}
		return
	}
	if m.Type != "upload.begin" {
		return
	}
	u, e := h.receiver.Begin(member, m.Name, m.Size)
	if e != nil {
		_ = sendError(stream, e.Error())
		return
	}
	defer u.Cancel()
	if WriteJSON(stream, struct {
		Type   string `json:"type"`
		Upload string `json:"upload"`
	}{"upload.ready", u.ID()}) != nil {
		return
	}
	var received int64
	for {
		if ctx.Err() != nil {
			return
		}
		f, e = ReadFrame(stream)
		if e != nil {
			return
		}
		switch f.Kind {
		case DataFrame:
			n, e := u.Write(f.Data)
			if e != nil {
				_ = sendError(stream, e.Error())
				return
			}
			received += int64(n)
			if WriteJSON(stream, struct {
				Type     string `json:"type"`
				Received int64  `json:"received"`
			}{"upload.progress", received}) != nil {
				return
			}
		case JSONFrame:
			if Decode(f, &m) != nil || m.Type != "upload.finish" {
				return
			}
			if ctx.Err() != nil {
				return
			}
			receipt, e := u.Finish(ctx, m.SHA256)
			if e != nil {
				h.emit(Event{Event: "error", Resource: "receive", Code: e.Error()})
				_ = sendError(stream, e.Error())
				return
			}
			h.emit(Event{Event: "upload.completed", Resource: "receive", Bytes: receipt.Size})
			_ = WriteJSON(stream, receipt)
			return
		default:
			return
		}
	}
}
func (h *Host) serveHTTP(parent context.Context, stream Stream, member string) {
	f, e := ReadFrame(stream)
	if e != nil {
		return
	}
	var request HTTPRequest
	if Decode(f, &request) != nil {
		return
	}
	ctx, cancel := context.WithCancel(parent)
	defer cancel()
	body, writer := io.Pipe()
	defer body.Close()
	done := make(chan struct{})
	go func() {
		defer close(done)
		defer cancel()
		defer writer.Close()
		for {
			f, e := ReadFrame(stream)
			if e != nil {
				_ = writer.CloseWithError(e)
				return
			}
			if f.Kind == EndFrame {
				_ = writer.Close()
				_, _ = ReadFrame(stream)
				return
			}
			if f.Kind != DataFrame {
				_ = writer.CloseWithError(ErrFrame)
				return
			}
			if _, e = writer.Write(f.Data); e != nil {
				return
			}
		}
	}()
	defer func() { cancel(); _ = body.Close(); _ = stream.Close(); <-done }()
	response, e := h.web.Do(ctx, member, request, body)
	if e != nil {
		code := "WEB_UNAVAILABLE"
		if errors.Is(e, ErrWebPolicy) {
			code = "WEB_POLICY"
		}
		if errors.Is(e, ErrWebTLS) {
			code = "WEB_TLS"
		}
		_ = sendError(stream, code)
		return
	}
	defer response.Body.Close()
	headers := responseHeaders(response.Header)
	if request.Method == "HEAD" || response.StatusCode == 204 || response.StatusCode == 304 {
		if WriteJSON(stream, HTTPResponse{"response", response.StatusCode, headers}) == nil {
			_ = WriteFrame(stream, EndFrame, nil)
		}
		return
	}
	if response.ContentLength > 256<<10 {
		if scheduled, ok := stream.(*scheduledStream); ok {
			scheduled.bulk()
		}
	}
	source := io.Reader(response.Body)
	if response.StatusCode != http.StatusPartialContent && strings.Contains(strings.ToLower(response.Header.Get("Content-Type")), "text/html") {
		if !canInject(response.Header) {
			_ = sendError(stream, "WEB_UNSUPPORTED_SECURITY_POLICY")
			return
		}
		var decoder io.ReadCloser
		var decodeErr error
		switch strings.ToLower(response.Header.Get("Content-Encoding")) {
		case "", "identity":
		case "gzip":
			decoder, decodeErr = gzip.NewReader(response.Body)
		case "deflate":
			decoder, decodeErr = zlib.NewReader(response.Body)
		default:
			_ = sendError(stream, "WEB_UNSUPPORTED_ENCODING")
			return
		}
		if decodeErr != nil {
			_ = sendError(stream, "WEB_RESPONSE_FAILED")
			return
		}
		if decoder != nil {
			defer decoder.Close()
			source = decoder
		}
		headers = withoutTransformedValidators(headers)
		injection := `<script src="/.tailmouse/shim.js"`
		if h.web.previewPrefix != "" {
			injection += ` data-tailmouse-prefix="` + html.EscapeString(h.web.previewPrefix) + `"`
		}
		if response.Request != nil && response.Request.URL.RequestURI() != request.Path {
			injection += ` data-tailmouse-path="` + html.EscapeString(response.Request.URL.RequestURI()) + `"`
		}
		source, e = injectHTML(source, injection+`></script>`)
		if e != nil {
			_ = sendError(stream, e.Error())
			return
		}
		headers = append(headers, [2]string{"Content-Security-Policy", previewPolicy})
	}
	if WriteJSON(stream, HTTPResponse{"response", response.StatusCode, headers}) != nil {
		return
	}
	buffer := make([]byte, ChunkSize)
	for {
		n, e := source.Read(buffer)
		if n > 0 {
			if WriteFrame(stream, DataFrame, buffer[:n]) != nil {
				return
			}
		}
		if e == io.EOF {
			_ = WriteFrame(stream, EndFrame, nil)
			return
		}
		if e != nil {
			_ = sendError(stream, "WEB_RESPONSE_FAILED")
			return
		}
		if ctx.Err() != nil {
			return
		}
	}
}
func canInject(h http.Header) bool {
	if h.Get("X-Frame-Options") != "" {
		return false
	}
	for _, policy := range h.Values("Content-Security-Policy") {
		fallback := ""
		script := ""
		element := ""
		for _, d := range strings.Split(policy, ";") {
			fields := strings.Fields(d)
			if len(fields) == 0 {
				continue
			}
			if fields[0] == "default-src" {
				fallback = " " + strings.Join(fields[1:], " ") + " "
			}
			if fields[0] == "frame-ancestors" && !strings.Contains(" "+strings.Join(fields[1:], " ")+" ", " * ") && !strings.Contains(" "+strings.Join(fields[1:], " ")+" ", " https: ") {
				return false
			}
			if fields[0] == "script-src-elem" {
				element = " " + strings.Join(fields[1:], " ") + " "
			}
			if fields[0] == "script-src" {
				script = " " + strings.Join(fields[1:], " ") + " "
			}
		}
		if script == "" {
			script = fallback
		}
		if element != "" {
			script = element
		}
		if script != "" && !strings.Contains(script, " 'self' ") {
			return false
		}
	}
	return true
}
func withoutTransformedValidators(headers [][2]string) [][2]string {
	result := make([][2]string, 0, len(headers))
	for _, h := range headers {
		switch strings.ToLower(h[0]) {
		case "etag", "last-modified", "content-md5", "digest", "content-encoding", "content-length", "accept-ranges", "content-range":
			continue
		}
		result = append(result, h)
	}
	return result
}

type WebSocketRequest struct {
	Type      string   `json:"type"`
	Path      string   `json:"path"`
	Protocols []string `json:"protocols"`
}
type SocketMessage struct {
	Type     string `json:"type"`
	Text     bool   `json:"text,omitempty"`
	Size     int    `json:"size"`
	Code     int    `json:"code,omitempty"`
	Reason   string `json:"reason,omitempty"`
	Protocol string `json:"protocol,omitempty"`
}

func (h *Host) serveWebSocket(parent context.Context, stream Stream, member string) {
	f, e := ReadFrame(stream)
	if e != nil {
		return
	}
	var request WebSocketRequest
	if Decode(f, &request) != nil || request.Type != "websocket" || len(request.Protocols) > 16 {
		return
	}
	u, e := h.web.requestURL(request.Path)
	if e != nil {
		_ = sendError(stream, "WEB_POLICY")
		return
	}
	for _, p := range request.Protocols {
		if len(p) > 128 || !safeHeader(p, "") {
			_ = sendError(stream, "WEB_POLICY")
			return
		}
	}
	ctx, cancel := context.WithCancel(parent)
	defer cancel()
	client := &http.Client{Transport: h.web.transport, Jar: h.web.jar(member), CheckRedirect: func(*http.Request, []*http.Request) error { return ErrWebPolicy }}
	header := http.Header{}
	header.Set("Origin", h.web.origin)
	connection, _, e := websocket.Dial(ctx, u.String(), &websocket.DialOptions{HTTPClient: client, HTTPHeader: header, Subprotocols: request.Protocols})
	if e != nil {
		_ = sendError(stream, "WEB_SOCKET_FAILED")
		return
	}
	defer connection.CloseNow()
	connection.SetReadLimit(1 << 20)
	if WriteJSON(stream, SocketMessage{Type: "websocket.open", Protocol: connection.Subprotocol()}) != nil {
		return
	}
	done := make(chan struct{})
	go func() {
		defer close(done)
		defer cancel()
		for {
			f, e := ReadFrame(stream)
			if e != nil {
				return
			}
			var m SocketMessage
			if Decode(f, &m) != nil {
				return
			}
			if m.Type == "websocket.close" {
				if (m.Code != 1000 && (m.Code < 3000 || m.Code > 4999)) || len(m.Reason) > 123 {
					return
				}
				_ = connection.Close(websocket.StatusCode(m.Code), m.Reason)
				return
			}
			if m.Type != "websocket.message" || m.Size < 0 || m.Size > 1<<20 {
				return
			}
			data := make([]byte, 0, m.Size)
			for {
				f, e = ReadFrame(stream)
				if e != nil {
					return
				}
				if f.Kind == EndFrame {
					break
				}
				if f.Kind != DataFrame || len(data)+len(f.Data) > m.Size {
					return
				}
				data = append(data, f.Data...)
			}
			if len(data) != m.Size {
				return
			}
			kind := websocket.MessageBinary
			if m.Text {
				kind = websocket.MessageText
			}
			write, cancelWrite := context.WithTimeout(ctx, 30*time.Second)
			e = connection.Write(write, kind, data)
			cancelWrite()
			if e != nil {
				return
			}
		}
	}()
	defer func() { cancel(); _ = stream.Close(); _ = connection.CloseNow(); <-done }()
	for {
		kind, data, e := connection.Read(ctx)
		if e != nil {
			code := int(websocket.CloseStatus(e))
			if code < 1000 {
				code = 1006
			}
			_ = WriteJSON(stream, SocketMessage{Type: "websocket.close", Code: code})
			return
		}
		if WriteJSON(stream, SocketMessage{Type: "websocket.message", Text: kind == websocket.MessageText, Size: len(data)}) != nil {
			return
		}
		for len(data) > 0 {
			n := min(len(data), ChunkSize)
			if WriteFrame(stream, DataFrame, data[:n]) != nil {
				return
			}
			data = data[n:]
		}
		if WriteFrame(stream, EndFrame, nil) != nil {
			return
		}
	}
}
