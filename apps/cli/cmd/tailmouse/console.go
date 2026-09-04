package main

import (
	"context"
	"errors"
	"io"
	"os"

	"golang.org/x/term"
)

// The spectator owns this terminal boundary, not stdin or stdout themselves.
// Tests provide a deterministic console; platform implementations restore every
// mode/flag they change and keep reads cancellable without closing user handles.
type escapeConsole interface {
	ReadKey(context.Context) (byte, error)
	Write(context.Context, string) error
	Size() (int, int, error)
	Close() error
}

type nativeConsole struct {
	input, output     *os.File
	inputFD, outputFD int
	state             *term.State
	platform          consolePlatform
}

func openEscapeConsole(input *os.File, output io.Writer) (escapeConsole, bool, error) {
	console := &nativeConsole{}
	if input != nil {
		fd, err := consoleDescriptor(input)
		if err != nil {
			return nil, false, err
		}
		if term.IsTerminal(fd) {
			console.input, console.inputFD = input, fd
		}
	}
	if file, ok := output.(*os.File); ok {
		fd, err := consoleDescriptor(file)
		if err != nil {
			return nil, false, err
		}
		if term.IsTerminal(fd) {
			console.output, console.outputFD = file, fd
		}
	}
	if console.input == nil && console.output == nil {
		return nil, false, nil
	}
	var err error
	if console.input != nil {
		console.state, err = term.MakeRaw(console.inputFD)
		if err != nil {
			return nil, false, err
		}
	}
	if err := console.prepare(); err != nil {
		return nil, false, errors.Join(err, console.Close())
	}
	return console, console.input != nil, nil
}

func consoleDescriptor(file *os.File) (int, error) {
	// File.Fd may silently clear O_NONBLOCK. Inspect without changing the mode
	// that the console must restore when the session ends.
	raw, err := file.SyscallConn()
	if err != nil {
		return 0, err
	}
	var descriptor int
	err = raw.Control(func(fd uintptr) { descriptor = int(fd) })
	return descriptor, err
}

func (console *nativeConsole) Size() (int, int, error) {
	if console.output == nil {
		return 0, 0, nil
	}
	return term.GetSize(console.outputFD)
}

func (console *nativeConsole) Close() error {
	err := console.restore()
	if console.state != nil {
		err = errors.Join(err, term.Restore(console.inputFD, console.state))
		console.state = nil
	}
	return err
}
