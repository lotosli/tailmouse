//go:build !linux && !darwin

package share

import "os"

// Root.Link never replaces an existing destination. Private stage directories
// are writable only by the host's OS user; Root prevents path escape.
func commitUpload(r *Receiver, file *os.File, id, name string) error {
	a, err := file.Stat()
	if err != nil {
		return err
	}
	b, err := r.stage.Lstat(id)
	if err != nil || !os.SameFile(a, b) {
		return ErrUploadStorage
	}
	if err = r.root.Link(r.stageName+"/"+id, name); err != nil {
		return err
	}
	return nil
}
