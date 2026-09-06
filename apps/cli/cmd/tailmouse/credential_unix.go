//go:build darwin || linux

package main

import (
	"os"

	"golang.org/x/sys/unix"
	"golang.org/x/term"
)

func openCredentialTerminal(input *os.File) (*credentialTerminal, error) {
	if output, err := os.OpenFile("/dev/tty", os.O_WRONLY, 0); err == nil {
		if term.IsTerminal(int(output.Fd())) {
			return &credentialTerminal{output: output, owned: true}, nil
		}
		_ = output.Close()
	}
	if terminalFileWritable(input) {
		return &credentialTerminal{output: input}, nil
	}
	return nil, errCredentialTerminal
}

func terminalFileWritable(file *os.File) bool {
	if file == nil || !term.IsTerminal(int(file.Fd())) {
		return false
	}
	flags, err := unix.FcntlInt(file.Fd(), unix.F_GETFL, 0)
	return err == nil && flags&unix.O_ACCMODE != unix.O_RDONLY
}
