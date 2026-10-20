//go:build !windows

package share

import (
	"os"
	"syscall"
)

// A directory owner can replace a regular file with a FIFO between Lstat and
// Open. Nonblocking open lets the following handle-based Stat reject it.
func openOfferedFile(root *os.Root, name string) (*os.File, error) {
	return root.OpenFile(name, os.O_RDONLY|syscall.O_NONBLOCK, 0)
}
