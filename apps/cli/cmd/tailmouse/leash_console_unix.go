//go:build darwin || linux

package main

import (
	"context"
	"errors"
	"os"

	"golang.org/x/term"
	"tailmouse/apps/cli/internal/leash"
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

type leashLocalRead struct {
	data []byte
	err  error
}

// Each reader belongs to one process generation. Stopping it joins both a
// blocked descriptor read and a blocked handoff before discarding old bytes.
type leashInputReader struct {
	values chan leashLocalRead
	done   chan struct{}
	cancel context.CancelFunc
}

func readLeashInput(parent context.Context, console *leashLocalConsole) *leashInputReader {
	ctx, cancel := context.WithCancel(parent)
	reader := &leashInputReader{values: make(chan leashLocalRead, 1), done: make(chan struct{}), cancel: cancel}
	go func() {
		defer close(reader.done)
		defer close(reader.values)
		var data [leash.TerminalChunkBytes]byte
		defer clear(data[:])
		for ctx.Err() == nil {
			count, err := console.ReadInput(ctx, data[:])
			value := leashLocalRead{data: append([]byte(nil), data[:count]...), err: err}
			clear(data[:count])
			select {
			case reader.values <- value:
			case <-ctx.Done():
				clear(value.data)
				return
			}
			if err != nil {
				return
			}
		}
	}()
	return reader
}

func (reader *leashInputReader) Close() {
	reader.cancel()
	<-reader.done
	for value := range reader.values {
		clear(value.data)
	}
}
