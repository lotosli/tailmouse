//go:build windows

package pty

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"golang.org/x/sys/windows"
)

// These modes run only in the existing, watchdog-bounded native test child.
func conPTYTerminateChild(mode string) {
	if mode == "terminate-detached" {
		free := windows.NewLazySystemDLL("kernel32.dll").NewProc("FreeConsole")
		if err := free.Find(); err != nil {
			os.Exit(125)
		}
		if ok, _, _ := free.Call(); ok == 0 {
			os.Exit(125)
		}
	} else {
		set := windows.NewLazySystemDLL("kernel32.dll").NewProc("SetConsoleCtrlHandler")
		if err := set.Find(); err != nil {
			os.Exit(125)
		}
		handler := windows.NewCallback(func(event uint32) uintptr {
			if event != windows.CTRL_CLOSE_EVENT {
				return 0
			}
			// Console I/O is not guaranteed from a close handler. This private
			// synthetic marker proves the event, independently of terminal EOF.
			if err := os.WriteFile(fmt.Sprintf("closed-%d", os.Getpid()), []byte("closed"), 0o600); err != nil {
				windows.ExitProcess(125)
			}
			windows.ExitProcess(42)
			return 1
		})
		if ok, _, _ := set.Call(handler, 1); ok == 0 {
			os.Exit(125)
		}
	}
	if mode == "terminate-leaf" || mode == "terminate-detached" {
		if err := os.WriteFile("leaf.pid.tmp", []byte(strconv.Itoa(os.Getpid())), 0o600); err != nil {
			os.Exit(125)
		}
		if err := os.Rename("leaf.pid.tmp", "leaf.pid"); err != nil {
			os.Exit(125)
		}
	} else {
		binary, err := os.Executable()
		if err != nil {
			os.Exit(125)
		}
		leafMode := "terminate-leaf"
		if strings.Contains(mode, "detached") {
			leafMode = "terminate-detached"
		}
		child := exec.Command(binary, "-test.run=^TestConPTYChild$")
		child.Env = append(os.Environ(), "TAILMOUSE_CONPTY_TEST_CHILD="+leafMode)
		child.Stdin, child.Stdout, child.Stderr = os.Stdin, os.Stdout, os.Stderr
		if child.Start() != nil {
			os.Exit(125)
		}
		deadline := time.Now().Add(5 * time.Second)
		for {
			if _, err := os.Stat("leaf.pid"); err == nil {
				break
			} else if !errors.Is(err, os.ErrNotExist) || time.Now().After(deadline) {
				os.Exit(125)
			}
			time.Sleep(10 * time.Millisecond)
		}
		if _, err := fmt.Fprint(os.Stdout, "ready\r\n"); err != nil {
			os.Exit(125)
		}
		if strings.HasSuffix(mode, "-exited") {
			windows.ExitProcess(72)
		}
	}
	<-time.After(14 * time.Second)
}

func conPTYLeafHandle(t *testing.T, directory string) (windows.Handle, uint32) {
	t.Helper()
	encoded, err := os.ReadFile(filepath.Join(directory, "leaf.pid"))
	if err != nil {
		t.Fatal(err)
	}
	pid, err := strconv.ParseUint(string(encoded), 10, 32)
	if err != nil || pid == 0 {
		t.Fatal("invalid synthetic descendant identity")
	}
	// Open while the fixture is known to be alive, then retain stable identity.
	handle, err := windows.OpenProcess(windows.SYNCHRONIZE|windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := windows.CloseHandle(handle); err != nil {
			t.Error(err)
		}
	})
	return handle, uint32(pid)
}

func conPTYDrainWorker(t *testing.T, process *Process) <-chan error {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	done := make(chan error, 1)
	go func() {
		defer cancel()
		data := make([]byte, 4096)
		for total := 0; ; {
			count, err := process.Read(ctx, data)
			total += count
			if total > 64<<10 {
				done <- errors.New("termination output exceeded its fixture bound")
				return
			}
			if err != nil {
				if errors.Is(err, io.EOF) || errors.Is(err, os.ErrClosed) {
					err = nil
				}
				done <- err
				return
			}
		}
	}()
	t.Cleanup(cancel)
	return done
}

func TestConPTYTerminateClosesHandlersAndForcesDetachedDescendant(t *testing.T) {
	for _, mode := range []string{"terminate-tree", "terminate-tree-exited", "terminate-tree-detached-exited"} {
		t.Run(mode, func(t *testing.T) {
			command := conPTYCommand(t, mode)
			process := startConPTY(t, command)
			conPTYReady(t, process)
			leaf, pid := conPTYLeafHandle(t, command.Cwd())
			drain := conPTYDrainWorker(t, process)
			ctx, cancel := context.WithTimeout(t.Context(), 8*time.Second)
			defer cancel()
			rootCode := 42
			if strings.HasSuffix(mode, "-exited") {
				rootCode = 72
				if result, err := process.Wait(ctx); err != nil || result.ExitCode != rootCode {
					t.Fatal("root did not exit before descendant", err)
				}
			}
			start := time.Now()
			if err := process.Terminate(ctx); err != nil {
				t.Fatal("termination failed", err)
			}
			elapsed := time.Since(start)
			wantLeaf := uint32(42)
			if strings.Contains(mode, "detached") {
				wantLeaf = 1
				if elapsed < 4900*time.Millisecond || elapsed > 7*time.Second {
					t.Fatalf("forced job termination escaped its grace bound: %s", elapsed)
				}
			} else if elapsed > 4*time.Second {
				t.Fatalf("graceful handlers were not observed promptly: %s", elapsed)
			}
			if state, err := windows.WaitForSingleObject(leaf, 0); err != nil || state != windows.WAIT_OBJECT_0 {
				t.Fatal("termination returned with a surviving descendant", err)
			}
			var code uint32
			if err := windows.GetExitCodeProcess(leaf, &code); err != nil || code != wantLeaf {
				t.Fatalf("descendant exit = %d, expected %d: %v", code, wantLeaf, err)
			}
			if wantLeaf == 42 {
				if data, err := os.ReadFile(filepath.Join(command.Cwd(), fmt.Sprintf("closed-%d", pid))); err != nil || string(data) != "closed" {
					t.Fatal("descendant did not receive the graceful close event", err)
				}
			}
			if result, err := process.Wait(ctx); err != nil || result.ExitCode != rootCode {
				t.Fatal("termination overwrote the root result", err)
			}
			if err := process.Terminate(ctx); err != nil {
				t.Fatal("repeated termination failed", err)
			}
			if err := process.Close(ctx); err != nil {
				t.Fatal(err)
			}
			select {
			case err := <-drain:
				if err != nil {
					t.Fatal(err)
				}
			case <-ctx.Done():
				t.Fatal("output worker survived termination")
			}
		})
	}
}

func TestConPTYTerminateCancellationForcesJobAndJoinsConcurrentCalls(t *testing.T) {
	command := conPTYCommand(t, "terminate-tree-detached-exited")
	process := startConPTY(t, command)
	conPTYReady(t, process)
	leaf, _ := conPTYLeafHandle(t, command.Cwd())
	drain := conPTYDrainWorker(t, process)
	ctx, cancel := context.WithCancel(t.Context())
	results := make(chan error, 4)
	for range 4 {
		go func() { results <- process.Terminate(ctx) }()
	}
	start := time.Now()
	cancel()
	deadline, finish := context.WithTimeout(t.Context(), 3*time.Second)
	defer finish()
	for range 4 {
		select {
		case err := <-results:
			if !errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
				t.Fatal("termination lost cancellation or failed bounded cleanup", err)
			}
		case <-deadline.Done():
			t.Fatal("concurrent termination worker survived cancellation")
		}
	}
	if time.Since(start) > 2*time.Second {
		t.Fatal("cancellation did not shorten the five-second grace period")
	}
	if state, err := windows.WaitForSingleObject(leaf, 0); err != nil || state != windows.WAIT_OBJECT_0 {
		t.Fatal("cancellation returned before descendant exit", err)
	}
	if err := process.Close(deadline); err != nil {
		t.Fatal(err)
	}
	select {
	case <-process.consoleClosed:
	default:
		t.Fatal("native console-close worker survived final cleanup")
	}
	select {
	case err := <-drain:
		if err != nil {
			t.Fatal(err)
		}
	case <-deadline.Done():
		t.Fatal("output worker survived cancellation")
	}
}

func TestConPTYJobObservationPropagatesCancellationAndInvalidHandle(t *testing.T) {
	if err := waitForEmptyJob(t.Context(), 0); err != nil {
		t.Fatal("absent startup job required an observation", err)
	}
	if err := waitForEmptyJob(t.Context(), windows.InvalidHandle); !errors.Is(err, windows.ERROR_INVALID_HANDLE) {
		t.Fatal("invalid job observation was reported as completion", err)
	}
	if err := terminateJobAndWait(t.Context(), windows.InvalidHandle); !errors.Is(err, windows.ERROR_INVALID_HANDLE) {
		t.Fatal("invalid job termination was reported as completion", err)
	}
	process := startConPTY(t, conPTYCommand(t, "idle"))
	conPTYReady(t, process)
	ctx, cancel := context.WithTimeout(t.Context(), 20*time.Millisecond)
	defer cancel()
	process.mu.RLock()
	err := waitForEmptyJob(ctx, process.job)
	process.mu.RUnlock()
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatal("live job observation did not obey its deadline", err)
	}
}
