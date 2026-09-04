//go:build windows

package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"runtime"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
	"golang.org/x/term"
)

// All handles here are private duplicates. Console modes and file offsets are
// shared with the caller, but Go deadlines and handle closure are not.
type leashLocalConsole struct {
	*nativeConsole
	sizeFD                  int
	sizeOutput              *os.File
	inputAsync, outputAsync bool
	resized                 chan struct{}
	pending                 []byte
	readRecord, cancelSync  *windows.LazyProc
	inputCleanup            error
	outputCleanup           error
}

func duplicateLocalFile(file *os.File) (*os.File, error) {
	raw, err := file.SyscallConn()
	if err != nil {
		return nil, err
	}
	var handle windows.Handle
	var duplicateErr error
	err = raw.Control(func(fd uintptr) {
		duplicateErr = windows.DuplicateHandle(windows.CurrentProcess(), windows.Handle(fd), windows.CurrentProcess(), &handle, 0, false, windows.DUPLICATE_SAME_ACCESS)
	})
	if err != nil || duplicateErr != nil {
		if handle != 0 {
			duplicateErr = errors.Join(duplicateErr, windows.CloseHandle(handle))
		}
		return nil, errors.Join(err, duplicateErr)
	}
	return os.NewFile(uintptr(handle), "TailMouse local terminal"), nil
}

func localDeadlineSupport(file *os.File, descriptor int, set func(time.Time) error) (bool, error) {
	if term.IsTerminal(descriptor) {
		return false, nil
	}
	err := set(time.Time{})
	if err == nil {
		return true, nil
	}
	if !errors.Is(err, os.ErrNoDeadline) {
		return false, err
	}
	// os.NewFile detects overlapped handles, but a handle already associated
	// with a foreign completion port cannot be made pollable. Distinguish that
	// case from a genuinely synchronous handle instead of applying the wrong
	// cancellation mechanism.
	raw, rawErr := file.SyscallConn()
	if rawErr != nil {
		return false, rawErr
	}
	var mode uint32
	var queryErr error
	rawErr = raw.Control(func(fd uintptr) {
		queryErr = windows.NtQueryInformationFile(windows.Handle(fd), &windows.IO_STATUS_BLOCK{}, (*byte)(unsafe.Pointer(&mode)), uint32(unsafe.Sizeof(mode)), 16) // FileModeInformation
	})
	if rawErr != nil || queryErr != nil {
		return false, errors.Join(rawErr, queryErr)
	}
	if mode&(windows.FILE_SYNCHRONOUS_IO_ALERT|windows.FILE_SYNCHRONOUS_IO_NONALERT) == 0 {
		return false, fmt.Errorf("overlapped local terminal handle cannot provide deadlines: %w", os.ErrNoDeadline)
	}
	return false, nil
}

func openLeashConsole(input, output *os.File) (*leashLocalConsole, error) {
	if output == nil {
		return nil, errors.New("terminal output is unavailable")
	}
	kernel := windows.NewLazySystemDLL("kernel32.dll")
	console := &leashLocalConsole{
		nativeConsole: &nativeConsole{}, sizeFD: -1, resized: make(chan struct{}, 1),
		readRecord: kernel.NewProc("ReadConsoleInputW"), cancelSync: kernel.NewProc("CancelSynchronousIo"),
	}
	if err := errors.Join(console.readRecord.Find(), console.cancelSync.Find()); err != nil {
		return nil, err
	}
	failed := func(err error) (*leashLocalConsole, error) {
		return nil, errors.Join(err, console.Close())
	}
	var err error
	console.output, err = duplicateLocalFile(output)
	if err != nil {
		return failed(err)
	}
	console.outputFD, err = consoleDescriptor(console.output)
	if err != nil {
		return failed(err)
	}
	console.outputAsync, err = localDeadlineSupport(console.output, console.outputFD, console.output.SetWriteDeadline)
	if err != nil {
		return failed(err)
	}
	if term.IsTerminal(console.outputFD) {
		console.sizeFD = console.outputFD
	}
	if input != nil {
		console.input, err = duplicateLocalFile(input)
		if err != nil {
			return failed(err)
		}
		console.inputFD, err = consoleDescriptor(console.input)
		if err != nil {
			return failed(err)
		}
		console.inputAsync, err = localDeadlineSupport(console.input, console.inputFD, console.input.SetReadDeadline)
		if err != nil {
			return failed(err)
		}
		if term.IsTerminal(console.inputFD) {
			console.state, err = term.MakeRaw(console.inputFD)
			if err != nil {
				return failed(err)
			}
			if console.sizeFD < 0 {
				// A console input handle cannot query screen-buffer dimensions.
				console.sizeOutput, err = os.OpenFile("CONOUT$", os.O_RDONLY, 0)
				if err != nil {
					return failed(err)
				}
				console.sizeFD, err = consoleDescriptor(console.sizeOutput)
				if err != nil {
					return failed(err)
				}
			}
		}
	}
	if err := console.prepare(); err != nil {
		return failed(err)
	}
	if console.state != nil {
		var mode uint32
		if err := windows.GetConsoleMode(windows.Handle(console.inputFD), &mode); err != nil {
			return failed(err)
		}
		if err := windows.SetConsoleMode(windows.Handle(console.inputFD), mode|windows.ENABLE_WINDOW_INPUT); err != nil {
			return failed(err)
		}
	}
	return console, nil
}

func (console *leashLocalConsole) Size() (int, int, error) {
	if console.sizeFD < 0 {
		return 0, 0, nil
	}
	return term.GetSize(console.sizeFD)
}

func (console *leashLocalConsole) DiscardPendingInput() {
	clear(console.pending)
	console.pending = nil
}

// The owner joins input and output before restoring modes and closing handles.
func (console *leashLocalConsole) Close() error {
	err := errors.Join(console.inputCleanup, console.outputCleanup, console.nativeConsole.Close())
	for _, file := range []*os.File{console.input, console.output, console.sizeOutput} {
		if file != nil {
			err = errors.Join(err, file.Close())
		}
	}
	console.input, console.output, console.sizeOutput = nil, nil, nil
	console.sizeFD = -1
	console.DiscardPendingInput()
	return err
}

// A deadline belongs only to the private overlapped file. Synchronous console,
// file and pipe calls instead retain their native thread until cancellation has
// joined: a late CancelSynchronousIo must never reach an unrelated operation.
func (console *leashLocalConsole) localIO(ctx context.Context, cleanup *error, deadline func(time.Time) error, operation func() (int, error)) (count int, err error) {
	if *cleanup != nil {
		return 0, *cleanup
	}
	if err := ctx.Err(); err != nil {
		return 0, err
	}
	if deadline != nil {
		done := make(chan struct{})
		var cancelErr error
		stop := context.AfterFunc(ctx, func() {
			cancelErr = deadline(time.Now())
			close(done)
		})
		defer func() {
			if !stop() {
				<-done
			}
			if errors.Is(err, os.ErrDeadlineExceeded) && ctx.Err() != nil {
				err = ctx.Err()
			}
			*cleanup = errors.Join(*cleanup, cancelErr, deadline(time.Time{}))
			err = errors.Join(err, *cleanup)
		}()
		return operation()
	}
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	var thread windows.Handle
	if err := windows.DuplicateHandle(windows.CurrentProcess(), windows.CurrentThread(), windows.CurrentProcess(), &thread, windows.THREAD_TERMINATE, false, 0); err != nil {
		return 0, err
	}
	done, canceled := make(chan struct{}), make(chan struct{})
	var cancelErr error
	stop := context.AfterFunc(ctx, func() {
		defer close(canceled)
		ticker := time.NewTicker(50 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-done:
				return
			default:
			}
			ok, _, callErr := console.cancelSync.Call(uintptr(thread))
			if ok == 0 && !errors.Is(callErr, windows.ERROR_NOT_FOUND) {
				cancelErr = callErr
				return
			}
			// Cancellation may precede syscall submission, or race a successful
			// partial write followed by another syscall in os.File.Write.
			select {
			case <-done:
				return
			case <-ticker.C:
			}
		}
	})
	defer func() {
		close(done)
		if !stop() {
			<-canceled
		}
		if errors.Is(err, windows.ERROR_OPERATION_ABORTED) && ctx.Err() != nil {
			err = ctx.Err()
		}
		*cleanup = errors.Join(*cleanup, cancelErr, windows.CloseHandle(thread))
		err = errors.Join(err, *cleanup)
	}()
	if err = ctx.Err(); err == nil {
		count, err = operation()
	}
	return count, err
}

type localInputRecord struct {
	kind                         uint16
	padding                      uint16
	down                         uint32
	repeat, key, scan, character uint16
	modifiers                    uint32
}

func localKeyBytes(record localInputRecord) []byte {
	if record.down != 0 && (record.character == 3 || record.character == '\r') {
		// Repeat is a native uint16, so this exception is bounded to 65535
		// bytes and is drained through the same caller-sized chunks.
		return bytes.Repeat([]byte{byte(record.character)}, int(record.repeat))
	}
	return fmt.Appendf(nil, "\x1b[%d;%d;%d;%d;%d;%d_", record.key, record.scan, record.character, record.down, record.modifiers, record.repeat)
}

func (console *leashLocalConsole) ReadInput(ctx context.Context, data []byte) (int, error) {
	if len(data) == 0 {
		return 0, nil
	}
	if console.input == nil {
		return 0, io.EOF
	}
	if console.state == nil {
		var deadline func(time.Time) error
		if console.inputAsync {
			deadline = console.input.SetReadDeadline
		}
		return console.localIO(ctx, &console.inputCleanup, deadline, func() (int, error) { return console.input.Read(data) })
	}
	for {
		if err := ctx.Err(); err != nil {
			return 0, err
		}
		if len(console.pending) > 0 {
			count := copy(data, console.pending)
			clear(console.pending[:count])
			console.pending = console.pending[count:]
			return count, nil
		}
		var record localInputRecord
		count, err := console.localIO(ctx, &console.inputCleanup, nil, func() (int, error) {
			var count uint32
			ok, _, err := console.readRecord.Call(uintptr(console.inputFD), uintptr(unsafe.Pointer(&record)), 1, uintptr(unsafe.Pointer(&count)))
			if ok == 0 {
				return 0, err
			}
			return int(count), nil
		})
		if err != nil {
			return 0, err
		}
		if count != 1 {
			return 0, io.ErrNoProgress
		}
		switch record.kind {
		case 1: // KEY_EVENT
			console.pending = localKeyBytes(record)
		case 4: // WINDOW_BUFFER_SIZE_EVENT
			select {
			case console.resized <- struct{}{}:
			default:
			}
		}
	}
}

func (console *leashLocalConsole) Write(ctx context.Context, value string) error {
	if console.output == nil {
		return errors.New("terminal output is unavailable")
	}
	var deadline func(time.Time) error
	if console.outputAsync {
		deadline = console.output.SetWriteDeadline
	}
	count, err := console.localIO(ctx, &console.outputCleanup, deadline, func() (int, error) { return io.WriteString(console.output, value) })
	if err == nil && count != len(value) {
		err = io.ErrShortWrite
	}
	return err
}
