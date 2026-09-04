//go:build darwin || linux

package main

import (
	"context"
	"errors"
	"io"
	"os"

	"golang.org/x/sys/unix"
)

type consolePlatform struct{ flags []struct{ fd, flags int } }

func (console *nativeConsole) prepare() error {
	for _, file := range []*os.File{console.input, console.output} {
		if file == nil {
			continue
		}
		fd := console.outputFD
		if file == console.input {
			fd = console.inputFD
		}
		flags, err := unix.FcntlInt(uintptr(fd), unix.F_GETFL, 0)
		if err != nil {
			return err
		}
		if err := unix.SetNonblock(fd, true); err != nil {
			return err
		}
		console.platform.flags = append(console.platform.flags, struct{ fd, flags int }{fd, flags})
	}
	return nil
}

func (console *nativeConsole) restore() error {
	var failure error
	for index := len(console.platform.flags) - 1; index >= 0; index-- {
		entry := console.platform.flags[index]
		_, err := unix.FcntlInt(uintptr(entry.fd), unix.F_SETFL, entry.flags)
		failure = errors.Join(failure, err)
	}
	console.platform.flags = nil
	return failure
}

func pollConsole(ctx context.Context, fd int, events int16) error {
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		fds := []unix.PollFd{{Fd: int32(fd), Events: events}}
		count, err := unix.Poll(fds, 50)
		if errors.Is(err, unix.EINTR) {
			continue
		}
		if err != nil {
			return err
		}
		if count == 0 {
			continue
		}
		if fds[0].Revents&(unix.POLLERR|unix.POLLNVAL) != 0 {
			return errors.New("terminal is unavailable")
		}
		if fds[0].Revents&events != 0 {
			return nil
		}
		if fds[0].Revents&unix.POLLHUP != 0 {
			return io.EOF
		}
	}
}

func (console *nativeConsole) ReadKey(ctx context.Context) (byte, error) {
	var data [1]byte
	_, err := console.ReadInput(ctx, data[:])
	return data[0], err
}

// ReadInput preserves whole raw byte chunks for terminal mode. Only the owning
// CLI input worker may call this or ReadKey; neither closes the user's handle.
func (console *nativeConsole) ReadInput(ctx context.Context, data []byte) (int, error) {
	if len(data) == 0 {
		return 0, nil
	}
	if console.input == nil {
		return 0, io.EOF
	}
	fd := console.inputFD
	for {
		if err := pollConsole(ctx, fd, unix.POLLIN); err != nil {
			return 0, err
		}
		count, err := unix.Read(fd, data)
		if errors.Is(err, unix.EAGAIN) || errors.Is(err, unix.EINTR) {
			continue
		}
		if err != nil {
			return 0, err
		}
		if count == 0 {
			return 0, io.EOF
		}
		return count, nil
	}
}

func (console *nativeConsole) Write(ctx context.Context, value string) error {
	if console.output == nil {
		return errors.New("terminal output is unavailable")
	}
	fd := console.outputFD
	data := []byte(value)
	for len(data) > 0 {
		if err := pollConsole(ctx, fd, unix.POLLOUT); err != nil {
			return err
		}
		count, err := unix.Write(fd, data)
		if errors.Is(err, unix.EAGAIN) || errors.Is(err, unix.EINTR) {
			continue
		}
		if err != nil {
			return err
		}
		if count == 0 {
			return io.ErrShortWrite
		}
		data = data[count:]
	}
	return nil
}
