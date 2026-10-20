//go:build darwin || linux

package share

import (
	"os"
	"path/filepath"
	"syscall"
	"testing"
	"time"
)

func TestReplacedOfferCannotBlockOnFIFO(t *testing.T) {
	directory := t.TempDir()
	name := filepath.Join(directory, "replaced")
	if err := syscall.Mkfifo(name, 0600); err != nil {
		t.Fatal(err)
	}
	root, err := os.OpenRoot(directory)
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()
	done := make(chan error, 1)
	go func() {
		file, err := openOfferedFile(root, "replaced")
		if file != nil {
			_ = file.Close()
		}
		done <- err
	}()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		// Release a regressed blocking open before reporting the failure.
		fd, err := syscall.Open(name, syscall.O_WRONLY|syscall.O_NONBLOCK, 0)
		if err == nil {
			_ = syscall.Close(fd)
		}
		<-done
		t.Fatal("a replaced file blocked session cleanup")
	}
}
