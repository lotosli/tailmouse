//go:build windows

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
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"
	"unicode/utf8"
	"unsafe"

	"golang.org/x/sys/windows"

	"tailmouse/apps/cli/internal/leash"
)

type consoleReport struct {
	PID                  int
	Cols, Rows           int16
	Terminal             [3]bool
	Cwd, Term, Value     string
	Argv                 []string
	Input                string
	FinalCols, FinalRows int16
}

// The native test executable is the only child. Reports contain synthetic
// command data in the test's private temporary directory, never host env/logs.
func TestConPTYChild(t *testing.T) {
	mode := os.Getenv("TAILMOUSE_CONPTY_TEST_CHILD")
	if mode == "" {
		return
	}
	watchdog := time.AfterFunc(15*time.Second, func() { os.Exit(124) })
	defer watchdog.Stop()
	if strings.HasPrefix(mode, "terminate-") {
		conPTYTerminateChild(mode)
		os.Exit(125)
	}
	if strings.HasPrefix(mode, "interrupt-") {
		conPTYInterruptChild(mode)
		os.Exit(125)
	}
	if strings.HasPrefix(mode, "exit:") {
		code, err := strconv.ParseUint(strings.TrimPrefix(mode, "exit:"), 10, 32)
		if err != nil {
			os.Exit(125)
		}
		windows.ExitProcess(uint32(code))
	}
	if mode == "tree" {
		binary, err := os.Executable()
		if err != nil {
			os.Exit(125)
		}
		child := exec.Command(binary, "-test.run=^TestConPTYChild$")
		child.Env = append(os.Environ(), "TAILMOUSE_CONPTY_TEST_CHILD=leaf")
		child.Stdin, child.Stdout, child.Stderr = os.Stdin, os.Stdout, os.Stderr
		if err := child.Start(); err != nil {
			os.Exit(125)
		}
		// Deliberately leave the descendant attached after the root exits.
		os.Exit(72)
	}
	if mode == "leaf" {
		if err := os.WriteFile("leaf.pid", []byte(strconv.Itoa(os.Getpid())), 0o600); err != nil {
			os.Exit(125)
		}
	}
	output, err := windows.GetStdHandle(windows.STD_OUTPUT_HANDLE)
	if err != nil {
		os.Exit(125)
	}
	var settings uint32
	if windows.GetConsoleMode(output, &settings) != nil || windows.SetConsoleMode(output, settings|windows.ENABLE_VIRTUAL_TERMINAL_PROCESSING) != nil {
		os.Exit(125)
	}
	var size windows.ConsoleScreenBufferInfo
	if windows.GetConsoleScreenBufferInfo(output, &size) != nil {
		os.Exit(125)
	}
	cwd, err := os.Getwd()
	if err != nil {
		os.Exit(125)
	}
	report := consoleReport{PID: os.Getpid(), Cols: size.Size.X, Rows: size.Size.Y, Cwd: cwd, Term: os.Getenv("TERM"), Value: os.Getenv("VALUE"), Argv: os.Args}
	for i, standard := range []uint32{windows.STD_INPUT_HANDLE, windows.STD_OUTPUT_HANDLE, windows.STD_ERROR_HANDLE} {
		handle, err := windows.GetStdHandle(standard)
		report.Terminal[i] = err == nil && windows.GetConsoleMode(handle, &settings) == nil
	}
	if _, err := fmt.Fprint(os.Stdout, "\x1b[31mUTF8 🐈\x1b[0m\r\n"); err != nil {
		os.Exit(125)
	}
	if _, err := fmt.Fprint(os.Stderr, "merged-stderr\r\nready\r\n"); err != nil {
		os.Exit(125)
	}
	if mode == "idle" {
		<-time.After(14 * time.Second)
		os.Exit(124)
	}
	input, err := bufio.NewReader(os.Stdin).ReadString('\n')
	if err != nil || windows.GetConsoleScreenBufferInfo(output, &size) != nil {
		os.Exit(125)
	}
	report.Input = strings.TrimRight(input, "\r\n")
	report.FinalCols, report.FinalRows = size.Size.X, size.Size.Y
	encoded, err := json.Marshal(report)
	if err != nil || os.WriteFile(filepath.Join(cwd, "report.json"), encoded, 0o600) != nil {
		os.Exit(125)
	}
	os.Exit(23)
}

func conPTYCommand(t *testing.T, mode string, extra ...string) *leash.Command {
	t.Helper()
	binary, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	argv := append([]string{binary, "-test.run=^TestConPTYChild$", "--"}, extra...)
	command, err := leash.NewCommand(argv, t.TempDir(), "ConPTY test", os.Environ(), []string{"TAILMOUSE_CONPTY_TEST_CHILD=" + mode, "VALUE=exact=a=b", "TERM=ignored"})
	if err != nil {
		t.Fatal(err)
	}
	return command
}

func startConPTY(t *testing.T, command *leash.Command) *Process {
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

func conPTYReady(t *testing.T, process *Process) []byte {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	var output []byte
	data := make([]byte, 4096)
	for len(output) < 64<<10 {
		count, err := process.Read(ctx, data)
		output = append(output, data[:count]...)
		if bytes.Contains(output, []byte("ready")) {
			return output
		}
		if err != nil {
			t.Fatal("ConPTY did not produce readiness", err)
		}
	}
	t.Fatal("ConPTY readiness exceeded the bounded output budget")
	return nil
}

func TestConPTYLiteralSnapshotResizeUnicodeAndExit(t *testing.T) {
	command := conPTYCommand(t, "inspect", "", "a b", `a"b`, `a b\`, "🐈", "%VALUE%", "&", "|")
	process := startConPTY(t, command)
	output := conPTYReady(t, process)
	if !bytes.Contains(output, []byte("UTF8 🐈")) || !bytes.Contains(output, []byte("merged-stderr")) || !bytes.Contains(output, []byte("\x1b[")) || !utf8.Valid(output) {
		t.Fatal("ConPTY did not provide merged UTF-8 virtual-terminal output")
	}
	for _, size := range [][2]int{{19, 5}, {501, 200}, {80, 4}, {80, 201}} {
		if process.Resize(t.Context(), size[0], size[1]) == nil {
			t.Fatal("invalid size reached ConPTY")
		}
	}
	if err := process.Resize(t.Context(), 120, 40); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	if err := process.Write(ctx, []byte("line 🐈\r")); err != nil {
		t.Fatal(err)
	}
	drainConPTY(t, ctx, process)
	if result, err := process.Wait(ctx); err != nil || result.ExitCode != 23 || result.Signal != 0 {
		t.Fatal("ConPTY child result changed", err)
	}
	encoded, err := os.ReadFile(filepath.Join(command.Cwd(), "report.json"))
	if err != nil {
		t.Fatal(err)
	}
	var report consoleReport
	if err := json.Unmarshal(encoded, &report); err != nil {
		t.Fatal(err)
	}
	if report.PID != process.PID() || report.Cols != 80 || report.Rows != 24 || report.Terminal != [3]bool{true, true, true} || !strings.EqualFold(report.Cwd, command.Cwd()) || report.Term != "xterm-256color" || report.Value != "exact=a=b" || !slices.Equal(report.Argv, command.Argv()) {
		t.Fatal("child did not receive the exact initial terminal and command snapshot")
	}
	if report.Input != "line 🐈" || report.FinalCols != 120 || report.FinalRows != 40 {
		t.Fatal("ConPTY input or resize did not reach the child")
	}
}

func drainConPTY(t *testing.T, ctx context.Context, process *Process) {
	t.Helper()
	// A normal child exit must drain to EOF without the owner prematurely
	// closing the pseudoconsole or discarding its last terminal bytes.
	data := make([]byte, 4096)
	for total := 0; ; {
		count, err := process.Read(ctx, data)
		total += count
		if errors.Is(err, io.EOF) {
			return
		}
		if err != nil || total > 64<<10 {
			t.Fatal("normal ConPTY exit failed to drain within its bound", err)
		}
	}
}

func TestConPTYDescendantOutlivesRootUntilExitOrExplicitClose(t *testing.T) {
	for _, force := range []bool{false, true} {
		t.Run(fmt.Sprintf("force=%t", force), func(t *testing.T) {
			command := conPTYCommand(t, "tree")
			process := startConPTY(t, command)
			conPTYReady(t, process)
			ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
			defer cancel()
			if result, err := process.Wait(ctx); err != nil || result.ExitCode != 72 {
				t.Fatal("root process did not finish independently", err)
			}
			select {
			case <-process.released:
				t.Fatal("root exit prematurely released the descendant's terminal")
			default:
			}
			encoded, err := os.ReadFile(filepath.Join(command.Cwd(), "leaf.pid"))
			if err != nil {
				t.Fatal(err)
			}
			pid, err := strconv.ParseUint(string(encoded), 10, 32)
			if err != nil || pid == uint64(process.PID()) {
				t.Fatal("fixture did not create a distinct descendant")
			}
			// Hold an identity-stable handle before cleanup, not a numeric PID
			// probe that could accidentally inspect a later reused process.
			leaf, err := windows.OpenProcess(windows.SYNCHRONIZE|windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
			if err != nil {
				t.Fatal(err)
			}
			defer func() {
				if err := windows.CloseHandle(leaf); err != nil {
					t.Error(err)
				}
			}()
			want := uint32(23)
			if force {
				want = 1
				if err := process.Close(ctx); err != nil {
					t.Fatal(err)
				}
			} else {
				if err := process.Write(ctx, []byte("finish\r")); err != nil {
					t.Fatal(err)
				}
				drainConPTY(t, ctx, process)
			}
			if status, err := windows.WaitForSingleObject(leaf, 1000); err != nil || status != windows.WAIT_OBJECT_0 {
				t.Fatal("descendant survived completion", err)
			}
			var code uint32
			if err := windows.GetExitCodeProcess(leaf, &code); err != nil || code != want {
				t.Fatal("descendant did not preserve its normal or forced result", err)
			}
		})
	}
}

func TestConPTYWaitPreservesFullWidthStatus(t *testing.T) {
	for _, code := range []uint32{0, 255, 256, 259, 0xc000013a, 0xffffffff} {
		t.Run(strconv.FormatUint(uint64(code), 10), func(t *testing.T) {
			process := startConPTY(t, conPTYCommand(t, fmt.Sprintf("exit:%d", code)))
			ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
			defer cancel()
			if result, err := process.Wait(ctx); err != nil || result.ExitCode != int(code) || result.Signal != 0 {
				t.Fatal("native DWORD exit status was changed or interpreted as still active", err)
			}
		})
	}
}

func TestConPTYOwnsJobAndClosesCancellableIO(t *testing.T) {
	process := startConPTY(t, conPTYCommand(t, "idle"))
	conPTYReady(t, process)
	var limits windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION
	if err := windows.QueryInformationJobObject(process.job, windows.JobObjectExtendedLimitInformation, uintptr(unsafe.Pointer(&limits)), uint32(unsafe.Sizeof(limits)), nil); err != nil {
		t.Fatal(err)
	}
	if limits.BasicLimitInformation.LimitFlags != windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE {
		t.Fatal("child job allows breakaway or lacks kill-on-close")
	}
	var members struct {
		Assigned, Listed uint32
		PIDs             [16]uintptr
	}
	if err := windows.QueryInformationJobObject(process.job, windows.JobObjectBasicProcessIdList, uintptr(unsafe.Pointer(&members)), uint32(unsafe.Sizeof(members)), nil); err != nil || members.Listed > uint32(len(members.PIDs)) || !slices.Contains(members.PIDs[:members.Listed], uintptr(process.PID())) {
		t.Fatal("child was not placed in its owned job", err)
	}
	canceled, cancel := context.WithCancel(t.Context())
	cancel()
	if _, err := process.Wait(canceled); !errors.Is(err, context.Canceled) {
		t.Fatal("wait ignored cancellation", err)
	}
	if _, err := process.Read(canceled, make([]byte, 1)); !errors.Is(err, context.Canceled) {
		t.Fatal("read ignored cancellation", err)
	}
	if err := process.Write(canceled, []byte("discarded")); !errors.Is(err, context.Canceled) {
		t.Fatal("write ignored cancellation", err)
	}
	if err := process.Resize(canceled, 120, 40); !errors.Is(err, context.Canceled) {
		t.Fatal("resize ignored cancellation", err)
	}
	readDone := make(chan error, 1)
	go func() {
		data := make([]byte, 4096)
		for {
			if _, err := process.Read(t.Context(), data); err != nil {
				readDone <- err
				return
			}
		}
	}()
	ctx, stop := context.WithTimeout(t.Context(), 3*time.Second)
	defer stop()
	if err := process.Close(ctx); err != nil {
		t.Fatal("owned process cleanup failed", err)
	}
	select {
	case err := <-readDone:
		if !errors.Is(err, os.ErrClosed) && !errors.Is(err, io.EOF) {
			t.Fatal("blocked terminal read was not canceled cleanly", err)
		}
	case <-ctx.Done():
		t.Fatal("terminal reader survived cleanup")
	}
	if result, err := process.Wait(ctx); err != nil || result.ExitCode != 1 {
		t.Fatal("forceful cleanup lost the child result", err)
	}
	if err := process.Resize(ctx, 120, 40); !errors.Is(err, os.ErrClosed) {
		t.Fatal("resize reused a closed pseudoconsole", err)
	}
	if err := process.Write(ctx, []byte("x")); !errors.Is(err, os.ErrClosed) {
		t.Fatal("write reused a closed channel", err)
	}
}

func TestConPTYStartupFailuresAllocateNoProcess(t *testing.T) {
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if process, err := Start(ctx, nil); !errors.Is(err, context.Canceled) || process != nil {
		t.Fatal("canceled startup allocated resources")
	}
	if process, err := Start(t.Context(), nil); !errors.Is(err, leash.ErrCommand) || process != nil {
		t.Fatal("nil snapshot allocated resources")
	}
	path := filepath.Join(t.TempDir(), "script.cmd")
	if err := os.WriteFile(path, []byte("@echo off\r\nexit /b 0\r\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	command, err := leash.NewCommand([]string{path}, t.TempDir(), "Invalid image test", nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	process, err := Start(t.Context(), command)
	var failure *StartError
	if process != nil || !errors.As(err, &failure) || failure.ExitCode() != 126 || !errors.Is(err, windows.ERROR_BAD_EXE_FORMAT) {
		t.Fatal("script was silently wrapped in a shell or misclassified", err)
	}
}
