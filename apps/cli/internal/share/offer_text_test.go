package share

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func offerFixture(t *testing.T, single bool) (*FileOffer, string) {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "report.txt"), []byte("hello report"), 0600); err != nil {
		t.Fatal(err)
	}
	target := dir
	if single {
		target = filepath.Join(dir, "report.txt")
	}
	offer, err := NewFileOffer(target, single, 1024, 2048, 4)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = offer.Close() })
	return offer, dir
}
func TestFileOffersConfineAndPage(t *testing.T) {
	o, dir := offerFixture(t, false)
	for _, name := range []string{".hidden", "visible"} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte("x"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Mkdir(filepath.Join(dir, "nested"), 0700); err != nil {
		t.Fatal(err)
	}
	_ = os.WriteFile(filepath.Join(dir, "nested", "result.txt"), []byte("nested"), 0600)
	list, err := o.List("", 0)
	if err != nil || len(list.Entries) != 3 {
		t.Fatalf("visible files: %+v %v", list, err)
	}
	for _, name := range []string{"../secret", "/absolute", ".hidden", "nested/../report.txt", "nested\\report.txt", "a:b", "./report.txt", strings.Repeat("a", 181)} {
		if _, err := o.open(name); err == nil {
			t.Fatalf("accepted %q", name)
		}
	}
	for _, request := range []struct {
		path   string
		offset int
	}{{"../", 0}, {"", -1}, {"", 10001}, {"report.txt", 0}, {"missing", 0}} {
		if _, err := o.List(request.path, request.offset); err == nil {
			t.Fatal("invalid listing accepted")
		}
	}
	list, err = o.List("nested", 0)
	if err != nil || len(list.Entries) != 1 || list.Entries[0].Path != "nested/result.txt" {
		t.Fatal(list, err)
	}
	if _, err := o.List("nested", 100); err != nil {
		t.Fatal(err)
	}
	outside := filepath.Join(t.TempDir(), "private.txt")
	_ = os.WriteFile(outside, []byte("private"), 0600)
	if err := os.Symlink(outside, filepath.Join(dir, "link")); err == nil {
		if _, err := o.open("link"); err == nil {
			t.Fatal("symlink exposed")
		}
		list, err = o.List("", 0)
		if err != nil {
			t.Fatal(err)
		}
		for _, entry := range list.Entries {
			if entry.Name == "link" {
				t.Fatal("listed link")
			}
		}
	}
	for i := 0; i < 45; i++ {
		f, err := os.CreateTemp(dir, "page-")
		if err != nil {
			t.Fatal(err)
		}
		_ = f.Close()
	}
	list, err = o.List("", 0)
	if err != nil || !list.More || list.Next != 40 {
		t.Fatal(list, err)
	}
	next, err := o.List("", list.Next)
	if err != nil || next.More || len(next.Entries) == 0 {
		t.Fatal(next, err)
	}
	single, _ := offerFixture(t, true)
	list, err = single.List("", 0)
	if err != nil || len(list.Entries) != 1 {
		t.Fatal(list, err)
	}
	if _, err = single.List("nested", 0); err == nil {
		t.Fatal("single-file listing escaped")
	}
	if _, err = single.open("other"); err == nil {
		t.Fatal("single-file download escaped")
	}
	for _, tc := range []struct {
		path   string
		single bool
		limit  int64
	}{{dir, false, 0}, {filepath.Join(dir, "missing"), true, 1024}, {dir, true, 1024}, {filepath.Join(dir, ".hidden"), true, 1024}} {
		if candidate, err := NewFileOffer(tc.path, tc.single, tc.limit, 2048, 1); err == nil {
			_ = candidate.Close()
			t.Fatal("bad offer accepted")
		}
	}
	big := filepath.Join(dir, "too-big")
	_ = os.WriteFile(big, make([]byte, 1025), 0600)
	if _, err = o.open("too-big"); err == nil {
		t.Fatal("oversized file accepted")
	}
	if _, err = NewFileOffer(big, true, 1024, 2048, 1); err == nil {
		t.Fatal("oversized startup accepted")
	}
}
func directOffer(t *testing.T, o *FileOffer, request any, ctx context.Context) net.Conn {
	t.Helper()
	client, server := net.Pipe()
	_ = client.SetDeadline(time.Now().Add(time.Second))
	go func() { defer server.Close(); o.Serve(ctx, server) }()
	t.Cleanup(func() { _ = client.Close() })
	if err := WriteJSON(client, request); err != nil {
		t.Fatal(err)
	}
	return client
}
func TestDownloadFramesAndBudgets(t *testing.T) {
	o, _ := offerFixture(t, true)
	c := directOffer(t, o, FileRequest{Type: "files.list"}, context.Background())
	var list FileList
	objectFrom(t, c, &list)
	if len(list.Entries) != 1 {
		t.Fatal(list)
	}
	c = directOffer(t, o, FileRequest{Type: "download.begin", Path: "report.txt"}, context.Background())
	var ready struct {
		Type, Name string
		Size       int64
	}
	objectFrom(t, c, &ready)
	if ready.Type != "download.ready" || ready.Size != 12 {
		t.Fatal(ready)
	}
	f, err := ReadFrame(c)
	if err != nil || f.Kind != DataFrame || string(f.Data) != "hello report" {
		t.Fatal(f, err)
	}
	f, err = ReadFrame(c)
	if err != nil || f.Kind != EndFrame {
		t.Fatal(f, err)
	}
	var done struct {
		Type, SHA256 string
		Size         int64
	}
	objectFrom(t, c, &done)
	digest := sha256.Sum256([]byte("hello report"))
	if done.Type != "download.completed" || done.SHA256 != hex.EncodeToString(digest[:]) {
		t.Fatal(done)
	}
	if _, err := io.Copy(io.Discard, c); err != nil {
		t.Fatal(err)
	}
	for _, request := range []FileRequest{{Type: "files.list", Path: "../"}, {Type: "unknown"}, {Type: "download.begin", Path: "../report.txt"}, {Type: "download.begin", Path: "report.txt", Offset: 1}} {
		c = directOffer(t, o, request, context.Background())
		var failure WireError
		objectFrom(t, c, &failure)
		if failure.Type != "error" {
			t.Fatal(failure)
		}
	}
	first, second := o.reserve(1000), o.reserve(1000)
	if !first || !second || o.reserve(1) {
		t.Fatal("concurrency/budget not enforced")
	}
	o.mu.Lock()
	o.active = 0
	o.remaining = 0
	o.mu.Unlock()
	if o.reserve(1) {
		t.Fatal("traffic quota ignored")
	}
	c = directOffer(t, o, FileRequest{Type: "download.begin", Path: "report.txt"}, context.Background())
	var failure WireError
	objectFrom(t, c, &failure)
	if failure.Code != "TRANSFER_LIMIT" {
		t.Fatal(failure)
	}
	other, _ := offerFixture(t, true)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	c = directOffer(t, other, FileRequest{Type: "download.begin", Path: "report.txt"}, ctx)
	objectFrom(t, c, &ready)
	if _, err = ReadFrame(c); err != io.EOF {
		t.Fatal("canceled download completed", err)
	}
}
func TestNewResourcesAuthenticateAndText(t *testing.T) {
	for _, command := range []string{"send", "files", "text"} {
		t.Run(command, func(t *testing.T) {
			dir := t.TempDir()
			file := filepath.Join(dir, "result.txt")
			_ = os.WriteFile(file, []byte("ok"), 0600)
			arg := dir
			if command == "send" {
				arg = file
			}
			if command == "text" {
				arg = "hello"
			}
			o, _, err := Parse([]string{command, arg}, nil, t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			h, token, err := NewHost(context.Background(), o, nil)
			if err != nil {
				t.Fatal(err)
			}
			h.Ready()
			defer h.Close()
			_, welcome := welcomeHost(t, h, token, "peer-a")
			channel, resource := "download", "files"
			if command == "text" {
				channel, resource = "text", "text"
			}
			hello := Hello{Type: "hello", Version: 2, Session: h.ID(), Channel: channel, Resource: resource, Member: welcome.Member, Grant: welcome.Grant}
			c := openHost(t, h, "peer-b", hello)
			var denied WireError
			objectFrom(t, c, &denied)
			if denied.Code != "UNAUTHORIZED" {
				t.Fatal(denied)
			}
			c = openHost(t, h, "peer-a", hello)
			if command == "text" {
				_ = WriteJSON(c, TextMessage{Type: "text.set", Text: "visitor text"})
				var value TextMessage
				objectFrom(t, c, &value)
				if value.Text != "visitor text" || h.TextValue() != value.Text {
					t.Fatal(value)
				}
				c = openHost(t, h, "peer-a", hello)
				_ = WriteJSON(c, TextMessage{Type: "text.get"})
				objectFrom(t, c, &value)
				if value.Text != "visitor text" {
					t.Fatal(value)
				}
				for _, message := range []TextMessage{{Type: "unknown"}, {Type: "text.get", Text: "bad"}, {Type: "text.set", Text: "\x1b[31m"}, {Type: "text.set", Text: strings.Repeat("a", MaxText+1)}} {
					c = openHost(t, h, "peer-a", hello)
					_ = WriteJSON(c, message)
					objectFrom(t, c, &denied)
					if denied.Code != "BAD_FRAME" {
						t.Fatal(denied)
					}
				}
			} else {
				_ = WriteJSON(c, FileRequest{Type: "files.list"})
				var list FileList
				objectFrom(t, c, &list)
				if len(list.Entries) != 1 {
					t.Fatal(list)
				}
			}
			h.Close()
			if h.TextValue() != "" {
				t.Fatal("text survived close")
			}
		})
	}
	for _, text := range []string{"\x00", "\x1b", string([]byte{255}), strings.Repeat("a", MaxText+1)} {
		if ValidText(text) {
			t.Fatal("invalid text accepted")
		}
	}
	if !ValidText("hello\n\u4e16\u754c\ttext\r\n") {
		t.Fatal("valid text rejected")
	}
}
