package share

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"strings"
)

// The local ownership key is unrelated to invitations. It authenticates only
// temporary names so crash cleanup never adopts arbitrary user directories.
func partialKey(root *os.Root) ([]byte, error) {
	file, e := root.OpenFile(".owner-key", os.O_CREATE|os.O_EXCL|os.O_RDWR, 0600)
	if e == nil {
		key := make([]byte, 32)
		if _, e = rand.Read(key); e == nil {
			_, e = file.Write(key)
		}
		if e == nil {
			e = file.Sync()
		}
		closeErr := file.Close()
		if e != nil || closeErr != nil {
			return nil, ErrUploadStorage
		}
		return key, nil
	}
	if !errors.Is(e, os.ErrExist) {
		return nil, ErrUploadStorage
	}
	info, e := root.Lstat(".owner-key")
	if e != nil || !info.Mode().IsRegular() || info.Mode().Perm() != 0600 || info.Size() != 32 {
		return nil, ErrUploadStorage
	}
	file, e = root.Open(".owner-key")
	if e != nil {
		return nil, ErrUploadStorage
	}
	defer file.Close()
	actual, e := file.Stat()
	if e != nil || !os.SameFile(info, actual) {
		return nil, ErrUploadStorage
	}
	key, e := io.ReadAll(io.LimitReader(file, 33))
	if e != nil || len(key) != 32 {
		return nil, ErrUploadStorage
	}
	return key, nil
}
func ownershipTag(key []byte, session, id string) string {
	mac := hmac.New(sha256.New, key)
	_, _ = mac.Write([]byte(session + "\x00" + id))
	return hex.EncodeToString(mac.Sum(nil)[:16])
}
func ownershipRecord(key []byte, session string) string {
	return "TAILMOUSE-PARTIALS/1\n" + session + "\n" + ownershipTag(key, session, "owner") + "\n"
}
func isID(value string) bool {
	if len(value) != 32 {
		return false
	}
	for _, c := range value {
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
			return false
		}
	}
	return true
}
func ownStage(stage *os.Root, key []byte, id string) (*os.File, error) {
	file, e := stage.OpenFile(".owner", os.O_CREATE|os.O_EXCL|os.O_RDWR, 0600)
	if e != nil {
		return nil, ErrUploadStorage
	}
	ok, e := lockPartial(file)
	if e != nil || !ok {
		_ = file.Close()
		return nil, ErrUploadStorage
	}
	if _, e = file.WriteString(ownershipRecord(key, id)); e == nil {
		e = file.Sync()
	}
	if e != nil {
		_ = file.Close()
		return nil, ErrUploadStorage
	}
	return file, nil
}
func cleanupPartials(root *os.Root, key []byte) error {
	directory, e := root.Open(".")
	if e != nil {
		return ErrUploadStorage
	}
	defer directory.Close()
	entries, e := directory.ReadDir(1000)
	if e != nil && e != io.EOF {
		return ErrUploadStorage
	}
	for _, entry := range entries {
		if !entry.IsDir() || !isID(entry.Name()) {
			continue
		}
		if e = cleanupStage(root, key, entry.Name()); e != nil {
			return e
		}
	}
	return nil
}
func cleanupStage(root *os.Root, key []byte, id string) error {
	stage, e := root.OpenRoot(id)
	if e != nil {
		return nil
	}
	defer stage.Close()
	info, e := stage.Lstat(".owner")
	if e != nil || !info.Mode().IsRegular() || info.Mode().Perm() != 0600 || info.Size() > 256 {
		return nil
	}
	file, e := stage.OpenFile(".owner", os.O_RDWR, 0)
	if e != nil {
		return nil
	}
	defer file.Close()
	actual, e := file.Stat()
	if e != nil || !os.SameFile(info, actual) {
		return nil
	}
	locked, e := lockPartial(file)
	if e != nil {
		return ErrUploadStorage
	}
	if !locked {
		return nil
	}
	record, e := io.ReadAll(io.LimitReader(file, 257))
	if e != nil || !hmac.Equal(record, []byte(ownershipRecord(key, id))) {
		return nil
	}
	directory, e := stage.Open(".")
	if e != nil {
		return ErrUploadStorage
	}
	entries, e := directory.ReadDir(10001)
	closeErr := directory.Close()
	if e != nil && e != io.EOF || closeErr != nil {
		return ErrUploadStorage
	}
	unknown := false
	for _, entry := range entries {
		name := entry.Name()
		if name == ".owner" {
			continue
		}
		parts := strings.Split(strings.TrimSuffix(name, ".part"), "-")
		if len(parts) != 2 || !strings.HasSuffix(name, ".part") || !isID(parts[0]) || !hmac.Equal([]byte(parts[1]), []byte(ownershipTag(key, id, parts[0]))) {
			unknown = true
			continue
		}
		if e = stage.Remove(name); e != nil && !errors.Is(e, os.ErrNotExist) {
			return ErrUploadStorage
		}
	}
	if !unknown {
		if e = stage.Remove(".owner"); e != nil && !errors.Is(e, os.ErrNotExist) {
			return ErrUploadStorage
		}
		if e = root.Remove(id); e != nil && !errors.Is(e, os.ErrNotExist) {
			return ErrUploadStorage
		}
	}
	return nil
}
