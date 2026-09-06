package main

import (
	"errors"
	"os"

	"tailmouse/apps/cli/internal/session"
)

var errCredentialTerminal = errors.New("protected credential terminal is unavailable")

type credentialTerminal struct {
	output *os.File
	owned  bool
}

func (terminal *credentialTerminal) Present(code session.AccessCode, readonly bool) error {
	if terminal == nil || terminal.output == nil {
		return errCredentialTerminal
	}
	grouped := make([]byte, 0, len(code)+3)
	for index, symbol := range code {
		if index != 0 && index%4 == 0 {
			grouped = append(grouped, '-')
		}
		grouped = append(grouped, symbol)
	}
	message := make([]byte, 0, 256)
	message = append(message, "TAILMOUSE ACCESS CODE\n\nAccess code  "...)
	message = append(message, grouped...)
	message = append(message, "\nBoth the invitation and this code are required.\n"...)
	if readonly {
		message = append(message, "Authenticated browser access is view-only.\n\n"...)
	} else {
		message = append(message, "Authenticated browser access can control the selected terminal process.\n\n"...)
	}
	clear(grouped)
	defer clear(message)
	written, err := terminal.output.Write(message)
	if err != nil || written != len(message) {
		return errCredentialTerminal
	}
	return nil
}

func (terminal *credentialTerminal) Close() error {
	if terminal == nil || terminal.output == nil || !terminal.owned {
		return nil
	}
	err := terminal.output.Close()
	terminal.output = nil
	if err != nil {
		return errCredentialTerminal
	}
	return nil
}
