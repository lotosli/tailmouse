//go:build js && wasm

// The resource bridge reuses one authenticated Tailcat client for all streams.
// It is TailMouse-owned adapter code; upstream remains read-only.
package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"hash"
	"io"
	"net"
	"net/url"
	"sync"
	"sync/atomic"
	"syscall/js"
	"tailmouse/apps/cli/internal/flow"
	"time"

	upstream "github.com/tailscale/tailcat"
	"tailscale.com/types/key"
)

var state struct {
	sync.Mutex
	client   *upstream.Client
	server   *upstream.Server
	listener net.Listener
	next     int
	dialing  int
	streams  map[int]*stream
	hashes   map[int]hash.Hash
}

var writes *flow.Scheduler

type stream struct {
	priority int
	net.Conn
	reading, writing atomic.Bool
}

func main() {
	writes = flow.New(context.Background())
	state.streams = map[int]*stream{}
	state.hashes = map[int]hash.Hash{}
	js.Global().Set("tailmouseResourceCall", js.FuncOf(call))
	if ready := js.Global().Get("onTailmouseResourceReady"); ready.Type() == js.TypeFunction {
		ready.Invoke()
	}
	select {}
}
func call(_ js.Value, args []js.Value) any {
	if len(args) != 3 || args[0].Type() != js.TypeString || args[1].Type() != js.TypeNumber {
		return promise(func() (any, error) { return nil, errors.New("BRIDGE_INPUT") })
	}
	op, id, value := args[0].String(), args[1].Int(), args[2]
	return promise(func() (any, error) {
		switch op {
		case "listen":
			source := value.Get("mapURL")
			if source.Type() != js.TypeString {
				return nil, errors.New("BRIDGE_INPUT")
			}
			u, err := url.Parse(source.String())
			if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || u.Fragment != "" {
				return nil, errors.New("BRIDGE_INPUT")
			}
			state.Lock()
			defer state.Unlock()
			if state.server != nil || state.client != nil {
				return nil, errors.New("BRIDGE_BUSY")
			}
			pk := upstream.NewPrivateKey()
			ci := pk.Public
			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()
			ci.RegionID = -1
			if ci.Expand(ctx, upstream.ExpandForServer, upstream.DERPMapURL(source.String())) != nil {
				return nil, errors.New("LISTEN_FAILED")
			}
			srv := &upstream.Server{Key: pk.Private, PresharedKey: pk.Public.PresharedKey, Region: ci.Region[0], Logf: func(string, ...any) {}}
			listener, err := srv.Listen(ctx, "tcp", ":44321")
			if err != nil {
				srv.Close()
				return nil, errors.New("LISTEN_FAILED")
			}
			state.server, state.listener = srv, listener
			return string(srv.TailcatAddr()), nil
		case "accept":
			state.Lock()
			listener, srv := state.listener, state.server
			full := len(state.streams) >= 16
			state.Unlock()
			if listener == nil || full {
				return nil, errors.New("BRIDGE_BUSY")
			}
			conn, err := listener.Accept()
			if err != nil {
				return nil, errors.New("ACCEPT_FAILED")
			}
			peer, ok := srv.PeerKey(conn.RemoteAddr())
			if !ok {
				conn.Close()
				return nil, errors.New("PEER_UNKNOWN")
			}
			state.Lock()
			defer state.Unlock()
			if len(state.streams) >= 16 {
				conn.Close()
				return nil, errors.New("BRIDGE_BUSY")
			}
			state.next++
			sid := state.next
			state.streams[sid] = &stream{Conn: conn, priority: 3}
			return map[string]any{"id": sid, "peer": peer.String()}, nil
		case "open":
			address := value.Get("address")
			secret := value.Get("key")
			if address.Type() != js.TypeString || len(address.String()) > 24000 {
				return nil, errors.New("BRIDGE_INPUT")
			}
			private := key.NewNode()
			if secret.Type() == js.TypeString && secret.String() != "" {
				if json.Unmarshal([]byte(secret.String()), &private) != nil || private.IsZero() {
					return nil, errors.New("BRIDGE_INPUT")
				}
			}
			state.Lock()
			if state.client != nil {
				state.Unlock()
				return nil, errors.New("BRIDGE_BUSY")
			}
			client := &upstream.Client{Server: upstream.Addr(address.String()), Key: private, Logf: func(string, ...any) {}}
			state.client = client
			state.Unlock()
			ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
			defer cancel()
			for {
				attempt, stop := context.WithTimeout(ctx, 5*time.Second)
				_, e := client.Ping(attempt)
				stop()
				if e == nil {
					break
				}
				if ctx.Err() != nil {
					client.Close()
					state.Lock()
					state.client = nil
					state.Unlock()
					return nil, errors.New("DIAL_FAILED")
				}
			}
			encoded, _ := json.Marshal(private)
			return string(encoded), nil
		case "dial":
			state.Lock()
			client := state.client
			full := len(state.streams)+state.dialing >= 72
			if client != nil && !full {
				state.dialing++
			}
			state.Unlock()
			if client == nil || full {
				return nil, errors.New("BRIDGE_BUSY")
			}
			ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
			defer cancel()
			connection, e := client.DialTCPPort(ctx, 44321)
			state.Lock()
			state.dialing--
			if e != nil {
				state.Unlock()
				return nil, errors.New("DIAL_FAILED")
			}
			state.next++
			sid := state.next
			priority := 2
			if value.Type() == js.TypeNumber {
				priority = value.Int()
			}
			if priority < 0 || priority > 3 {
				priority = 3
			}
			state.streams[sid] = &stream{Conn: connection, priority: priority}
			state.Unlock()
			return sid, nil
		case "read", "write", "close":
			state.Lock()
			s := state.streams[id]
			if op == "close" {
				delete(state.streams, id)
			}
			state.Unlock()
			if s == nil {
				if op == "close" {
					return nil, nil
				}
				return nil, errors.New("STREAM_CLOSED")
			}
			switch op {
			case "close":
				return nil, s.Close()
			case "read":
				if !s.reading.CompareAndSwap(false, true) {
					return nil, errors.New("READ_BUSY")
				}
				defer s.reading.Store(false)
				buffer := make([]byte, 32768)
				n, e := s.Read(buffer)
				if n > 0 {
					out := js.Global().Get("Uint8Array").New(n)
					js.CopyBytesToJS(out, buffer[:n])
					return out, nil
				}
				if e == io.EOF {
					return js.Null(), nil
				}
				return nil, errors.New("READ_FAILED")
			case "write":
				if !s.writing.CompareAndSwap(false, true) {
					return nil, errors.New("WRITE_BUSY")
				}
				defer s.writing.Store(false)
				data, e := bytes(value)
				if e != nil {
					return nil, e
				}
				_ = s.SetWriteDeadline(time.Now().Add(30 * time.Second))
				for len(data) > 0 {
					n, e := writes.Write(context.Background(), s.priority, func() (int, error) { return s.Write(data) })
					if e != nil || n == 0 {
						return nil, errors.New("WRITE_FAILED")
					}
					data = data[n:]
				}
				return nil, nil
			}
		case "hash.start":
			state.Lock()
			defer state.Unlock()
			if len(state.hashes) >= 2 {
				return nil, errors.New("HASH_BUSY")
			}
			state.next++
			state.hashes[state.next] = sha256.New()
			return state.next, nil
		case "hash.update", "hash.finish", "hash.cancel":
			state.Lock()
			defer state.Unlock()
			digest := state.hashes[id]
			if digest == nil {
				return nil, errors.New("HASH_CLOSED")
			}
			if op == "hash.cancel" {
				delete(state.hashes, id)
				return nil, nil
			}
			if op == "hash.finish" {
				delete(state.hashes, id)
				return hex.EncodeToString(digest.Sum(nil)), nil
			}
			data, e := bytes(value)
			if e != nil {
				return nil, e
			}
			_, _ = digest.Write(data)
			return nil, nil
		}
		return nil, errors.New("BRIDGE_INPUT")
	})
}
func bytes(value js.Value) ([]byte, error) {
	if value.Type() != js.TypeObject || !value.InstanceOf(js.Global().Get("Uint8Array")) {
		return nil, errors.New("BRIDGE_INPUT")
	}
	n := value.Get("byteLength").Int()
	if n < 0 || n > 65540 {
		return nil, errors.New("BRIDGE_INPUT")
	}
	b := make([]byte, n)
	js.CopyBytesToGo(b, value)
	return b, nil
}
func promise(work func() (any, error)) js.Value {
	executor := js.FuncOf(func(_ js.Value, args []js.Value) any {
		resolve, reject := args[0], args[1]
		go func() {
			value, e := work()
			if e != nil {
				reject.Invoke(js.Global().Get("Error").New("TailMouse bridge operation failed"))
				return
			}
			resolve.Invoke(value)
		}()
		return nil
	})
	result := js.Global().Get("Promise").New(executor)
	executor.Release()
	return result
}
