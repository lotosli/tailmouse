//go:build darwin || linux

package share

import (
	"errors"
	"golang.org/x/sys/unix"
	"os"
)

func lockPartial(file *os.File) (bool, error) {
	e := unix.Flock(int(file.Fd()), unix.LOCK_EX|unix.LOCK_NB)
	if errors.Is(e, unix.EWOULDBLOCK) || errors.Is(e, unix.EAGAIN) {
		return false, nil
	}
	return e == nil, e
}
