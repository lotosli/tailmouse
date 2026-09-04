//go:build darwin || linux

package main

import (
	"errors"
	"os"

	"golang.org/x/term"
)

// Leash must preserve redirected stdin/stdout as well as terminal descriptors.
// It reuses the platform console's cancellable I/O and exact flag restoration;
// raw mode applies only to a real input terminal, never a pipe or regular file.
type leashLocalConsole struct {
	*nativeConsole
	sizeFD int
}

func openLeashConsole(input, output *os.File) (*leashLocalConsole, error) {
	if output == nil {
		return nil, errors.New("terminal output is unavailable")
	}
	console := &leashLocalConsole{nativeConsole: &nativeConsole{input: input, output: output}, sizeFD: -1}
	var err error
	console.outputFD, err = consoleDescriptor(output)
	if err != nil {
		return nil, err
	}
	if term.IsTerminal(console.outputFD) {
		console.sizeFD = console.outputFD
	}
	if input != nil {
		console.inputFD, err = consoleDescriptor(input)
		if err != nil {
			return nil, err
		}
		if term.IsTerminal(console.inputFD) {
			if console.sizeFD < 0 {
				console.sizeFD = console.inputFD
			}
			console.state, err = term.MakeRaw(console.inputFD)
			if err != nil {
				return nil, err
			}
		}
	}
	if err := console.prepare(); err != nil {
		return nil, errors.Join(err, console.Close())
	}
	return console, nil
}

func (console *leashLocalConsole) Size() (int, int, error) {
	if console.sizeFD < 0 {
		return 0, 0, nil
	}
	return term.GetSize(console.sizeFD)
}

func (*leashLocalConsole) DiscardPendingInput() {}
