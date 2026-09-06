package session

import (
	"bytes"
	"context"
	"errors"
	"io"
	"testing"
	"testing/synctest"
	"time"

	"tailmouse/apps/cli/internal/protocol"
)

func TestHostPeerLivenessDeadline(t *testing.T) {
	for _, scenario := range []string{"silent", "valid", "duplicate", "stale", "wrong-sequence", "wrong-timestamp", "other-peer", "non-pong"} {
		t.Run(scenario, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				host := newTestHost(t, "leash", false)
				browser, _ := connectTestHost(t, host, "leash", testHostID, 2)
				if err := browser.SetDeadline(time.Time{}); err != nil {
					t.Fatal(err)
				}
				started := time.Now()
				owner := host.Authority.Inspect(started).Owner
				pings := make(chan []byte, 1)
				ended := make(chan error, 1)
				go func() {
					for {
						frame, err := protocol.ReadFrame(context.Background(), browser, protocol.PeerBrowser, protocol.StateActiveLeash)
						if err != nil {
							ended <- err
							return
						}
						if frame.Type == protocol.TypePing {
							select {
							case <-pings:
							default:
							}
							pings <- frame.Payload
						}
					}
				}()
				write := func(kind protocol.MessageType, payload []byte) {
					t.Helper()
					if err := protocol.WriteFrame(context.Background(), browser, protocol.PeerBrowser, protocol.StateActiveLeash,
						protocol.Frame{Type: kind, Payload: payload}); err != nil {
						t.Fatal(err)
					}
					synctest.Wait()
				}
				time.Sleep(time.Second)
				synctest.Wait()
				stale := <-pings
				deadline := started.Add(30 * time.Second)
				if scenario != "silent" {
					time.Sleep(4 * time.Second)
					synctest.Wait()
					accepted := <-pings
					write(protocol.TypePong, accepted)
					deadline = time.Now().Add(30 * time.Second)
					time.Sleep(29 * time.Second)
					synctest.Wait()
					payload := bytes.Clone(<-pings)
					switch scenario {
					case "valid":
						write(protocol.TypePong, payload)
						deadline = time.Now().Add(30 * time.Second)
					case "duplicate":
						write(protocol.TypePong, accepted)
					case "stale":
						write(protocol.TypePong, stale)
					case "wrong-sequence":
						payload[0] ^= 1
						write(protocol.TypePong, payload)
					case "wrong-timestamp":
						payload[15] ^= 1
						write(protocol.TypePong, payload)
					case "other-peer":
						other, response := connectTestHost(t, host, "leash", testHostID, 2)
						if code, _ := protocol.ErrorCodeOf(protocol.DecodeError(response)); code != protocol.CodeSessionBusy {
							t.Fatal("live owner was displaced by another peer")
						}
						_ = other.Close()
						synctest.Wait()
					case "non-pong":
						write(protocol.TypePing, payload)
					}
				}
				time.Sleep(time.Until(deadline) - time.Nanosecond)
				synctest.Wait()
				if snapshot := host.Authority.Inspect(time.Now()); snapshot.State != Active || snapshot.Owner != owner {
					t.Fatal("peer was declared lost before the 30-second boundary")
				}
				time.Sleep(time.Nanosecond)
				synctest.Wait()
				if snapshot := host.Authority.Inspect(time.Now()); snapshot.State != Listening || snapshot.Owner != 0 || !snapshot.GraceDeadline.IsZero() {
					t.Fatal("missing PONG did not return the live Leash share to listening at 30 seconds")
				}
				select {
				case err := <-ended:
					if !errors.Is(err, io.EOF) {
						t.Fatal("lost stream did not reach EOF")
					}
				default:
					t.Fatal("lost stream or reader remained alive")
				}
				host.mu.Lock()
				remaining := len(host.connections)
				host.mu.Unlock()
				if remaining != 0 {
					t.Fatal("lost connection retained a worker")
				}
				replacement, welcome := connectTestHost(t, host, "leash", testHostID, 2)
				if welcome.Type != protocol.TypeServerWelcome || host.Authority.Inspect(time.Now()).Owner == owner {
					t.Fatal("replacement did not acquire a fresh lease")
				}
				_ = replacement.Close()
			})
		})
	}
}
