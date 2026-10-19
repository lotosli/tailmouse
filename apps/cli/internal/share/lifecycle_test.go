package share

import (
	"encoding/json"
	"strings"
	"testing"
	"testing/synctest"
	"time"
)

func TestControlHeartbeatRejectsReplayAndExpiresSilentMember(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		h, token := testHost(t, false)
		c, w := welcomeHost(t, h, token, "peer")
		_ = c.SetDeadline(time.Time{})
		start := time.Now()
		var first Message
		objectFrom(t, c, &first)
		if first.Type != "ping" || first.Seq == 0 {
			t.Fatal("missing heartbeat challenge")
		}
		var state map[string]any
		objectFrom(t, c, &state)
		if state["type"] != "state" {
			t.Fatal("missing periodic state")
		}
		// An unissued sequence must not extend member liveness.
		if err := WriteJSON(c, Message{Type: "pong", Seq: first.Seq + 1}); err != nil {
			t.Fatal(err)
		}
		for {
			_, err := ReadFrame(c)
			if err != nil {
				break
			}
		}
		synctest.Wait()
		if elapsed := time.Since(start); elapsed < 15*time.Second || elapsed > 20*time.Second {
			t.Fatal("heartbeat budget not enforced", elapsed)
		}
		if h.CanInput(w.Member) {
			t.Fatal("silent member retained input")
		}
		stream := openHost(t, h, "peer", Hello{Type: "hello", Version: 2, Session: h.ID(), Channel: "http", Resource: "web", Member: w.Member, Grant: w.Grant})
		var denied WireError
		objectFrom(t, stream, &denied)
		if denied.Code != "UNAUTHORIZED" {
			t.Fatal("disconnected grant opened a resource")
		}
	})
}
func TestControlHeartbeatLeaveAndResumeDeadline(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		h, token := testHost(t, false)
		c, w := welcomeHost(t, h, token, "peer")
		_ = c.SetDeadline(time.Time{})
		for i := 0; i < 4; i++ {
			var ping Message
			objectFrom(t, c, &ping)
			var state map[string]any
			objectFrom(t, c, &state)
			if ping.Type != "ping" || ping.Seq != uint64(i+1) {
				t.Fatal("heartbeat challenge not fresh")
			}
			if err := WriteJSON(c, Message{Type: "pong", Seq: ping.Seq}); err != nil {
				t.Fatal(err)
			}
		}
		if !h.CanInput(w.Member) {
			t.Fatal("responsive member expired")
		}
		if err := WriteJSON(c, Message{Type: "leave"}); err != nil {
			t.Fatal(err)
		}
		_, _ = ReadFrame(c)
		synctest.Wait()
		if len(h.Members()) != 0 {
			t.Fatal("leave retained capacity")
		}
		// TTL stays absolute across member reconnect and cannot be extended by traffic.
		time.Sleep(41 * time.Second)
		synctest.Wait()
		if h.Context().Err() == nil {
			t.Fatal("absolute session lifetime extended")
		}
	})
}
func TestLocalVisitorSelectionAndRedactedEvents(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		h, token := testHost(t, true)
		c := openHost(t, h, "peer", Hello{Type: "hello", Version: 2, Session: h.ID(), Channel: "control", Token: token})
		var waiting struct {
			Type   string `json:"type"`
			Member string `json:"member"`
		}
		objectFrom(t, c, &waiting)
		slots := h.Members()
		if len(slots) != 1 || slots[0].Slot != 1 || slots[0].Approved || h.GrantMember(1) || h.ApproveMember(9) {
			t.Fatal("pending visitor authority")
		}
		select {
		case event := <-h.Events():
			b, _ := json.Marshal(event)
			if string(b) != `{"event":"member.waiting"}` || strings.Contains(string(b), token) {
				t.Fatal("event leaked invitation or content")
			}
		default:
			t.Fatal("missing local approval notice")
		}
		if !h.ApproveMember(1) {
			t.Fatal("slot approval failed")
		}
		var w Welcome
		objectFrom(t, c, &w)
		if h.ApproveMember(1) || !h.GrantMember(1) || !h.CanInput(w.Member) {
			t.Fatal("slot control state")
		}
		h.TakeLocal()
		if h.CanInput(w.Member) {
			t.Fatal("local priority lost")
		}
		if !h.RevokeMember(1) || h.RevokeMember(1) {
			t.Fatal("slot revoke failed")
		}
		if _, err := ReadFrame(c); err == nil {
			t.Fatal("revoked control stream stayed open")
		}
		// A waiting visitor who disconnects must release its capacity without approval.
		pending := openHost(t, h, "peer-2", Hello{Type: "hello", Version: 2, Session: h.ID(), Channel: "control", Token: token})
		objectFrom(t, pending, &waiting)
		_ = pending.Close()
		synctest.Wait()
		if len(h.Members()) != 0 {
			t.Fatal("pending disconnect leaked a member")
		}
	})
}
