//go:build darwin || linux

package share

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCrashCleanupRemovesOnlyAuthenticatedAbandonedPartials(t *testing.T) {
	root := t.TempDir()
	r, e := NewReceiver(root, root, 1024, 2048, 100)
	if e != nil {
		t.Fatal(e)
	}
	upload, e := r.Begin("member", "pending.txt", 3)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = upload.Write([]byte("abc")); e != nil {
		t.Fatal(e)
	}
	// A second live host cannot clean this host's locked directory.
	second, e := NewReceiver(root, root, 1024, 2048, 100)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = r.stage.Stat(upload.temporary); e != nil {
		t.Fatal("live upload removed")
	}
	if e = second.Close(); e != nil {
		t.Fatal(e)
	}
	unknown := strings.Repeat("b", 32)
	if e = os.Mkdir(filepath.Join(root, ".tailmouse-partials", unknown), 0700); e != nil {
		t.Fatal(e)
	}
	if e = os.WriteFile(filepath.Join(root, ".tailmouse-partials", unknown, "user-file"), []byte("keep"), 0600); e != nil {
		t.Fatal(e)
	}
	// Model abrupt process exit: descriptors close without application cleanup.
	for _, f := range []*os.File{upload.file, r.ownership, r.sessionDirectory, r.rootDirectory} {
		if e = f.Close(); e != nil {
			t.Fatal(e)
		}
	}
	if e = r.stage.Close(); e != nil {
		t.Fatal(e)
	}
	if e = r.root.Close(); e != nil {
		t.Fatal(e)
	}
	restarted, e := NewReceiver(root, root, 1024, 2048, 100)
	if e != nil {
		t.Fatal(e)
	}
	defer restarted.Close()
	if _, e = os.Stat(filepath.Join(root, r.stageName)); !os.IsNotExist(e) {
		t.Fatal("abandoned owned partials survived")
	}
	if b, e := os.ReadFile(filepath.Join(root, ".tailmouse-partials", unknown, "user-file")); e != nil || string(b) != "keep" {
		t.Fatal("unowned files were removed")
	}
}
func TestAtomicCommitNeverReplacesExistingDestination(t *testing.T) {
	r := receiver(t, 100)
	u, e := r.Begin("m", "name", 3)
	if e != nil {
		t.Fatal(e)
	}
	defer u.Cancel()
	if _, e = u.Write([]byte("new")); e != nil {
		t.Fatal(e)
	}
	if e = r.root.WriteFile("collision", []byte("original"), 0600); e != nil {
		t.Fatal(e)
	}
	if e = commitUpload(r, u.file, u.temporary, "collision"); e == nil {
		t.Fatal("existing destination replaced")
	}
	if b, e := r.root.ReadFile("collision"); e != nil || string(b) != "original" {
		t.Fatal("existing contents changed")
	}
}
