package share

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/url"
	"strings"
	"sync"
	"tailmouse/apps/cli/internal/flow"
	"tailmouse/apps/cli/internal/leash"
	"tailmouse/apps/cli/internal/platform/pty"
	"time"
)

var (
	ErrAuth     = errors.New("UNAUTHORIZED")
	ErrBusy     = errors.New("SESSION_BUSY")
	ErrExpired  = errors.New("EXPIRED")
	ErrReadonly = errors.New("READONLY")
)

type Stream interface {
	io.Reader
	io.Writer
	io.Closer
}
type Resource struct {
	ID          string `json:"id"`
	State       string `json:"state"`
	ReadOnly    bool   `json:"readOnly,omitempty"`
	InitialPath string `json:"initialPath,omitempty"`
	Origin      string `json:"origin,omitempty"`
	MaxFile     int64  `json:"maxFile,omitempty"`
	MaxTotal    int64  `json:"maxTotal,omitempty"`
	MaxFiles    int    `json:"maxFiles,omitempty"`
}
type Manifest struct {
	ContentPath      string     `json:"contentPath,omitempty"`
	TestSingleOrigin bool       `json:"testSingleOrigin,omitempty"`
	Title            string     `json:"title"`
	Resources        []Resource `json:"resources"`
	ContentOrigin    string     `json:"contentOrigin"`
	Transport        string     `json:"transport"`
}
type Welcome struct {
	Type       string   `json:"type"`
	Version    int      `json:"version"`
	Member     string   `json:"member"`
	Grant      string   `json:"grant"`
	Expires    int64    `json:"expires"`
	Generation uint64   `json:"generation"`
	Manifest   Manifest `json:"manifest"`
}
type Member struct {
	slot         int
	id, peer     string
	digest       [32]byte
	generation   uint64
	expires      time.Time
	control      Stream
	ctx          context.Context
	cancel       context.CancelFunc
	disconnected time.Time
	streams      map[Stream]string
	approved     bool
	approval     chan struct{}
}
type Host struct {
	events           chan Event
	scheduler        *flow.Scheduler
	mu               sync.Mutex
	options          Options
	id               string
	tokenDigest      [32]byte
	generation       uint64
	created, expires time.Time
	ctx              context.Context
	cancel           context.CancelFunc
	closed, paused   bool
	members          map[string]*Member
	connections      map[Stream]struct{}
	controller       string
	remoteAllowed    bool
	terminal         *Terminal
	web              *WebResource
	receiver         *Receiver
	workers          sync.WaitGroup
	closeOnce        sync.Once
	closeErr         error
}

func newSecret() string {
	var b [32]byte
	if _, e := rand.Read(b[:]); e != nil {
		panic("system randomness unavailable")
	}
	return base64.RawURLEncoding.EncodeToString(b[:])
}
func validSecret(v string) bool {
	b, e := base64.RawURLEncoding.DecodeString(v)
	return e == nil && len(b) == 32 && base64.RawURLEncoding.EncodeToString(b) == v
}
func sameSecret(d [32]byte, v string) bool {
	candidate := sha256.Sum256([]byte(v))
	return validSecret(v) && subtle.ConstantTimeCompare(d[:], candidate[:]) == 1
}

func NewHost(ctx context.Context, o Options, environ []string) (*Host, string, error) {
	if len(o.Argv) > 0 {
		snapshot, err := leash.NewCommand(o.Argv, o.Cwd, o.Title, environ, nil)
		if err != nil {
			return nil, "", ErrConfig
		}
		if err = pty.Preflight(snapshot); err != nil {
			return nil, "", ErrConfig
		}
	}
	c, cancel := context.WithCancel(ctx)
	h := &Host{events: make(chan Event, 32), options: o, id: randomID(), generation: 1, ctx: c, cancel: cancel, members: map[string]*Member{}, connections: map[Stream]struct{}{}, remoteAllowed: true}
	h.scheduler = flow.New(c)
	token := newSecret()
	h.tokenDigest = sha256.Sum256([]byte(token))
	fail := func(e error) (*Host, string, error) { _ = h.Close(); return nil, "", e }
	var e error
	if o.Target != "" {
		h.web, e = NewWeb(c, o.Target, o.AllowRemote, o.CAFile)
		if e != nil {
			return fail(e)
		}
		if base, err := url.Parse(o.ContentBase); err == nil && base.Host != "" {
			h.web.contentOrigin = base.Scheme + "://a-" + h.id + "-web." + base.Host
			if o.TestSingleOrigin {
				h.web.contentOrigin = base.Scheme + "://" + base.Host
				h.web.previewPrefix = "/.tailmouse/p/" + h.id + "/app"
			}
		}
	}
	if o.Directory != "" {
		h.receiver, e = NewReceiver(o.Directory, o.Cwd, o.MaxFile, o.MaxTotal, o.MaxFiles)
		if e != nil {
			return fail(e)
		}
	}
	if len(o.Argv) > 0 {
		h.terminal, e = NewTerminal(c, o, environ, h)
		if e != nil {
			return fail(e)
		}
	}
	return h, token, nil
}

// Ready starts the monotonic lifetime only after transport/resource startup.
func (h *Host) Ready() {
	h.mu.Lock()
	defer h.mu.Unlock()
	if !h.created.IsZero() {
		return
	}
	h.created = time.Now()
	if h.options.TTL > 0 {
		h.expires = h.created.Add(h.options.TTL)
	}
	h.workers.Add(1)
	go h.lifecycle()
}
func (h *Host) lifecycle() {
	defer h.workers.Done()
	tick := time.NewTicker(time.Second)
	defer tick.Stop()
	for {
		select {
		case <-h.ctx.Done():
			return
		case now := <-tick.C:
			h.mu.Lock()
			expired := !h.expires.IsZero() && !now.Before(h.expires)
			for id, m := range h.members {
				if !now.Before(m.expires) || !m.disconnected.IsZero() && now.Sub(m.disconnected) >= 60*time.Second {
					h.removeMemberLocked(id)
				}
			}
			h.mu.Unlock()
			if expired {
				h.cancel()
				return
			}
		}
	}
}
func (h *Host) Context() context.Context { return h.ctx }
func (h *Host) ID() string               { return h.id }
func (h *Host) Invitation(address, token string) (string, error) {
	if !validSecret(token) || len(address) == 0 || len(address) > 24000 {
		return "", ErrConfig
	}
	env := struct {
		V        int    `json:"v"`
		Session  string `json:"session"`
		Address  string `json:"address"`
		Token    string `json:"token"`
		Frontend int    `json:"frontend_major"`
	}{1, h.id, address, token, 1}
	b, e := json.Marshal(env)
	if e != nil || len(b) > 32768 {
		return "", ErrConfig
	}
	u, e := url.Parse(h.options.FrontendBase)
	if e != nil {
		return "", ErrConfig
	}
	if h.options.TestSingleOrigin {
		u.Path = "/.tailmouse/workspace/"
	} else {
		u.Host = "s-" + h.id + "." + u.Host
		u.Path = "/"
	}
	u.Fragment = "tm=" + base64.RawURLEncoding.EncodeToString(b)
	return u.String(), nil
}
func (h *Host) manifestLocked() Manifest {
	m := Manifest{TestSingleOrigin: h.options.TestSingleOrigin, Title: h.options.Title, Resources: []Resource{}, Transport: "Tailcat over DERP"}
	if h.terminal != nil {
		state := "READY"
		h.terminal.mu.Lock()
		if h.terminal.exited {
			state = "EXITED"
		}
		h.terminal.mu.Unlock()
		m.Resources = append(m.Resources, Resource{ID: "cli", State: state, ReadOnly: h.options.ReadOnly})
	}
	if h.web != nil {
		state := "READY"
		if !h.web.Available() {
			state = "UNAVAILABLE"
		}
		m.Resources = append(m.Resources, Resource{ID: "web", State: state, InitialPath: h.web.InitialPath(), Origin: h.web.OriginSummary()})
		u, _ := url.Parse(h.options.ContentBase)
		if h.options.TestSingleOrigin {
			m.ContentPath = "/.tailmouse/p/" + h.id + "/bridge.html"
		} else {
			u.Host = "a-" + h.id + "-web." + u.Host
		}
		m.ContentOrigin = strings.TrimSuffix(u.String(), "/")
	}
	if h.receiver != nil {
		m.Resources = append(m.Resources, Resource{ID: "receive", State: "READY", MaxFile: h.options.MaxFile, MaxTotal: h.options.MaxTotal, MaxFiles: h.options.MaxFiles})
	}
	return m
}
func (h *Host) removeMemberLocked(id string) {
	m := h.members[id]
	if m == nil {
		return
	}
	m.cancel()
	if m.control != nil {
		_ = m.control.Close()
	}
	for c := range m.streams {
		_ = c.Close()
	}
	delete(h.members, id)
	if h.controller == id {
		h.controller = ""
	}
	if h.web != nil {
		h.web.Forget(id)
	}
}
func (h *Host) liveLocked() bool {
	return !h.closed && h.ctx.Err() == nil && !h.created.IsZero() && (h.expires.IsZero() || time.Now().Before(h.expires))
}
func (h *Host) admit(hello Hello, peer string, stream Stream) (*Member, string, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if !h.liveLocked() {
		return nil, "", ErrExpired
	}
	if hello.Type != "hello" || hello.Version != 2 || hello.Session != h.id || peer == "" {
		return nil, "", ErrAuth
	}
	if hello.Token != "" {
		if hello.Channel != "control" || hello.Member != "" || hello.Grant != "" || hello.Resource != "" || h.paused || !sameSecret(h.tokenDigest, hello.Token) {
			return nil, "", ErrAuth
		}
		if len(h.members) >= h.options.MaxClients {
			return nil, "", ErrBusy
		}
		secret := newSecret()
		ctx, cancel := context.WithCancel(h.ctx)
		expires := time.Now().Add(time.Hour)
		if !h.expires.IsZero() && h.expires.Before(expires) {
			expires = h.expires
		}
		m := &Member{id: randomID(), peer: peer, digest: sha256.Sum256([]byte(secret)), generation: h.generation, expires: expires, control: stream, ctx: ctx, cancel: cancel, streams: map[Stream]string{}, approved: h.options.Approval == "auto", approval: make(chan struct{})}
		if m.approved {
			close(m.approval)
		}
		used := [5]bool{}
		for _, member := range h.members {
			if member.slot > 0 && member.slot < len(used) {
				used[member.slot] = true
			}
		}
		for slot := 1; slot < len(used); slot++ {
			if !used[slot] {
				m.slot = slot
				break
			}
		}
		h.members[m.id] = m
		if m.approved && h.controller == "" && h.remoteAllowed && !h.options.ReadOnly {
			h.controller = m.id
		}
		return m, secret, nil
	}
	m := h.members[hello.Member]
	if m == nil || m.peer != peer || m.generation != h.generation || !time.Now().Before(m.expires) || !sameSecret(m.digest, hello.Grant) || !m.approved {
		return nil, "", ErrAuth
	}
	if hello.Channel == "control" {
		if hello.Resource != "" {
			return nil, "", ErrAuth
		}
		m.cancel()
		if m.control != nil {
			_ = m.control.Close()
		}
		for c := range m.streams {
			_ = c.Close()
		}
		m.ctx, m.cancel = context.WithCancel(h.ctx)
		m.control = stream
		m.streams = map[Stream]string{}
		m.disconnected = time.Time{}
		if h.controller == "" && h.remoteAllowed && !h.options.ReadOnly {
			h.controller = m.id
		}
		return m, hello.Grant, nil
	}
	if m.control == nil || !m.disconnected.IsZero() {
		return nil, "", ErrAuth
	}
	switch hello.Channel {
	case "terminal":
		if hello.Resource != "cli" || h.terminal == nil {
			return nil, "", ErrAuth
		}
	case "http", "websocket":
		if hello.Resource != "web" || h.web == nil {
			return nil, "", ErrAuth
		}
	case "upload":
		if hello.Resource != "receive" || h.receiver == nil {
			return nil, "", ErrAuth
		}
	default:
		return nil, "", ErrAuth
	}
	count := 0
	httpCount := 0
	for _, member := range h.members {
		count += len(member.streams)
	}
	for _, kind := range m.streams {
		if kind == "http" || kind == "websocket" {
			httpCount++
		}
		if kind == "terminal" && hello.Channel == "terminal" {
			return nil, "", ErrBusy
		}
	}
	if count >= 64 || (hello.Channel == "http" || hello.Channel == "websocket") && httpCount >= 16 {
		return nil, "", ErrBusy
	}
	m.streams[stream] = hello.Channel
	return m, "", nil
}
func (h *Host) Serve(raw Stream, peer string) {
	stream := &scheduledStream{Stream: raw, ctx: h.ctx, scheduler: h.scheduler}
	h.mu.Lock()
	if h.closed || len(h.connections) >= 72 {
		h.mu.Unlock()
		_ = stream.Close()
		return
	}
	h.connections[stream] = struct{}{}
	h.workers.Add(1)
	h.mu.Unlock()
	defer h.workers.Done()
	defer stream.Close()
	defer func() { h.mu.Lock(); delete(h.connections, stream); h.mu.Unlock() }()
	timeout := time.AfterFunc(10*time.Second, func() { _ = stream.Close() })
	defer timeout.Stop()
	preface := make([]byte, len(Preface))
	if _, e := io.ReadFull(stream, preface); e != nil || string(preface) != Preface {
		return
	}
	f, e := ReadFrame(stream)
	if e != nil {
		return
	}
	var hello Hello
	if Decode(f, &hello) != nil {
		_ = sendError(stream, "BAD_FRAME")
		return
	}
	m, grant, e := h.admit(hello, peer, stream)
	if e != nil {
		_ = sendError(stream, e.Error())
		return
	}
	timeout.Stop()
	switch hello.Channel {
	case "terminal":
		stream.priority = 1
	case "http", "websocket":
		stream.priority = 2
	case "upload":
		stream.priority = 3
	}
	h.mu.Lock()
	ctx := m.ctx
	h.mu.Unlock()
	stop := context.AfterFunc(ctx, func() { _ = stream.Close() })
	defer stop()
	defer func() { h.mu.Lock(); delete(m.streams, stream); h.mu.Unlock() }()
	switch hello.Channel {
	case "control":
		h.control(ctx, stream, m, grant)
	case "terminal":
		h.terminal.Serve(ctx, stream, m.id)
	case "http":
		h.serveHTTP(ctx, stream, m.id)
	case "websocket":
		h.serveWebSocket(ctx, stream, m.id)
	case "upload":
		h.serveUpload(ctx, stream, m.id)
	}
}
func (h *Host) control(ctx context.Context, stream Stream, m *Member, grant string) {
	defer func() {
		h.mu.Lock()
		defer h.mu.Unlock()
		if m.control == stream {
			if !m.approved {
				h.removeMemberLocked(m.id)
				return
			}
			m.control = nil
			m.disconnected = time.Now()
			m.cancel()
			for c := range m.streams {
				_ = c.Close()
			}
			if h.controller == m.id {
				h.controller = ""
			}
		}
	}()
	frames := make(chan Frame, 1)
	done := make(chan struct{})
	readerDone := make(chan struct{})
	go func() {
		defer close(readerDone)
		for {
			f, e := ReadFrame(stream)
			if e != nil {
				close(frames)
				return
			}
			select {
			case frames <- f:
			case <-done:
				return
			}
		}
	}()
	defer func() { close(done); _ = stream.Close(); <-readerDone }()
	h.mu.Lock()
	approved := m.approved
	h.mu.Unlock()
	if !approved {
		h.emit(Event{Event: "member.waiting"})
		if WriteJSON(stream, struct {
			Type   string `json:"type"`
			Member string `json:"member"`
		}{"waiting", m.id}) != nil {
			return
		}
		select {
		case <-m.approval:
		case <-frames:
			return
		case <-ctx.Done():
			return
		}
	}
	h.mu.Lock()
	welcome := Welcome{"welcome", 2, m.id, grant, m.expires.UnixMilli(), h.generation, h.manifestLocked()}
	h.mu.Unlock()
	if WriteJSON(stream, welcome) != nil {
		return
	}
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	last := time.Now()
	var seq uint64
	var pending uint64
	for {
		select {
		case <-ctx.Done():
			return
		case f, ok := <-frames:
			if !ok {
				return
			}
			var message Message
			if Decode(f, &message) != nil {
				return
			}
			switch message.Type {
			case "pong":
				if pending != 0 && message.Seq == pending {
					last = time.Now()
					pending = 0
				}
			case "leave":
				h.mu.Lock()
				h.removeMemberLocked(m.id)
				h.mu.Unlock()
				return
			case "upload.status":
				if h.receiver == nil {
					return
				}
				receipt, e := h.receiver.Status(m.id, message.Upload)
				if e != nil {
					if sendError(stream, "UPLOAD_CLOSED") != nil {
						return
					}
				} else if WriteJSON(stream, receipt) != nil {
					return
				}
			case "web.reprobe":
				if h.web == nil {
					return
				}
				probe, cancel := context.WithTimeout(ctx, 5*time.Second)
				err := h.web.Reprobe(probe)
				cancel()
				state := "READY"
				if err != nil {
					state = "UNAVAILABLE"
				}
				if WriteJSON(stream, struct {
					Type  string `json:"type"`
					State string `json:"state"`
				}{"web.state", state}) != nil {
					return
				}
			default:
				return
			}
		case now := <-ticker.C:
			if now.Sub(last) >= 15*time.Second {
				return
			}
			if pending == 0 {
				seq++
				pending = seq
			}
			if WriteJSON(stream, Message{Type: "ping", Seq: pending}) != nil {
				return
			}
			h.mu.Lock()
			state := struct {
				Type       string     `json:"type"`
				Controller bool       `json:"controller"`
				Warning    bool       `json:"expiring"`
				Resources  []Resource `json:"resources"`
			}{"state", h.controller == m.id, !h.expires.IsZero() && time.Until(h.expires) <= 5*time.Minute, h.manifestLocked().Resources}
			h.mu.Unlock()
			if WriteJSON(stream, state) != nil {
				return
			}
		}
	}
}
func (h *Host) CanInput(member string) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.liveLocked() && !h.options.ReadOnly && h.controller == member && h.members[member] != nil && h.members[member].control != nil
}
func (h *Host) TakeLocal() { h.mu.Lock(); h.controller = ""; h.remoteAllowed = false; h.mu.Unlock() }
func (h *Host) Pause()     { h.mu.Lock(); h.paused = !h.paused; h.mu.Unlock() }
func (h *Host) Approve() bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, m := range h.members {
		if !m.approved {
			m.approved = true
			close(m.approval)
			if h.controller == "" && h.remoteAllowed && !h.options.ReadOnly {
				h.controller = m.id
			}
			return true
		}
	}
	return false
}
func (h *Host) GrantControl() bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.options.ReadOnly {
		return false
	}
	for _, m := range h.members {
		if m.approved && m.control != nil {
			h.remoteAllowed = true
			h.controller = m.id
			return true
		}
	}
	return false
}
func (h *Host) Rotate() string {
	h.mu.Lock()
	defer h.mu.Unlock()
	secret := newSecret()
	h.tokenDigest = sha256.Sum256([]byte(secret))
	h.generation++
	for id := range h.members {
		h.removeMemberLocked(id)
	}
	return secret
}
func (h *Host) Close() error {
	h.closeOnce.Do(func() {
		h.mu.Lock()
		h.closed = true
		h.tokenDigest = [32]byte{}
		h.cancel()
		for id := range h.members {
			h.removeMemberLocked(id)
		}
		for c := range h.connections {
			_ = c.Close()
		}
		h.mu.Unlock()
		h.workers.Wait()
		h.scheduler.Close()
		if h.terminal != nil {
			h.closeErr = h.terminal.Close()
		}
		if h.web != nil {
			h.web.Close()
		}
		if h.receiver != nil {
			h.closeErr = errors.Join(h.closeErr, h.receiver.Close())
		}
	})
	return h.closeErr
}
