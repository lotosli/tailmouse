//go:build windows

package main

import (
	"os"

	"golang.org/x/term"
)

func openCredentialTerminal(_ *os.File) (*credentialTerminal, error) {
	output, err := os.OpenFile("CONOUT$", os.O_WRONLY, 0)
	if err != nil {
		return nil, errCredentialTerminal
	}
	if !term.IsTerminal(int(output.Fd())) {
		_ = output.Close()
		return nil, errCredentialTerminal
	}
	return &credentialTerminal{output: output, owned: true}, nil
}

func terminalFileWritable(file *os.File) bool {
	return file != nil && term.IsTerminal(int(file.Fd()))
}
