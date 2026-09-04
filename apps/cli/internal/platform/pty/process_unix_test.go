//go:build darwin || linux

package pty

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	nativepty "github.com/creack/pty"
	"golang.org/x/sys/unix"
	"golang.org/x/term"

	"tailmouse/apps/cli/internal/leash"
)

type childReport struct {
	PID, Group, Session, Cols, Rows int
	Terminal                        [3]bool
	Cwd, Term, Value                string
	Argv                            []string
}

// The same test binary runs inside the real PTY. A hard watchdog bounds a
// broken test; production owns and reaps the child through Process.Close.
func TestPTYChild(t *testing.T) {
	mode := os.Getenv("TAILMOUSE_PTY_TEST_CHILD")
	if mode == "" {
		return
	}
	watchdog := time.AfterFunc(15*time.Second, func() { os.Exit(124) })
	defer watchdog.Stop()
	switch mode {
	case "pump-output", "pump-input":
		os.Exit(pumpChild(mode))
	case "inspect":
		group, err := unix.Getpgid(0)
		if err != nil {
			os.Exit(125)
		}
		session, err := unix.Getsid(0)
		if err != nil {
			os.Exit(125)
		}
		cols, rows, err := term.GetSize(0)
		if err != nil {
			os.Exit(125)
		}
		cwd, err := os.Getwd()
		if err != nil {
			os.Exit(125)
		}
		report := childReport{PID: os.Getpid(), Group: group, Session: session, Cols: cols, Rows: rows, Cwd: cwd, Term: os.Getenv("TERM"), Value: os.Getenv("VALUE"), Argv: os.Args}
		for fd := range report.Terminal {
			report.Terminal[fd] = term.IsTerminal(fd)
		}
		if err := json.NewEncoder(os.Stdout).Encode(report); err != nil {
			os.Exit(125)
		}
		if _, err := fmt.Fprint(os.Stdout, "\x1b[?1049h\x1b[31m\xf0\x9f\x90\x88\x1b[0m\x1b[?1049l"); err != nil {
			os.Exit(125)
		}
		if _, err := fmt.Fprint(os.Stderr, "merged-stderr"); err != nil {
			os.Exit(125)
		}
		os.Exit(23)
	case "canonical":
		settings, err := unix.IoctlGetTermios(0, readTermios)
		if err != nil || settings.Iflag&unix.IUTF8 == 0 {
			os.Exit(125)
		}
		settings.Lflag &^= unix.ECHO
		if err := unix.IoctlSetTermios(0, writeTermios, settings); err != nil {
			os.Exit(125)
		}
		fmt.Println("ready")
		value, err := bufio.NewReader(os.Stdin).ReadString('\n')
		if err != nil {
			os.Exit(125)
		}
		fmt.Printf("line:%q\n", value)
		os.Exit(0)
	case "echo", "idle", "ignore-term":
		if _, err := term.MakeRaw(0); err != nil {
			os.Exit(125)
		}
		if mode == "ignore-term" {
			signal.Ignore(syscall.SIGTERM)
		}
		fmt.Println("ready")
		if mode == "idle" || mode == "ignore-term" {
			select {}
		}
		data := make([]byte, 18)
		if _, err := io.ReadFull(os.Stdin, data); err != nil {
			os.Exit(125)
		}
		if _, err := os.Stdout.Write(data); err != nil {
			os.Exit(125)
		}
		os.Exit(37)
	case "control", "raw-control":
		events := make(chan os.Signal, 4)
		signal.Notify(events, syscall.SIGWINCH, syscall.SIGINT)
		if mode == "raw-control" {
			if _, err := term.MakeRaw(0); err != nil {
				os.Exit(125)
			}
		}
		fmt.Println("ready")
		for event := range events {
			if event == syscall.SIGINT {
				fmt.Println("interrupted")
				os.Exit(42)
			}
			cols, rows, err := term.GetSize(0)
			if err != nil {
				os.Exit(125)
			}
			fmt.Printf("size %d %d\n", cols, rows)
		}
	case "tree", "leaf":
		events := make(chan os.Signal, 1)
		signal.Notify(events, syscall.SIGINT)
		if mode == "leaf" {
			fmt.Println("leaf ready")
			<-events
			fmt.Println("leaf interrupted")
			os.Exit(17)
		}
		binary, err := os.Executable()
		if err != nil {
			os.Exit(125)
		}
		child := exec.Command(binary, "-test.run=^TestPTYChild$")
		child.Env = append(os.Environ(), "TAILMOUSE_PTY_TEST_CHILD=leaf")
		child.Stdin, child.Stdout, child.Stderr = os.Stdin, os.Stdout, os.Stderr
		if err := child.Start(); err != nil {
			os.Exit(125)
		}
		fmt.Println("parent ready")
		<-events
		fmt.Println("parent interrupted")
		var exit *exec.ExitError
		if err := child.Wait(); !errors.As(err, &exit) || exit.ExitCode() != 17 {
			os.Exit(125)
		}
		os.Exit(42)
	default:
		os.Exit(125)
	}
	os.Exit(125)
}

func TestProcessTerminateGraceAndForcedDeadline(t *testing.T) {
	for _, mode := range []string{"idle", "ignore-term"} {
		t.Run(mode, func(t *testing.T) {
			process := startChild(t, childCommand(t, mode))
			if line(t, terminalReader(t, process)) != "ready" {
				t.Fatal("child not ready")
			}
			started := time.Now()
			if err := process.Terminate(t.Context()); err != nil {
				t.Fatal(err)
			}
			elapsed := time.Since(started)
			result, err := process.Wait(t.Context())
			want := 143
			if mode == "ignore-term" {
				want = 137
				if elapsed < 5*time.Second || elapsed > 6*time.Second {
					t.Fatalf("forceful termination after %s", elapsed)
				}
			} else if elapsed > time.Second {
				t.Fatalf("graceful child waited %s", elapsed)
			}
			if err != nil || result.ExitCode != want {
				t.Fatalf("termination = %+v, %v", result, err)
			}
			if err := unix.Kill(-process.PID(), 0); !errors.Is(err, unix.ESRCH) {
				t.Fatal("terminated process group survived")
			}
			if err := process.Close(t.Context()); err != nil {
				t.Fatal(err)
			}
			if err := process.Terminate(t.Context()); err != nil {
				t.Fatal("repeated termination failed", err)
			}
		})
	}
}

func childCommand(t *testing.T, mode string, extra ...string) *leash.Command {
	t.Helper()
	binary, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	argv := append([]string{binary, "-test.run=^TestPTYChild$", "--"}, extra...)
	command, err := leash.NewCommand(argv, t.TempDir(), "PTY test", os.Environ(), []string{"TAILMOUSE_PTY_TEST_CHILD=" + mode, "VALUE=exact=a=b", "TERM=ignored"})
	if err != nil {
		t.Fatal(err)
	}
	return command
}

func startChild(t *testing.T, command *leash.Command) *Process {
	t.Helper()
	process, err := Start(t.Context(), command)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := process.Close(ctx); err != nil {
			t.Error(err)
		}
	})
	return process
}

type processReader struct {
	ctx     context.Context
	process *Process
}

func (reader processReader) Read(data []byte) (int, error) {
	return reader.process.Read(reader.ctx, data)
}

func terminalReader(t *testing.T, process *Process) *bufio.Reader {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	t.Cleanup(cancel)
	return bufio.NewReader(processReader{ctx, process})
}

func line(t *testing.T, reader *bufio.Reader) string {
	t.Helper()
	value, err := reader.ReadString('\n')
	if err != nil {
		t.Fatal(err)
	}
	return strings.TrimSpace(value)
}

func TestProcessStartsLiteralSnapshotInControllingPTY(t *testing.T) {
	extra := []string{"", "a b", "*", "$HOME", "$(exit 99)", "|", ";"}
	command := childCommand(t, "inspect", extra...)
	process := startChild(t, command)
	reader := terminalReader(t, process)
	var report childReport
	if err := json.Unmarshal([]byte(line(t, reader)), &report); err != nil {
		t.Fatal(err)
	}
	cwd, err := filepath.EvalSymlinks(command.Cwd())
	if err != nil {
		t.Fatal(err)
	}
	if report.PID != process.PID() || report.PID != report.Group || report.PID != report.Session || report.Group == unix.Getpgrp() {
		t.Fatal("child did not own an independent session and process group")
	}
	if report.Cols != 80 || report.Rows != 24 || report.Terminal != [3]bool{true, true, true} || report.Term != "xterm-256color" || report.Value != "exact=a=b" || report.Cwd != cwd || !slices.Equal(report.Argv, command.Argv()) {
		t.Fatal("child did not receive the exact snapshot and terminal settings")
	}
	output, err := io.ReadAll(reader)
	if err != nil {
		t.Fatal(err)
	}
	if string(output) != "\x1b[?1049h\x1b[31m\xf0\x9f\x90\x88\x1b[0m\x1b[?1049lmerged-stderr" {
		t.Fatal("ANSI, Unicode, or merged output was changed or lost at exit")
	}
	result, err := process.Wait(t.Context())
	if err != nil || result != (Result{ExitCode: 23}) {
		t.Fatalf("wrong child result: %+v, %v", result, err)
	}
	if next, err := process.Wait(t.Context()); err != nil || next != result {
		t.Fatal("repeated wait changed result")
	}
}

func TestProcessUsesStoredPathForEachGeneration(t *testing.T) {
	base := childCommand(t, "inspect")
	directory := t.TempDir()
	if err := os.Symlink(base.Argv()[0], filepath.Join(directory, "stored-program")); err != nil {
		t.Fatal(err)
	}
	argv := base.Argv()
	argv[0] = "stored-program"
	command, err := leash.NewCommand(argv, directory, "", base.Environment(), []string{"PATH=missing:.", "VALUE=stored"})
	if err != nil {
		t.Fatal(err)
	}
	for range 2 {
		process := startChild(t, command)
		reader := terminalReader(t, process)
		var report childReport
		if err := json.Unmarshal([]byte(line(t, reader)), &report); err != nil {
			t.Fatal(err)
		}
		if report.Argv[0] != "stored-program" || report.Value != "stored" {
			t.Fatal("stored argv or environment changed across starts")
		}
		if _, err := io.Copy(io.Discard, reader); err != nil {
			t.Fatal(err)
		}
		if result, err := process.Wait(t.Context()); err != nil || result.ExitCode != 23 {
			t.Fatal("stored PATH did not launch the same child")
		}
	}
	argv[0] = "./stored-program"
	command, err = leash.NewCommand(argv, directory, "", base.Environment(), nil)
	if err != nil {
		t.Fatal(err)
	}
	process := startChild(t, command)
	if _, err := io.Copy(io.Discard, terminalReader(t, process)); err != nil {
		t.Fatal(err)
	}
	if result, err := process.Wait(t.Context()); err != nil || result.ExitCode != 23 {
		t.Fatal("relative executable did not resolve in stored cwd")
	}
}

func TestProcessRawInputRoundTrip(t *testing.T) {
	process := startChild(t, childCommand(t, "echo"))
	reader := terminalReader(t, process)
	if line(t, reader) != "ready" {
		t.Fatal("child did not enter raw mode")
	}
	data := []byte("\x1b[A\x1b[31m\xf0\x9f\x90\x88\x03\tq\r\n!")
	if len(data) != 18 {
		t.Fatal("test input size changed")
	}
	if err := process.Write(t.Context(), data); err != nil {
		t.Fatal(err)
	}
	output, err := io.ReadAll(reader)
	if err != nil || !bytes.Equal(output, data) {
		t.Fatalf("raw input was changed: %q, %v", output, err)
	}
	if result, err := process.Wait(t.Context()); err != nil || result.ExitCode != 37 {
		t.Fatal("echo child failed")
	}
}

func TestProcessCanonicalUnicodeErase(t *testing.T) {
	process := startChild(t, childCommand(t, "canonical"))
	reader := terminalReader(t, process)
	if line(t, reader) != "ready" {
		t.Fatal("terminal input is not configured for UTF-8")
	}
	if err := process.Write(t.Context(), []byte("A\xf0\x9f\x90\x88\x7fB\r")); err != nil {
		t.Fatal(err)
	}
	if line(t, reader) != `line:"AB\n"` {
		t.Fatal("erase removed a byte instead of the whole UTF-8 character")
	}
	if _, err := io.Copy(io.Discard, reader); err != nil {
		t.Fatal(err)
	}
	if result, err := process.Wait(t.Context()); err != nil || result.ExitCode != 0 {
		t.Fatal("canonical input failed")
	}
}

func TestProcessResizeAndGroupInterrupt(t *testing.T) {
	process := startChild(t, childCommand(t, "control"))
	reader := terminalReader(t, process)
	if line(t, reader) != "ready" {
		t.Fatal("child not ready")
	}
	for _, size := range [][2]int{{20, 5}, {500, 200}, {91, 37}} {
		if err := process.Resize(t.Context(), size[0], size[1]); err != nil {
			t.Fatal(err)
		}
		if line(t, reader) != fmt.Sprintf("size %d %d", size[0], size[1]) {
			t.Fatal("child did not receive SIGWINCH with the new dimensions")
		}
	}
	for _, size := range [][2]int{{19, 5}, {501, 200}, {80, 4}, {80, 201}} {
		if err := process.Resize(t.Context(), size[0], size[1]); err == nil {
			t.Fatal("invalid size was accepted")
		}
	}
	if err := process.Interrupt(t.Context()); err != nil {
		t.Fatal(err)
	}
	if line(t, reader) != "interrupted" {
		t.Fatal("child did not receive SIGINT")
	}
	if _, err := io.Copy(io.Discard, reader); err != nil {
		t.Fatal(err)
	}
	if result, err := process.Wait(t.Context()); err != nil || result.ExitCode != 42 {
		t.Fatal("interrupt handler outcome was not preserved")
	}
}

func TestInterruptReachesTheWholeProcessGroup(t *testing.T) {
	process := startChild(t, childCommand(t, "tree"))
	reader := terminalReader(t, process)
	ready := []string{line(t, reader), line(t, reader)}
	slices.Sort(ready)
	if !slices.Equal(ready, []string{"leaf ready", "parent ready"}) {
		t.Fatal("process tree not ready")
	}
	if err := process.Interrupt(t.Context()); err != nil {
		t.Fatal(err)
	}
	output, err := io.ReadAll(reader)
	if err != nil || !strings.Contains(string(output), "parent interrupted") || !strings.Contains(string(output), "leaf interrupted") {
		t.Fatal("interrupt did not reach both processes")
	}
	if result, err := process.Wait(t.Context()); err != nil || result.ExitCode != 42 {
		t.Fatal("process tree was not reaped")
	}
	if err := unix.Kill(-process.PID(), 0); !errors.Is(err, unix.ESRCH) {
		t.Fatal("process group survived wait")
	}
}

func TestInterruptReachesRawModeWithoutInjectingInput(t *testing.T) {
	process := startChild(t, childCommand(t, "raw-control"))
	reader := terminalReader(t, process)
	if line(t, reader) != "ready" {
		t.Fatal("raw child not ready")
	}
	settings, err := unix.IoctlGetTermios(process.fd, readTermios)
	if err != nil || settings.Lflag&unix.ISIG != 0 {
		t.Fatal("test child did not disable terminal signal characters")
	}
	if err := process.Interrupt(t.Context()); err != nil {
		t.Fatal(err)
	}
	if line(t, reader) != "interrupted" {
		t.Fatal("raw child did not receive the interrupt signal")
	}
	ctx, cancel := context.WithTimeout(t.Context(), time.Second)
	defer cancel()
	if result, err := process.Wait(ctx); err != nil || result.ExitCode != 42 {
		t.Fatalf("raw child outcome = %+v, %v", result, err)
	}
}

func TestInterruptReachesInteractiveShellForegroundJob(t *testing.T) {
	binary, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	directory := t.TempDir()
	environment := []string{"PATH=/usr/bin:/bin", "HOME=" + directory, "ENV=", "PS1=", "PS2="}
	if coverage := os.Getenv("GOCOVERDIR"); coverage != "" {
		environment = append(environment, "GOCOVERDIR="+coverage)
	}
	command, err := leash.NewCommand([]string{"/bin/sh", "-i"}, directory, "Interactive shell test", environment, nil)
	if err != nil {
		t.Fatal(err)
	}
	process := startChild(t, command)
	reader := terminalReader(t, process)
	quotedBinary := "'" + strings.ReplaceAll(binary, "'", "'\"'\"'") + "'"
	script := "TAILMOUSE_PTY_TEST_CHILD=control " + quotedBinary + " -test.run='^TestPTYChild$'; printf '\\njob-exit:%s\\n' \"$?\"\n"
	if err := process.Write(t.Context(), []byte(script)); err != nil {
		t.Fatal(err)
	}
	for line(t, reader) != "ready" {
	}
	foreground, err := unix.IoctlGetInt(process.fd, unix.TIOCGPGRP)
	if err != nil || foreground <= 1 || foreground == process.PID() {
		t.Fatal("interactive shell did not create a separate foreground job")
	}
	// Clean up this exact test job even if the pre-fix interrupt misses it.
	t.Cleanup(func() {
		if session, err := unix.Getsid(foreground); err == nil && session == process.PID() {
			_ = unix.Kill(-foreground, unix.SIGKILL)
		}
	})
	if err := process.Interrupt(t.Context()); err != nil {
		t.Fatal(err)
	}
	for line(t, reader) != "interrupted" {
	}
	for line(t, reader) != "job-exit:42" {
	}
	// A fresh command also proves the interrupted foreground job returned
	// terminal ownership to its live interactive shell.
	if err := process.Write(t.Context(), []byte("printf 'shell-alive\\n'\nexit 0\n")); err != nil {
		t.Fatal(err)
	}
	for line(t, reader) != "shell-alive" {
	}
	// Keep the PTY consumer alive through the shell's final terminal writes.
	if _, err := io.Copy(io.Discard, reader); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(t.Context(), time.Second)
	defer cancel()
	if result, err := process.Wait(ctx); err != nil || result.ExitCode != 0 {
		t.Fatalf("foreground interrupt lost shell cleanup: %v, %v", result, err)
	}
}

func TestInterruptRejectsMissingForegroundWithoutSignalingAnotherGroup(t *testing.T) {
	master, slave, err := nativepty.Open()
	if err != nil {
		t.Fatal(err)
	}
	defer master.Close()
	defer slave.Close()
	// This real PTY has never had a child or a controlling foreground job.
	process := &Process{fd: int(master.Fd()), done: make(chan struct{})}
	if err := process.Interrupt(t.Context()); err == nil {
		t.Fatal("missing foreground was accepted")
	}
	process.fd = -1
	if err := process.Interrupt(t.Context()); !errors.Is(err, unix.EBADF) {
		t.Fatal("invalid terminal descriptor did not preserve its error")
	}
	close(process.done)
	if err := process.Interrupt(t.Context()); err != nil {
		t.Fatal("an already finished job was treated as an active failure")
	}
}

func TestInterruptAfterNormalExitDoesNotTargetAnotherProcess(t *testing.T) {
	process := startChild(t, childCommand(t, "inspect"))
	if _, err := io.Copy(io.Discard, terminalReader(t, process)); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(t.Context(), time.Second)
	defer cancel()
	if _, err := process.Wait(ctx); err != nil {
		t.Fatal(err)
	}
	if err := process.Interrupt(ctx); err != nil {
		t.Fatal("a finished foreground job caused an interrupt failure")
	}
}

func TestProcessCancellationBackpressureAndClose(t *testing.T) {
	process := startChild(t, childCommand(t, "idle"))
	reader := terminalReader(t, process)
	if line(t, reader) != "ready" {
		t.Fatal("child not ready")
	}
	ctx, cancel := context.WithTimeout(t.Context(), 75*time.Millisecond)
	defer cancel()
	if _, err := process.Read(ctx, make([]byte, 1)); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatal("blocked read ignored cancellation")
	}
	if _, err := process.Wait(ctx); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatal("wait ignored cancellation")
	}
	if err := process.Resize(ctx, 80, 24); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatal("resize ignored cancellation")
	}
	if err := process.Interrupt(ctx); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatal("interrupt ignored cancellation")
	}
	if err := unix.Kill(process.PID(), 0); err != nil {
		t.Fatal("observation cancellation killed child")
	}
	blocked, cancelBlocked := context.WithTimeout(t.Context(), 75*time.Millisecond)
	defer cancelBlocked()
	if err := process.Write(blocked, make([]byte, 2<<20)); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatal("full terminal input ignored cancellation")
	}
	if n, err := process.Read(t.Context(), nil); n != 0 || err != nil {
		t.Fatal("empty read failed")
	}
	if err := process.Write(t.Context(), nil); err != nil {
		t.Fatal("empty write failed")
	}
	var workers sync.WaitGroup
	failures := make(chan error, 2)
	workers.Go(func() { _, err := process.Read(t.Context(), make([]byte, 1)); failures <- err })
	workers.Go(func() { failures <- process.Write(t.Context(), make([]byte, 2<<20)) })
	if err := process.Close(t.Context()); err != nil {
		t.Fatal(err)
	}
	workers.Wait()
	close(failures)
	for err := range failures {
		if !errors.Is(err, os.ErrClosed) {
			t.Fatalf("close did not stop I/O: %v", err)
		}
	}
	if err := process.Close(t.Context()); err != nil {
		t.Fatal("close was not idempotent")
	}
	result, err := process.Wait(t.Context())
	if err != nil || result.Signal != int(unix.SIGKILL) || result.ExitCode != 128+int(unix.SIGKILL) {
		t.Fatal("forced child result was not preserved")
	}
	if err := process.Resize(t.Context(), 80, 24); !errors.Is(err, os.ErrClosed) {
		t.Fatal("resize used a closed handle")
	}
	if err := process.Interrupt(t.Context()); !errors.Is(err, os.ErrClosed) {
		t.Fatal("interrupt used a closed process")
	}
	if err := unix.Kill(process.PID(), 0); !errors.Is(err, unix.ESRCH) {
		t.Fatal("child leaked after close")
	}
}

func TestCloseKillsTheWholeProcessGroup(t *testing.T) {
	process := startChild(t, childCommand(t, "tree"))
	reader := terminalReader(t, process)
	ready := []string{line(t, reader), line(t, reader)}
	slices.Sort(ready)
	if !slices.Equal(ready, []string{"leaf ready", "parent ready"}) {
		t.Fatal("process tree not ready")
	}
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	if err := process.Close(ctx); err != nil {
		t.Fatal(err)
	}
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	for {
		err := unix.Kill(-process.PID(), 0)
		if errors.Is(err, unix.ESRCH) {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		select {
		case <-ctx.Done():
			t.Fatal("child process group leaked after close")
		case <-ticker.C:
		}
	}
}

func TestClosePreservesKillBeforeTerminalHangup(t *testing.T) {
	for _, stopped := range []bool{false, true} {
		t.Run(fmt.Sprintf("stopped=%t", stopped), func(t *testing.T) {
			process := startChild(t, childCommand(t, "idle"))
			if line(t, terminalReader(t, process)) != "ready" {
				t.Fatal("child not ready")
			}
			if stopped {
				if err := unix.Kill(process.PID(), unix.SIGSTOP); err != nil {
					t.Fatal(err)
				}
			}
			ctx, cancel := context.WithTimeout(t.Context(), time.Second)
			defer cancel()
			if err := process.Close(ctx); err != nil {
				t.Fatal(err)
			}
			if result, err := process.Wait(ctx); err != nil || result.Signal != int(unix.SIGKILL) || result.ExitCode != 137 {
				t.Fatalf("terminal hangup replaced forced exit: %+v, %v", result, err)
			}
		})
	}
}

func TestProcessStartupErrorsAreClassifiedAndRedacted(t *testing.T) {
	base := childCommand(t, "inspect")
	directory := t.TempDir()
	plain := filepath.Join(directory, "private-command")
	if err := os.WriteFile(plain, []byte("not an executable"), 0600); err != nil {
		t.Fatal(err)
	}
	garbage := filepath.Join(directory, "bad-format")
	if err := os.WriteFile(garbage, []byte("not an executable"), 0700); err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		name, cwd string
		path      []string
		code      int
		cause     error
	}{
		{"missing-program", directory, nil, 127, exec.ErrNotFound},
		{filepath.Join(directory, "missing"), directory, nil, 127, os.ErrNotExist},
		{base.Argv()[0], filepath.Join(directory, "missing"), nil, 7, os.ErrNotExist},
		{base.Argv()[0], plain, nil, 7, unix.ENOTDIR},
		{plain, directory, nil, 126, os.ErrPermission},
		{garbage, directory, nil, 126, unix.ENOEXEC},
		{directory, directory, nil, 126, os.ErrPermission},
		{"private-command", directory, []string{"PATH=" + directory}, 126, os.ErrPermission},
		{"missing", directory, []string{"PATH=" + plain + ":" + directory}, 127, exec.ErrNotFound},
	}
	for index, test := range cases {
		t.Run(fmt.Sprint(index), func(t *testing.T) {
			command, err := leash.NewCommand([]string{test.name, "private-argument"}, test.cwd, "Test", nil, append(test.path, "PRIVATE=private-value"))
			if err != nil {
				t.Fatal(err)
			}
			process, err := Start(t.Context(), command)
			var launch *StartError
			if process != nil || !errors.As(err, &launch) || launch.ExitCode() != test.code || !errors.Is(err, test.cause) {
				t.Fatalf("unexpected startup classification: %v", err)
			}
			for _, format := range []string{"%v", "%+v", "%#v"} {
				if strings.Contains(fmt.Sprintf(format, launch), "private-") || strings.Contains(fmt.Sprintf(format, *launch), "private-") {
					t.Fatal("startup error leaked command data")
				}
			}
		})
	}
	if process, err := Start(t.Context(), nil); process != nil || !errors.Is(err, leash.ErrCommand) {
		t.Fatal("nil snapshot was accepted")
	}
	if process, err := Start(t.Context(), &leash.Command{}); process != nil || !errors.Is(err, leash.ErrCommand) {
		t.Fatal("zero-value snapshot was accepted")
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if process, err := Start(ctx, base); process != nil || !errors.Is(err, context.Canceled) {
		t.Fatal("canceled startup launched a process")
	}
}
