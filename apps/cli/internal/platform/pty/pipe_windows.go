//go:build windows

package pty

import (
	"context"
	"crypto/rand"
	"errors"
	"os"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

// consolePipe creates one ConPTY channel. Its server end is synchronous as
// ConPTY requires; the host end is overlapped so Go can cancel I/O by deadline.
// The pair is connected before either handle escapes this function.
func consolePipe(ctx context.Context, hostReads bool) (host *os.File, console windows.Handle, failure error) {
	if err := ctx.Err(); err != nil {
		return nil, 0, err
	}
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		return nil, 0, err
	}
	security, err := windows.SecurityDescriptorFromString("D:P(A;;GA;;;" + user.User.Sid.String() + ")")
	if err != nil {
		return nil, 0, err
	}
	attributes := windows.SecurityAttributes{
		Length: uint32(unsafe.Sizeof(windows.SecurityAttributes{})), SecurityDescriptor: security,
	}
	name, err := windows.UTF16PtrFromString(`\\.\pipe\tailmouse-conpty-` + rand.Text())
	if err != nil {
		return nil, 0, err
	}
	serverMode, clientMode := uint32(windows.PIPE_ACCESS_INBOUND), uint32(windows.GENERIC_WRITE)
	if hostReads {
		serverMode, clientMode = windows.PIPE_ACCESS_OUTBOUND, windows.GENERIC_READ
	}
	server, err := windows.CreateNamedPipe(name, serverMode|windows.FILE_FLAG_FIRST_PIPE_INSTANCE,
		windows.PIPE_TYPE_BYTE|windows.PIPE_WAIT|windows.PIPE_REJECT_REMOTE_CLIENTS, 1, 64<<10, 64<<10, 0, &attributes)
	if err != nil {
		return nil, 0, err
	}
	defer func() {
		if failure != nil {
			failure = errors.Join(failure, windows.CloseHandle(server))
		}
	}()
	client, err := windows.CreateFile(name, clientMode, 0, nil, windows.OPEN_EXISTING,
		windows.FILE_FLAG_OVERLAPPED|windows.SECURITY_SQOS_PRESENT|windows.SECURITY_ANONYMOUS, 0)
	if err != nil {
		return nil, 0, err
	}
	defer func() {
		if failure != nil && client != 0 {
			failure = errors.Join(failure, windows.CloseHandle(client))
		}
	}()
	// The held client has already connected; the synchronous server call
	// cannot wait for a future peer and must report that existing connection.
	if err := windows.ConnectNamedPipe(server, nil); err != nil && !errors.Is(err, windows.ERROR_PIPE_CONNECTED) {
		return nil, 0, err
	}
	var clientPID, serverPID uint32
	if err := windows.GetNamedPipeClientProcessId(server, &clientPID); err != nil {
		return nil, 0, err
	}
	if err := windows.GetNamedPipeServerProcessId(client, &serverPID); err != nil {
		return nil, 0, err
	}
	if clientPID != uint32(os.Getpid()) || serverPID != uint32(os.Getpid()) {
		return nil, 0, errors.New("terminal pipe ownership mismatch")
	}
	if err := ctx.Err(); err != nil {
		return nil, 0, err
	}
	file := os.NewFile(uintptr(client), "terminal channel")
	// This verifies that the locked runtime registered the overlapped handle.
	// Do not call file.Fd: that would detach it from Go's I/O completion port.
	if err := file.SetDeadline(time.Time{}); err != nil {
		// File owns client now, so suppress the raw-handle failure cleanup.
		closeErr := file.Close()
		client = 0
		return nil, 0, errors.Join(err, closeErr)
	}
	return file, server, nil
}
