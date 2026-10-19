package share

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func digest(value string) string { v := sha256.Sum256([]byte(value)); return hex.EncodeToString(v[:]) }
func receiver(t *testing.T, max int64) *Receiver {
	t.Helper()
	r, e := NewReceiver(t.TempDir(), t.TempDir(), max, max*2, 100)
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() {
		if e := r.Close(); e != nil {
			t.Error(e)
		}
	})
	return r
}
func TestReceiveCommitIsIdempotentAndPrivate(t *testing.T) {
	r := receiver(t, 1024)
	u, e := r.Begin("member", "report.csv", 5)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = u.Write([]byte("hello")); e != nil {
		t.Fatal(e)
	}
	a, e := u.Finish(context.Background(), digest("hello"))
	if e != nil {
		t.Fatal(e)
	}
	b, e := u.Finish(context.Background(), "ignored after success")
	if e != nil || a != b {
		t.Fatal("duplicate commit", e)
	}
	content, e := r.root.ReadFile(a.Name)
	if e != nil || string(content) != "hello" {
		t.Fatal("committed content", e)
	}
	info, e := r.root.Stat(a.Name)
	if e != nil || info.Mode().Perm() != 0600 {
		t.Fatal("file permissions", e)
	}
	if _, e = r.Status("another", a.Upload); !errors.Is(e, ErrUploadClosed) {
		t.Fatal("receipt crossed member boundary")
	}
	if got, e := r.Status("member", a.Upload); e != nil || got != a {
		t.Fatal("lost acknowledgement cannot recover")
	}
	if filepath.IsAbs(a.Path) {
		t.Fatal("absolute path exposed")
	}
	if e = u.Cancel(); e != nil {
		t.Fatal(e)
	}
}
func TestReceiveNamesAndNormalization(t *testing.T) {
	for _, name := range []string{"", "../file", ".hidden", "dir/file", "dir\\file", "NUL", "con.txt", "COM1.log", "LPT9", "x\x00y", "x\ny", "a%2fb", "a%5Cb", "a%00b", "a:b", "trailing.", " trailing", strings.Repeat("x", 181), string([]byte{0xff})} {
		if _, e := SafeName(name); e == nil {
			t.Errorf("accepted unsafe name %q", name)
		}
	}
	if got, e := SafeName("cafe\u0301.txt"); e != nil || got != "café.txt" {
		t.Fatal("NFC normalization", got, e)
	}
}
func TestReceiveQuotasDoNotRefundCanceledTraffic(t *testing.T) {
	r := receiver(t, 5)
	r.maxTotal = 5
	r.maxFiles = 4
	u, e := r.Begin("m", "x", 5)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = r.Begin("m", "y", 1); e != ErrUploadLimit {
		t.Fatal("reservation not enforced")
	}
	if _, e = u.Write([]byte("abc")); e != nil {
		t.Fatal(e)
	}
	if e = u.Cancel(); e != nil {
		t.Fatal(e)
	}
	if _, e = r.Begin("m", "y", 3); e != ErrUploadLimit {
		t.Fatal("consumed bytes refunded")
	}
	u, e = r.Begin("m", "y", 2)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = u.Write([]byte("de")); e != nil {
		t.Fatal(e)
	}
	if _, e = u.Finish(context.Background(), digest("de")); e != nil {
		t.Fatal(e)
	}
	if _, e = r.Begin("m", "z", 0); e != ErrUploadLimit {
		t.Fatal("attempt budget refunded")
	}
}
func TestReceiveFailureAndZeroFile(t *testing.T) {
	r := receiver(t, 10)
	a, e := r.Begin("m", "empty", 0)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = a.Finish(context.Background(), digest("")); e != nil {
		t.Fatal(e)
	}
	b, e := r.Begin("m", "bad", 3)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = b.Write([]byte("abc")); e != nil {
		t.Fatal(e)
	}
	if _, e = b.Finish(context.Background(), digest("abd")); e != ErrUploadHash {
		t.Fatal("hash mismatch committed")
	}
	if e = b.Cancel(); e != nil {
		t.Fatal(e)
	}
	c, e := r.Begin("m", "excess", 1)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = c.Write([]byte("ab")); e != ErrUploadLimit {
		t.Fatal("false size accepted")
	}
	if e = c.Cancel(); e != nil {
		t.Fatal(e)
	}
	d, e := r.Begin("m", "unfinished", 2)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = d.Finish(context.Background(), digest("")); e != ErrUploadHash {
		t.Fatal("incomplete file committed")
	}
	if e = r.Close(); e != nil {
		t.Fatal(e)
	}
	if _, e = d.Write(nil); e != ErrUploadClosed {
		t.Fatal(e)
	}
	if _, e = r.Begin("m", "late", 0); e != ErrUploadClosed {
		t.Fatal(e)
	}
}
func TestReceiveDirectorySwapStaysAnchored(t *testing.T) {
	parent := t.TempDir()
	root := filepath.Join(parent, "uploads")
	moved := filepath.Join(parent, "moved")
	outside := t.TempDir()
	if e := os.Mkdir(root, 0700); e != nil {
		t.Fatal(e)
	}
	r, e := NewReceiver(root, parent, 10, 20, 10)
	if e != nil {
		t.Fatal(e)
	}
	defer r.Close()
	u, e := r.Begin("m", "data", 3)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = u.Write([]byte("abc")); e != nil {
		t.Fatal(e)
	}
	if e = os.Rename(root, moved); e != nil {
		t.Fatal(e)
	}
	if e = os.Symlink(outside, root); e != nil {
		t.Fatal(e)
	}
	a, e := u.Finish(context.Background(), digest("abc"))
	if e != nil {
		t.Fatal(e)
	}
	if _, e = os.Stat(filepath.Join(moved, a.Name)); e != nil {
		t.Fatal(e)
	}
	entries, e := os.ReadDir(outside)
	if e != nil || len(entries) != 0 {
		t.Fatal("write escaped opened directory")
	}
}
func TestReceiveRejectsUnsafeRootAndStage(t *testing.T) {
	if _, e := NewReceiver("/", "/", 10, 20, 2); e != ErrConfig {
		t.Fatal("root accepted")
	}
	root := t.TempDir()
	if e := os.Symlink(t.TempDir(), filepath.Join(root, ".tailmouse-partials")); e != nil {
		t.Fatal(e)
	}
	if _, e := NewReceiver(root, root, 10, 20, 2); e != ErrUploadStorage {
		t.Fatal("symlink stage accepted", e)
	}
}

func TestReceiveCanceledCommitAndBoundedFinalNames(t *testing.T) {
	r := receiver(t, 10)
	u, err := r.Begin("m", strings.Repeat("\u754c", 59)+".x", 0)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if _, err = u.Finish(ctx, digest("")); err != ErrUploadClosed {
		t.Fatal("canceled upload committed")
	}
	result, err := u.Finish(t.Context(), digest(""))
	if err != nil {
		t.Fatal(err)
	}
	if _, err = SafeName(result.Name); err != nil {
		t.Fatal("final name exceeded UTF-8 filename policy")
	}
	v, err := r.Begin("m", "a."+strings.Repeat("x", 175), 0)
	if err != nil {
		t.Fatal(err)
	}
	result, err = v.Finish(t.Context(), digest(""))
	if err != nil {
		t.Fatal(err)
	}
	if _, err = SafeName(result.Name); err != nil {
		t.Fatal("long extension bypassed name bound")
	}
}
