//go:build windows

package main

import (
	"context"
	"errors"
	"io"
	"unsafe"

	"golang.org/x/sys/windows"
	"golang.org/x/term"
)

type consolePlatform struct {
	outputMode    uint32
	outputChanged bool
}

func (console *nativeConsole) prepare() error {
	if console.input != nil && term.IsTerminal(console.inputFD) {
		handle := windows.Handle(console.inputFD)
		var mode uint32
		if err := windows.GetConsoleMode(handle, &mode); err != nil {
			return err
		}
		// Consume bounded input records, not VT bytes or Quick Edit selections.
		mode = mode&^(windows.ENABLE_VIRTUAL_TERMINAL_INPUT|windows.ENABLE_QUICK_EDIT_MODE) | windows.ENABLE_EXTENDED_FLAGS
		if err := windows.SetConsoleMode(handle, mode); err != nil {
			return err
		}
	}
	if console.output != nil && term.IsTerminal(console.outputFD) {
		handle := windows.Handle(console.outputFD)
		if err := windows.GetConsoleMode(handle, &console.platform.outputMode); err != nil {
			return err
		}
		if err := windows.SetConsoleMode(handle, console.platform.outputMode|windows.ENABLE_VIRTUAL_TERMINAL_PROCESSING); err != nil {
			return err
		}
		console.platform.outputChanged = true
	}
	return nil
}

func (console *nativeConsole) restore() error {
	if !console.platform.outputChanged {
		return nil
	}
	console.platform.outputChanged = false
	return windows.SetConsoleMode(windows.Handle(console.outputFD), console.platform.outputMode)
}

func (console *nativeConsole) ReadKey(ctx context.Context) (byte, error) {
	if console.input == nil {
		return 0, io.EOF
	}
	read := windows.NewLazySystemDLL("kernel32.dll").NewProc("ReadConsoleInputW")
	if err := read.Find(); err != nil {
		return 0, err
	}
	for {
		if err := ctx.Err(); err != nil {
			return 0, err
		}
		status, err := windows.WaitForSingleObject(windows.Handle(console.inputFD), 50)
		if err != nil {
			return 0, err
		}
		if status == uint32(windows.WAIT_TIMEOUT) {
			continue
		}
		if status != windows.WAIT_OBJECT_0 {
			return 0, errors.New("terminal input is unavailable")
		}
		var record struct {
			kind                         uint16
			padding                      uint16
			down                         uint32
			repeat, key, scan, character uint16
			modifiers                    uint32
		}
		var count uint32
		ok, _, err := read.Call(uintptr(console.inputFD), uintptr(unsafe.Pointer(&record)), 1, uintptr(unsafe.Pointer(&count)))
		if ok == 0 {
			return 0, err
		}
		if count == 1 && record.kind == 1 && record.down != 0 && record.character > 0 && record.character < 128 {
			return byte(record.character), nil
		}
	}
}

func (console *nativeConsole) Write(ctx context.Context, value string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if console.output == nil {
		return errors.New("terminal output is unavailable")
	}
	count, err := io.WriteString(console.output, value)
	if err == nil && count != len(value) {
		err = io.ErrShortWrite
	}
	return err
}
