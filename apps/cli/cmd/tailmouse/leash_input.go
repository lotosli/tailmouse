package main

import (
	"context"

	"tailmouse/apps/cli/internal/leash"
)

type leashLocalRead struct {
	data []byte
	err  error
}

// Each reader belongs to one process generation. Stopping it joins both a
// blocked platform read and a blocked handoff before discarding old bytes.
type leashInputReader struct {
	values  chan leashLocalRead
	done    chan struct{}
	cancel  context.CancelFunc
	console *leashLocalConsole
}

func readLeashInput(parent context.Context, console *leashLocalConsole) *leashInputReader {
	ctx, cancel := context.WithCancel(parent)
	reader := &leashInputReader{values: make(chan leashLocalRead, 1), done: make(chan struct{}), cancel: cancel, console: console}
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
	reader.console.DiscardPendingInput()
}
