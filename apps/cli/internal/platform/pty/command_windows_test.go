//go:build windows

package pty

import (
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"unicode/utf16"

	"golang.org/x/sys/windows"

	"tailmouse/apps/cli/internal/leash"
)

func TestWindowsCommandUsesOnlySnapshot(t *testing.T) {
	cwd := t.TempDir()
	directory := filepath.Join(cwd, "stored tools")
	if err := os.Mkdir(directory, 0o700); err != nil {
		t.Fatal(err)
	}
	binary := filepath.Join(directory, "fixture.EXE")
	if err := os.WriteFile(binary, []byte("not executed by lookup tests"), 0o600); err != nil {
		t.Fatal(err)
	}
	argv := []string{"fixture", "", "a b", `a"b`, `a\`, `a b\`, "🐈", "%VALUE%", "&", "|", ";", "$(exit 99)"}
	env := []string{"Path=stored tools", "PATHEXT=.EXE;.COM", "VALUE=before", "Z=last", "a=first", "=C:=C:\\saved"}
	command, err := leash.NewCommand(argv, cwd, "Command test", env, []string{"value=exact=a=b"})
	if err != nil {
		t.Fatal(err)
	}
	// Neither a changed caller slice nor later process environment can affect
	// lookup, argv or the environment used by a restarted generation.
	argv[1], env[0] = "changed", "Path=missing"
	t.Setenv("PATH", t.TempDir())
	t.Setenv("PATHEXT", ".MISSING")
	t.Setenv("VALUE", "changed")
	application, arguments, block, directoryPointer, err := commandWindows(command)
	if err != nil {
		t.Fatal(err)
	}
	if windows.UTF16PtrToString(application) != binary || windows.UTF16PtrToString(directoryPointer) != cwd {
		t.Fatal("lookup did not use stored PATH and cwd")
	}
	decoded, err := windows.DecomposeCommandLine(windows.UTF16PtrToString(arguments))
	if err != nil || !slices.Equal(decoded, command.Argv()) {
		t.Fatal("argument quoting changed literal argv", err)
	}
	if len(block) < 2 || block[len(block)-1] != 0 || block[len(block)-2] != 0 {
		t.Fatal("environment block is not double-NUL terminated")
	}
	entries := strings.Split(string(utf16.Decode(block[:len(block)-2])), "\x00")
	want := []string{"=C:=C:\\saved", "a=first", "Path=stored tools", "PATHEXT=.EXE;.COM", "TERM=xterm-256color", "value=exact=a=b", "Z=last"}
	if !slices.Equal(entries, want) {
		t.Fatal("environment ordering, override or TERM changed")
	}
}

func TestWindowsStoredPathForms(t *testing.T) {
	for _, test := range []struct{ name, cwd, want string }{
		{`tool.exe`, `C:\work`, `C:\work\tool.exe`},
		{`.\tools\..\tool.exe`, `C:\work`, `C:\work\tool.exe`},
		{`\tools\tool.exe`, `C:\work`, `C:\tools\tool.exe`},
		{`c:tool.exe`, `C:\work`, `C:\work\tool.exe`},
		{`D:tool.exe`, `C:\work`, `D:\saved\tool.exe`},
		{`E:tool.exe`, `C:\work`, `E:\tool.exe`},
		{`D:\tools\tool.exe`, `C:\work`, `D:\tools\tool.exe`},
		{`\\server\share\tool.exe`, `C:\work`, `\\server\share\tool.exe`},
		{`\tool.exe`, `\\server\share\work`, `\\server\share\tool.exe`},
	} {
		t.Run(test.name, func(t *testing.T) {
			if got := storedWindowsPath(test.name, test.cwd, []string{`=D:=D:\saved`}); got != test.want {
				t.Fatalf("stored path = %q, want %q", got, test.want)
			}
		})
	}
}

func TestWindowsExecutableSearchAndFailureCodes(t *testing.T) {
	cwd := t.TempDir()
	for _, name := range []string{"local.exe", "explicit.exe", "script.cmd", "odd.custom"} {
		if err := os.WriteFile(filepath.Join(cwd, name), []byte("not a PE binary"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Mkdir(filepath.Join(cwd, "directory.exe"), 0o700); err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		name string
		env  []string
		want string
		code int
	}{
		{"local", nil, "", 127}, // No implicit current-directory search.
		{"local", []string{"PATH=."}, "local.exe", 0},
		{`.\explicit`, nil, "explicit.exe", 0},
		{`.\explicit.exe`, nil, "explicit.exe", 0},
		{"odd", []string{"PATH=.", "PATHEXT=.CUSTOM"}, "odd.custom", 0},
		{"script", []string{"PATH=."}, "script.cmd", 0},
		{"missing", []string{"PATH=."}, "", 127},
		{"directory.exe", []string{"PATH=."}, "", 126},
	} {
		t.Run(test.name, func(t *testing.T) {
			path, err := executableWindows(test.name, cwd, test.env)
			if test.code != 0 {
				if err == nil || launchError(err).ExitCode() != test.code {
					t.Fatal("incorrect executable failure classification", err)
				}
			} else if err != nil || !strings.EqualFold(path, filepath.Join(cwd, test.want)) {
				t.Fatal("stored executable search failed", err)
			}
		})
	}
	for _, test := range []struct {
		err  error
		code int
	}{
		{os.ErrNotExist, 127}, {os.ErrPermission, 126},
		{windows.ERROR_BAD_EXE_FORMAT, 126}, {windows.ERROR_DIRECTORY, 7},
		{windows.ERROR_NOT_ENOUGH_MEMORY, 7},
	} {
		failure := launchError(test.err)
		if failure.ExitCode() != test.code || !errors.Is(failure, test.err) {
			t.Fatal("startup classification lost its code or root error")
		}
	}
	for _, directory := range []string{filepath.Join(cwd, "missing"), filepath.Join(cwd, "local.exe")} {
		command, err := leash.NewCommand([]string{filepath.Join(cwd, "explicit.exe")}, directory, "Startup test", nil, nil)
		if err != nil {
			t.Fatal(err)
		}
		_, _, _, _, err = commandWindows(command)
		var failure *StartError
		if !errors.As(err, &failure) || failure.ExitCode() != 7 {
			t.Fatal("bad cwd was confused with an absent executable")
		}
	}
}

func TestWindowsCommandRejectsLossyAndOversizedArguments(t *testing.T) {
	binary, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		arg  string
		code int
	}{{"\xff", 2}, {strings.Repeat("a", 32767), 7}} {
		command, err := leash.NewCommand([]string{binary, test.arg}, t.TempDir(), "Argument test", nil, nil)
		if err != nil {
			t.Fatal(err)
		}
		_, _, _, _, err = commandWindows(command)
		var failure *StartError
		if !errors.As(err, &failure) || failure.ExitCode() != test.code {
			t.Fatal("unrepresentable argument reached process allocation")
		}
	}
}
