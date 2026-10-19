package share

import (
	"golang.org/x/sys/unix"
	"os"
)

// APFS clones the verified open inode directly into a new destination. The
// kernel rejects an existing name; neither source nor destination is resolved
// through an exchanged ancestor directory. Unsupported filesystems fail closed.
func commitUpload(r *Receiver, file *os.File, _ string, name string) error {
	if err := unix.Fclonefileat(int(file.Fd()), int(r.rootDirectory.Fd()), name, 0); err != nil {
		return err
	}
	return nil
}
