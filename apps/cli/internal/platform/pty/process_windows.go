//go:build windows

package pty

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"sync"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"

	"tailmouse/apps/cli/internal/leash"
)

// Process owns one ConPTY, its two channels, and the child's complete job.
// The pump supplies the sole reader; pump and control writes are serialized.
// Browser cancellation does not own the process lifetime; Close does.
type Process struct {
	input, output *os.File
	console, job  windows.Handle
	pid           int
	done          chan struct{}
	released      chan struct{}
	result        Result
	waitErr       error
	releaseErr    error
	ioCtx         context.Context
	ioCancel      context.CancelFunc
	mu            sync.RWMutex
	consoleMu     sync.Mutex
	consoleOnce   sync.Once
	consoleClosed chan struct{}
	writeGate     chan struct{}
	started       bool
	closed        bool
	closeErr      error
}

var _ leash.PTY = (*Process)(nil)

func Start(ctx context.Context, snapshot *leash.Command) (_ *Process, failure error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if snapshot == nil {
		return nil, &StartError{code: 2, cause: leash.ErrCommand}
	}
	application, arguments, environment, directory, err := commandWindows(snapshot)
	if err != nil {
		return nil, err
	}
	ioCtx, ioCancel := context.WithCancel(context.Background())
	process := &Process{
		done: make(chan struct{}), released: make(chan struct{}), consoleClosed: make(chan struct{}),
		ioCtx: ioCtx, ioCancel: ioCancel, writeGate: make(chan struct{}, 1),
	}
	defer func() {
		if failure != nil {
			cleanup, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			failure = errors.Join(failure, process.Close(cleanup))
		}
	}()
	var inputSide, outputSide windows.Handle
	process.input, inputSide, err = consolePipe(ctx, false)
	if err != nil {
		return nil, &StartError{code: 6, cause: err}
	}
	defer func() {
		if inputSide != 0 {
			failure = errors.Join(failure, windows.CloseHandle(inputSide))
		}
	}()
	process.output, outputSide, err = consolePipe(ctx, true)
	if err != nil {
		return nil, &StartError{code: 6, cause: err}
	}
	defer func() {
		if outputSide != 0 {
			failure = errors.Join(failure, windows.CloseHandle(outputSide))
		}
	}()
	if err := windows.CreatePseudoConsole(windows.Coord{X: 80, Y: 24}, inputSide, outputSide, 0, &process.console); err != nil {
		return nil, &StartError{code: 6, cause: err}
	}
	process.job, err = windows.CreateJobObject(nil, nil)
	if err != nil {
		return nil, &StartError{code: 6, cause: err}
	}
	limits := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{}
	limits.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
	if _, err := windows.SetInformationJobObject(process.job, windows.JobObjectExtendedLimitInformation,
		uintptr(unsafe.Pointer(&limits)), uint32(unsafe.Sizeof(limits))); err != nil {
		return nil, &StartError{code: 6, cause: err}
	}
	attributes, err := windows.NewProcThreadAttributeList(2)
	if err != nil {
		return nil, &StartError{code: 6, cause: err}
	}
	defer attributes.Delete()
	// The pseudoconsole attribute takes the handle value, unlike attributes
	// that take a pointer to stored data. Keep it out of Go's pointer heap.
	update := windows.NewLazySystemDLL("kernel32.dll").NewProc("UpdateProcThreadAttribute")
	if err := update.Find(); err != nil {
		return nil, &StartError{code: 6, cause: err}
	}
	ok, _, updateErr := update.Call(uintptr(unsafe.Pointer(attributes.List())), 0,
		windows.PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, uintptr(process.console), unsafe.Sizeof(process.console), 0, 0)
	if ok == 0 {
		return nil, &StartError{code: 6, cause: updateErr}
	}
	// PROC_THREAD_ATTRIBUTE_JOB_LIST: public Windows 10+ startup attribute.
	const jobListAttribute = 0x0002000D
	if err := attributes.Update(jobListAttribute, unsafe.Pointer(&process.job), unsafe.Sizeof(process.job)); err != nil {
		return nil, &StartError{code: 6, cause: err}
	}
	startup := windows.StartupInfoEx{
		// Without this flag, Windows duplicates a redirected parent's standard
		// handles even when inheritHandles is false. Explicit null handles let
		// the child attach all three streams to its own pseudoconsole instead.
		StartupInfo: windows.StartupInfo{
			Cb: uint32(unsafe.Sizeof(windows.StartupInfoEx{})), Flags: windows.STARTF_USESTDHANDLES,
		},
		ProcThreadAttributeList: attributes.List(),
	}
	if err := ctx.Err(); err != nil {
		return nil, &StartError{code: 7, cause: err}
	}
	var child windows.ProcessInformation
	if err := windows.CreateProcess(application, arguments, nil, nil, false,
		windows.EXTENDED_STARTUPINFO_PRESENT|windows.CREATE_UNICODE_ENVIRONMENT,
		&environment[0], directory, &startup.StartupInfo, &child); err != nil {
		return nil, launchError(err)
	}
	process.pid, process.started = int(child.ProcessId), true
	go process.wait(child.Process)
	// Neither a parent copy of ConPTY's channels nor the initial thread handle
	// may survive successful startup. Child terminal handles are ConPTY-owned.
	closeErr := errors.Join(windows.CloseHandle(child.Thread), windows.CloseHandle(inputSide), windows.CloseHandle(outputSide))
	inputSide, outputSide = 0, 0
	if err := errors.Join(closeErr, ctx.Err()); err != nil {
		return nil, &StartError{code: 7, cause: err}
	}
	return process, nil
}

func launchError(err error) *StartError {
	code := 7
	if errors.Is(err, os.ErrNotExist) {
		code = 127
	}
	if errors.Is(err, os.ErrPermission) || errors.Is(err, windows.ERROR_BAD_EXE_FORMAT) {
		code = 126
	}
	return &StartError{code: code, cause: err}
}

func (process *Process) wait(handle windows.Handle) {
	status, err := windows.WaitForSingleObject(handle, windows.INFINITE)
	if err == nil && status != windows.WAIT_OBJECT_0 {
		err = errors.New("terminal process wait returned an invalid state")
	}
	if err == nil {
		var code uint32
		err = windows.GetExitCodeProcess(handle, &code)
		process.result.ExitCode = int(code)
	}
	process.waitErr = errors.Join(err, windows.CloseHandle(handle))
	close(process.done)
	// HPCON itself keeps the session open. Root exit is not enough: a shell
	// or launcher may leave attached descendants running in the owned job.
	process.mu.RLock()
	process.releaseErr = waitForEmptyJob(process.ioCtx, process.job)
	if errors.Is(process.releaseErr, context.Canceled) {
		// Final Close canceled observation and now owns forced job cleanup.
		process.releaseErr = nil
	}
	process.mu.RUnlock()
	process.requestConsoleClose()
	<-process.consoleClosed
	close(process.released)
}

// The caller retains the job handle under the resource lock until return.
func waitForEmptyJob(ctx context.Context, job windows.Handle) error {
	ticker := time.NewTicker(20 * time.Millisecond)
	defer ticker.Stop()
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		if job == 0 {
			return nil
		}
		// JOBOBJECT_BASIC_ACCOUNTING_INFORMATION, public Win32 layout.
		var accounting struct {
			UserTime, KernelTime, PeriodUserTime, PeriodKernelTime int64
			PageFaults, Total, Active, Terminated                  uint32
		}
		err := windows.QueryInformationJobObject(job, windows.JobObjectBasicAccountingInformation,
			uintptr(unsafe.Pointer(&accounting)), uint32(unsafe.Sizeof(accounting)), nil)
		if err != nil || accounting.Active == 0 {
			return err
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
		}
	}
}

func (process *Process) requestConsoleClose() {
	process.consoleOnce.Do(func() {
		process.consoleMu.Lock()
		handle := process.console
		process.console = 0
		process.consoleMu.Unlock()
		// Before Windows 11 24H2 this can wait for clients or output drain.
		// Do not hold a resource lock or block the grace-period owner here.
		// The process waiter and final Close join this one owned worker.
		go func() {
			if handle != 0 {
				windows.ClosePseudoConsole(handle)
			}
			close(process.consoleClosed)
		}()
	})
}

func (process *Process) PID() int              { return process.pid }
func (process *Process) Done() <-chan struct{} { return process.done }

func (process *Process) Wait(ctx context.Context) (Result, error) {
	select {
	case <-process.done:
		return process.result, process.waitErr
	case <-ctx.Done():
		return Result{}, ctx.Err()
	}
}

func (process *Process) Read(ctx context.Context, data []byte) (int, error) {
	process.mu.RLock()
	defer process.mu.RUnlock()
	if len(data) == 0 {
		return 0, nil
	}
	for {
		if err := ctx.Err(); err != nil {
			return 0, err
		}
		if process.ioCtx.Err() != nil {
			return 0, os.ErrClosed
		}
		if err := process.output.SetReadDeadline(time.Now().Add(50 * time.Millisecond)); err != nil {
			return 0, err
		}
		count, err := process.output.Read(data)
		if count > 0 {
			if errors.Is(err, os.ErrDeadlineExceeded) {
				err = nil
			}
			return count, err
		}
		if errors.Is(err, os.ErrDeadlineExceeded) {
			continue
		}
		if err != nil {
			return 0, fmt.Errorf("read terminal: %w", err)
		}
		return 0, io.EOF
	}
}

func (process *Process) Write(ctx context.Context, data []byte) error {
	if len(data) == 0 {
		return nil
	}
	// Interrupt also writes this channel. Admit one complete input/control
	// chunk at a time without trapping queued callers behind canceled I/O.
	select {
	case process.writeGate <- struct{}{}:
		defer func() { <-process.writeGate }()
	case <-ctx.Done():
		return ctx.Err()
	case <-process.ioCtx.Done():
		return os.ErrClosed
	}
	process.mu.RLock()
	defer process.mu.RUnlock()
	for len(data) > 0 {
		if err := ctx.Err(); err != nil {
			return err
		}
		if process.ioCtx.Err() != nil {
			return os.ErrClosed
		}
		if err := process.input.SetWriteDeadline(time.Now().Add(50 * time.Millisecond)); err != nil {
			return err
		}
		count, err := process.input.Write(data)
		data = data[count:]
		if errors.Is(err, os.ErrDeadlineExceeded) {
			continue
		}
		if err != nil {
			return fmt.Errorf("write terminal: %w", err)
		}
		if count == 0 {
			return io.ErrShortWrite
		}
	}
	return nil
}

func (process *Process) Resize(ctx context.Context, cols, rows int) error {
	if cols < 20 || cols > 500 || rows < 5 || rows > 200 {
		return errors.New("invalid terminal dimensions")
	}
	process.consoleMu.Lock()
	defer process.consoleMu.Unlock()
	if err := ctx.Err(); err != nil {
		return err
	}
	if process.ioCtx.Err() != nil || process.console == 0 {
		return os.ErrClosed
	}
	return windows.ResizePseudoConsole(process.console, windows.Coord{X: int16(cols), Y: int16(rows)})
}

// Interrupt uses ConPTY's native keyboard-event input, not a broadcast from
// TailMouse's own console. Ctrl+Break remains a signal with processed input off;
// ordinary local Ctrl+C still travels as raw input through the pump.
func (process *Process) Interrupt(ctx context.Context) error {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	if err := ctx.Err(); err != nil {
		return err
	}
	if process.ioCtx.Err() != nil {
		return os.ErrClosed
	}
	select {
	case <-process.released:
		return errors.Join(process.waitErr, process.releaseErr)
	default:
	}
	// CSI Vk;Sc;Uc;Kd;Cs;Rc _: Ctrl down, Break down/up, Ctrl up.
	// VK_CANCEL=3, VK_CONTROL=17, LEFT_CTRL_PRESSED=8. No parser or mode
	// negotiation is needed when the destination is our own Windows ConPTY.
	const controlBreak = "\x1b[17;29;0;1;8;1_\x1b[3;70;0;1;8;1_\x1b[3;70;0;0;8;1_\x1b[17;29;0;0;0;1_"
	return process.Write(ctx, []byte(controlBreak))
}

// Terminate permits native console-close handlers to clean up while the sole
// reader drains output. Detached console clients remain owned by the job.
// Cancellation shortens the grace period, never skips forceful cleanup.
func (process *Process) Terminate(ctx context.Context) error {
	grace, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	process.requestConsoleClose()
	select {
	case <-process.released:
		if process.ioCtx.Err() == nil {
			return errors.Join(process.waitErr, process.releaseErr, ctx.Err())
		}
		// A concurrent Close may have canceled job observation. Join its
		// forced cleanup rather than mistaking waiter release for job exit.
	case <-grace.Done():
	}
	cleanup, finish := context.WithTimeout(context.Background(), time.Second)
	defer finish()
	return errors.Join(ctx.Err(), process.Close(cleanup))
}

// Close is final forceful cleanup, not the five-second graceful user action.
// Cancel and join channel operations before releasing any reusable handles.
func (process *Process) Close(ctx context.Context) error {
	process.ioCancel()
	process.mu.Lock()
	if !process.closed {
		if process.job != 0 {
			process.closeErr = windows.TerminateJobObject(process.job, 1)
		}
		if process.started {
			// Preserve TerminateJobObject's result before channel closure can
			// initiate a competing console-close event. The waiter records root
			// exit before taking the resource lock to observe descendants.
			_, waitErr := process.Wait(ctx)
			process.closeErr = errors.Join(process.closeErr, waitErr)
		}
		// Job termination is asynchronous; root exit alone does not prove
		// every descendant has exited. Retain the job handle until observed.
		process.closeErr = errors.Join(process.closeErr, waitForEmptyJob(ctx, process.job))
		if process.input != nil {
			process.closeErr = errors.Join(process.closeErr, process.input.Close())
		}
		if process.output != nil {
			process.closeErr = errors.Join(process.closeErr, process.output.Close())
		}
		if process.job != 0 {
			process.closeErr = errors.Join(process.closeErr, windows.CloseHandle(process.job))
			process.job = 0
		}
		process.closed = true
		if !process.started {
			close(process.done)
			process.requestConsoleClose()
			close(process.released)
		}
	}
	err := process.closeErr
	process.mu.Unlock()
	_, waitErr := process.Wait(ctx)
	for _, done := range []<-chan struct{}{process.released, process.consoleClosed} {
		select {
		case <-done:
		case <-ctx.Done():
			return errors.Join(err, waitErr, ctx.Err())
		}
	}
	return errors.Join(err, waitErr, process.releaseErr)
}
