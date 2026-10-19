package share

import (
	"golang.org/x/sys/unix"
	"os"
)

// Link the already-open inode, not a path that can be exchanged after hashing.
// EEXIST is atomic; there is no check-then-rename overwrite window.
func commitUpload(r *Receiver, file *os.File, _ string, name string) error {
	if err := unix.Linkat(int(file.Fd()), "", int(r.rootDirectory.Fd()), name, unix.AT_EMPTY_PATH); err != nil {
		return err
	}
	return nil
}
