//go:build darwin || linux

package pty

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	nativepty "github.com/creack/pty"
	"golang.org/x/sys/unix"

	"tailmouse/apps/cli/internal/leash"
)

// Process has one owning reader and one owning writer. The resource lock lets
// Close cancel and join their syscalls before closing a reusable descriptor.
// Start's context bounds startup only; browser/session cancellation must not
// silently terminate a child. The owner explicitly closes the process.
type Process struct {
	command   *exec.Cmd
	master    *os.File
	fd        int
	done      chan struct{}
	result    Result
	waitErr   error
	ioCtx     context.Context
	ioCancel  context.CancelFunc
	ioMu      sync.RWMutex
	groupMu   sync.Mutex
	jobGroups []int
	closed    bool
	closeErr  error
}

func Start(ctx context.Context, snapshot *leash.Command) (*Process, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if snapshot == nil {
		return nil, &StartError{code: 2, cause: leash.ErrCommand}
	}
	argv, environment := snapshot.Argv(), snapshot.Environment()
	if len(argv) == 0 {
		return nil, &StartError{code: 2, cause: leash.ErrCommand}
	}
	directory, err := os.Stat(snapshot.Cwd())
	if err != nil {
		return nil, &StartError{code: 7, cause: err}
	}
	if !directory.IsDir() {
		return nil, &StartError{code: 7, cause: unix.ENOTDIR}
	}
	path, err := executable(argv[0], snapshot.Cwd(), environment)
	if err != nil {
		return nil, launchError(err)
	}
	master, slave, err := nativepty.Open()
	if err != nil {
		return nil, &StartError{code: 6, cause: err}
	}
	// Parent-side slave closure is essential: retaining it prevents master EOF.
	failed := func(code int, cause error) (*Process, error) {
		return nil, &StartError{code: code, cause: errors.Join(cause, slave.Close(), master.Close())}
	}
	if err := nativepty.Setsize(master, &nativepty.Winsize{Cols: 80, Rows: 24}); err != nil {
		return failed(6, err)
	}
	fd := int(master.Fd())
	// UTF-8 needs cooked-mode character erasure as well as unmodified bytes.
	// Set this on the new PTY only; never change the user's locale or terminal.
	settings, err := unix.IoctlGetTermios(fd, readTermios)
	if err != nil {
		return failed(6, err)
	}
	settings.Iflag |= unix.IUTF8
	settings.Iflag &^= unix.ISTRIP
	settings.Cflag &^= unix.CSIZE | unix.PARENB
	settings.Cflag |= unix.CS8
	if err := unix.IoctlSetTermios(fd, writeTermios, settings); err != nil {
		return failed(6, err)
	}
	if err := unix.SetNonblock(fd, true); err != nil {
		return failed(6, err)
	}
	if err := ctx.Err(); err != nil {
		return failed(7, err)
	}
	command := &exec.Cmd{
		Path: path, Args: argv, Env: environment, Dir: snapshot.Cwd(),
		Stdin: slave, Stdout: slave, Stderr: slave,
		SysProcAttr: &syscall.SysProcAttr{Setsid: true, Setctty: true},
	}
	if err := command.Start(); err != nil {
		failure := launchError(err)
		return failed(failure.code, failure.cause)
	}
	ioCtx, ioCancel := context.WithCancel(context.Background())
	process := &Process{command: command, master: master, fd: fd, done: make(chan struct{}), ioCtx: ioCtx, ioCancel: ioCancel}
	go func() {
		err := command.Wait()
		var exited *exec.ExitError
		if err != nil && !errors.As(err, &exited) {
			process.waitErr = fmt.Errorf("wait for terminal process: %w", err)
		} else {
			process.result.ExitCode = command.ProcessState.ExitCode()
			if status, ok := command.ProcessState.Sys().(syscall.WaitStatus); ok && status.Signaled() {
				process.result.Signal = int(status.Signal())
				process.result.ExitCode = 128 + int(status.Signal())
			}
		}
		close(process.done)
	}()
	if err := errors.Join(slave.Close(), ctx.Err()); err != nil {
		cleanup, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		return nil, &StartError{code: 6, cause: errors.Join(err, process.Close(cleanup))}
	}
	return process, nil
}

func launchError(err error) *StartError {
	code := 7
	if errors.Is(err, os.ErrNotExist) || errors.Is(err, exec.ErrNotFound) {
		code = 127
	}
	if errors.Is(err, os.ErrPermission) || errors.Is(err, unix.ENOEXEC) || errors.Is(err, unix.EISDIR) {
		code = 126
	}
	return &StartError{code: code, cause: err}
}

// Resolve against the stored environment and working directory, never the
// host's later PATH. argv remains unchanged and no shell is invoked.
func executable(name, cwd string, environment []string) (string, error) {
	if strings.ContainsRune(name, '/') {
		if filepath.IsAbs(name) {
			return name, nil
		}
		return filepath.Join(cwd, name), nil
	}
	var path string
	for _, entry := range environment {
		if strings.HasPrefix(entry, "PATH=") {
			path = strings.TrimPrefix(entry, "PATH=")
		}
	}
	var denied bool
	for _, directory := range filepath.SplitList(path) {
		if !filepath.IsAbs(directory) {
			directory = filepath.Join(cwd, directory)
		}
		candidate := filepath.Join(directory, name)
		info, err := os.Stat(candidate)
		if errors.Is(err, os.ErrNotExist) || errors.Is(err, unix.ENOTDIR) {
			continue
		}
		if errors.Is(err, os.ErrPermission) {
			denied = true
			continue
		}
		if err != nil {
			return "", err
		}
		if !info.Mode().IsRegular() || info.Mode().Perm()&0111 == 0 {
			denied = true
			continue
		}
		return candidate, nil
	}
	if denied {
		return "", os.ErrPermission
	}
	return "", exec.ErrNotFound
}

func (process *Process) PID() int { return process.command.Process.Pid }

// Done permits an owning I/O loop to recognize normal child exit without an
// additional goroutine calling Wait. Wait still returns the recorded result.
func (process *Process) Done() <-chan struct{} { return process.done }

func (process *Process) Wait(ctx context.Context) (Result, error) {
	select {
	case <-process.done:
		return process.result, process.waitErr
	case <-ctx.Done():
		return Result{}, ctx.Err()
	}
}

func (process *Process) ready(ctx context.Context, events int16) error {
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		if process.ioCtx.Err() != nil {
			return os.ErrClosed
		}
		fds := []unix.PollFd{{Fd: int32(process.fd), Events: events}}
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
		if fds[0].Revents&unix.POLLNVAL != 0 {
			return os.ErrClosed
		}
		// Drain bytes before reporting HUP: a child can exit with unread output.
		if fds[0].Revents&events != 0 {
			return nil
		}
		if fds[0].Revents&(unix.POLLHUP|unix.POLLERR) != 0 {
			return io.EOF
		}
	}
}

func (process *Process) Read(ctx context.Context, data []byte) (int, error) {
	process.ioMu.RLock()
	defer process.ioMu.RUnlock()
	if len(data) == 0 {
		return 0, nil
	}
	for {
		if err := process.ready(ctx, unix.POLLIN); err != nil {
			return 0, err
		}
		count, err := unix.Read(process.fd, data)
		if errors.Is(err, unix.EAGAIN) || errors.Is(err, unix.EINTR) {
			continue
		}
		if errors.Is(err, unix.EIO) || err == nil && count == 0 {
			return 0, io.EOF
		}
		if err != nil {
			return 0, fmt.Errorf("read terminal: %w", err)
		}
		return count, nil
	}
}

// Write finishes one accepted chunk before returning. The caller provides the
// single serialized input queue; separate local/browser writers are forbidden.
func (process *Process) Write(ctx context.Context, data []byte) error {
	process.ioMu.RLock()
	defer process.ioMu.RUnlock()
	for len(data) > 0 {
		if err := process.ready(ctx, unix.POLLOUT); err != nil {
			return err
		}
		count, err := unix.Write(process.fd, data)
		if errors.Is(err, unix.EAGAIN) || errors.Is(err, unix.EINTR) {
			continue
		}
		if err != nil {
			return fmt.Errorf("write terminal: %w", err)
		}
		if count == 0 {
			return io.ErrShortWrite
		}
		data = data[count:]
	}
	return nil
}

func (process *Process) Resize(ctx context.Context, cols, rows int) error {
	if cols < 20 || cols > 500 || rows < 5 || rows > 200 {
		return errors.New("invalid terminal dimensions")
	}
	process.ioMu.RLock()
	defer process.ioMu.RUnlock()
	if err := ctx.Err(); err != nil {
		return err
	}
	if process.closed {
		return os.ErrClosed
	}
	return unix.IoctlSetWinsize(process.fd, unix.TIOCSWINSZ, &unix.Winsize{Col: uint16(cols), Row: uint16(rows)})
}

func (process *Process) Interrupt(ctx context.Context) error {
	process.ioMu.RLock()
	defer process.ioMu.RUnlock()
	if err := ctx.Err(); err != nil {
		return err
	}
	if process.closed {
		return os.ErrClosed
	}
	// Remember this validated job for later whole-generation cleanup, but do
	// not use its numeric group as the Interrupt target: it can exit and its ID
	// can be reused after this query.
	group, err := process.rememberForegroundGroup()
	if err != nil || group == 0 {
		return err
	}
	// Both kernels resolve and retain the foreground group through the PTY.
	// Unlike writing VINTR, this also interrupts applications with ISIG off.
	return unix.IoctlSetInt(process.fd, unix.TIOCSIG, int(unix.SIGINT))
}

func processGroupExists(group, session int) (bool, error) {
	currentSession, err := unix.Getsid(group)
	if err == nil {
		return currentSession == session, nil
	}
	if !errors.Is(err, unix.ESRCH) {
		return false, err
	}
	// A group can outlive its leader. If a group with this ID still exists
	// while no process has the leader PID, the ID has not been reusable.
	err = unix.Kill(-group, 0)
	if err == nil || errors.Is(err, unix.EPERM) {
		return true, nil
	}
	if errors.Is(err, unix.ESRCH) {
		return false, nil
	}
	return false, err
}

func signalProcessGroup(group, session int, signal unix.Signal) error {
	exists, err := processGroupExists(group, session)
	if err != nil || !exists {
		return err
	}
	err = unix.Kill(-group, signal)
	if errors.Is(err, unix.ESRCH) {
		return nil
	}
	return err
}

// rememberForegroundGroup is called with the PTY resource lock held. The
// controlling terminal supplies the current job group; its leader must still
// belong to the session created for this Process before its reusable numeric
// identifier is retained for graceful and forced cleanup.
func (process *Process) rememberForegroundGroup() (int, error) {
	group, err := unix.IoctlGetInt(process.fd, unix.TIOCGPGRP)
	if err != nil || group <= 1 {
		select {
		case <-process.done:
			return 0, nil
		default:
		}
		if err != nil {
			return 0, err
		}
		return 0, errors.New("terminal foreground process group is unavailable")
	}
	if group == process.PID() {
		return group, nil
	}
	session, err := unix.Getsid(group)
	if err != nil {
		return 0, err
	}
	if session != process.PID() {
		return 0, errors.New("terminal foreground process group belongs to another session")
	}
	process.groupMu.Lock()
	defer process.groupMu.Unlock()
	for _, remembered := range process.jobGroups {
		if remembered == group {
			return group, nil
		}
	}
	process.jobGroups = append(process.jobGroups, group)
	return group, nil
}

func (process *Process) ownedGroups() []int {
	process.groupMu.Lock()
	defer process.groupMu.Unlock()
	groups := make([]int, 0, len(process.jobGroups)+1)
	groups = append(groups, process.jobGroups...)
	return append(groups, process.PID())
}

func signalProcessGroups(groups []int, session int, signal unix.Signal) error {
	var result error
	for _, group := range groups {
		result = errors.Join(result, signalProcessGroup(group, session, signal))
	}
	return result
}

func processGroupsExited(groups []int, session int) (bool, error) {
	for _, group := range groups {
		exists, err := processGroupExists(group, session)
		if err != nil {
			return false, err
		}
		if exists {
			return false, nil
		}
	}
	return true, nil
}

func waitForProcessGroups(ctx context.Context, groups []int, session int) error {
	ticker := time.NewTicker(20 * time.Millisecond)
	defer ticker.Stop()
	for {
		exited, err := processGroupsExited(groups, session)
		if err != nil || exited {
			return err
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
		}
	}
}

// Terminate gives the entire process group at most five seconds before final
// forceful cleanup. Cancellation shortens the grace period, never skips reap.
func (process *Process) Terminate(ctx context.Context) error {
	process.ioMu.RLock()
	if process.closed {
		process.ioMu.RUnlock()
		return process.Close(ctx)
	}
	_, captureErr := process.rememberForegroundGroup()
	groups := process.ownedGroups()
	err := signalProcessGroups(groups, process.PID(), unix.SIGTERM)
	process.ioMu.RUnlock()
	if failure := errors.Join(captureErr, err); failure != nil {
		cleanup, finish := context.WithTimeout(context.Background(), time.Second)
		defer finish()
		return errors.Join(failure, process.Close(cleanup))
	}
	grace, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	graceErr := waitForProcessGroups(grace, groups, process.PID())
	if graceErr == nil {
		return nil
	}
	cleanup, finish := context.WithTimeout(context.Background(), time.Second)
	defer finish()
	if errors.Is(graceErr, context.Canceled) || errors.Is(graceErr, context.DeadlineExceeded) {
		graceErr = nil
	}
	return errors.Join(ctx.Err(), graceErr, process.Close(cleanup))
}

// Close is final, forceful resource cleanup, not the user's graceful Terminate
// action. Use a fresh bounded cleanup context so Wait can reap the child even
// after the owner's run context has been canceled. Repeated calls join the same
// waiter and never signal a possibly reused process-group ID again.
func (process *Process) Close(ctx context.Context) error {
	process.ioCancel()
	process.ioMu.Lock()
	if !process.closed {
		_, captureErr := process.rememberForegroundGroup()
		groups := process.ownedGroups()
		process.closeErr = errors.Join(captureErr, signalProcessGroups(groups, process.PID(), unix.SIGKILL))
		// SIGKILL is asynchronous. Closing the master before the child and
		// every remembered foreground group have exited can deliver SIGHUP first
		// or leave a shell job behind. I/O is canceled and joined above; the
		// independent waiter needs no terminal operation to reap the child.
		_, waitErr := process.Wait(ctx)
		groupErr := waitForProcessGroups(ctx, groups, process.PID())
		process.closeErr = errors.Join(process.closeErr, waitErr, groupErr, process.master.Close())
		process.closed = true
	}
	err := process.closeErr
	process.ioMu.Unlock()
	_, waitErr := process.Wait(ctx)
	return errors.Join(err, waitErr)
}
