//go:build !linux && !darwin

package share

import "testing"

func TestReceiveFailsClosedWithoutPrivateStaging(t *testing.T) {
	// The v1 receiver requires private Unix staging and an ownership lock.
	// Unsupported platforms must fail before accepting an upload.
	r, err := NewReceiver(t.TempDir(), t.TempDir(), 1024, 2048, 100)
	if r != nil || err != ErrUploadStorage {
		t.Fatal("receiver accepted unsupported private staging", err)
	}
}
