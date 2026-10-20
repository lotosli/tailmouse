//go:build windows

package share

import "os"

func openOfferedFile(root *os.Root, name string) (*os.File, error) {
	return root.Open(name)
}
