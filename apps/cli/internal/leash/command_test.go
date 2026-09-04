package leash

import (
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"testing"
)

func TestCommandPreservesLiteralSnapshot(t *testing.T) {
	argv := []string{filepath.Join(t.TempDir(), "program"), "", "a b", "*", "$HOME", "$(echo unsafe)", "|", ";"}
	wantArgv := slices.Clone(argv)
	inherited := []string{"LANG=C.UTF-8", "VALUE=old", "VALUE=last", "TERM=dumb", "EMPTY=not-empty"}
	overrides := []string{"VALUE=first", "VALUE=exact=a=b", "EMPTY=", "TERM=ignored"}
	cwd := t.TempDir()
	command, err := NewCommand(argv, cwd, "", inherited, overrides)
	if err != nil {
		t.Fatal(err)
	}
	argv[0], inherited[0], overrides[0] = "changed", "CHANGED=yes", "CHANGED=yes"
	command.Argv()[0], command.Environment()[0] = "changed", "CHANGED=yes"
	if !slices.Equal(command.Argv(), wantArgv) || command.Cwd() != cwd || command.Title() != "program" {
		t.Fatal("command snapshot changed or expanded argv")
	}
	wantEnv := []string{"LANG=C.UTF-8", "VALUE=exact=a=b", "TERM=xterm-256color", "EMPTY="}
	if !slices.Equal(command.Environment(), wantEnv) {
		t.Fatal("environment was not copied with last-value-wins and the required TERM")
	}
	for range 2 {
		if !slices.Equal(command.Argv(), wantArgv) || !slices.Equal(command.Environment(), wantEnv) {
			t.Fatal("restart did not receive the original snapshot")
		}
	}
}

func TestCommandRejectsInvalidDataWithoutDisclosure(t *testing.T) {
	cwd := t.TempDir()
	cases := []struct {
		name                 string
		argv                 []string
		cwd, title           string
		inherited, overrides []string
	}{
		{name: "empty argv", cwd: cwd},
		{name: "empty executable", argv: []string{""}, cwd: cwd},
		{name: "argument NUL", argv: []string{"program", "private\x00argument"}, cwd: cwd},
		{name: "relative directory", argv: []string{"program"}, cwd: "relative"},
		{name: "directory NUL", argv: []string{"program"}, cwd: cwd + "\x00"},
		{name: "invalid title UTF8", argv: []string{"program"}, cwd: cwd, title: "\xff"},
		{name: "title control", argv: []string{"program"}, cwd: cwd, title: "unsafe\x1b[2J"},
		{name: "derived title control", argv: []string{"program\n"}, cwd: cwd},
		{name: "long title", argv: []string{"program"}, cwd: cwd, title: strings.Repeat("x", 257)},
		{name: "environment missing equals", argv: []string{"program"}, cwd: cwd, inherited: []string{"PRIVATE"}},
		{name: "environment empty key", argv: []string{"program"}, cwd: cwd, overrides: []string{"=private"}},
		{name: "override hidden key", argv: []string{"program"}, cwd: cwd, overrides: []string{"=C:=private"}},
		{name: "environment NUL", argv: []string{"program"}, cwd: cwd, overrides: []string{"PRIVATE=value\x00"}},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			command, err := NewCommand(test.argv, test.cwd, test.title, test.inherited, test.overrides)
			if command != nil || !errors.Is(err, ErrCommand) || err.Error() != ErrCommand.Error() {
				t.Fatal("invalid snapshot did not fail with the fixed safe error")
			}
		})
	}
}

func TestCommandTitleAndRedactedFormatting(t *testing.T) {
	for _, title := range []string{"Terminal session", "Unicode \u2728", strings.Repeat("x", 256)} {
		command, err := NewCommand([]string{"program", "private-argument"}, t.TempDir(), title, []string{"PRIVATE=private-value"}, nil)
		if err != nil || command.Title() != title {
			t.Fatal("valid explicit title was rejected or changed")
		}
		for _, value := range []any{command, *command} {
			for _, format := range []string{"%v", "%+v", "%#v", "%s", "%q"} {
				printed := fmt.Sprintf(format, value)
				if strings.Contains(printed, "private-") || !strings.Contains(printed, "redacted") {
					t.Fatal("diagnostic formatting exposed command data")
				}
			}
			data, err := json.Marshal(value)
			if err != nil || string(data) != "{}" {
				t.Fatal("command snapshot was serializable")
			}
		}
	}
}

func TestCommandPlatformEnvironmentKeys(t *testing.T) {
	inherited := []string{"Mixed=first", "MIXED=second"}
	want := []string{"Mixed=first", "MIXED=second", "TERM=xterm-256color"}
	if runtime.GOOS == "windows" {
		inherited = append(inherited, "=C:=C:\\work")
		want = []string{"MIXED=second", "=C:=C:\\work", "TERM=xterm-256color"}
	}
	command, err := NewCommand([]string{"program"}, t.TempDir(), "", inherited, nil)
	if err != nil || !slices.Equal(command.Environment(), want) {
		t.Fatal("environment key semantics did not match the platform")
	}
	command, err = NewCommand([]string{"program"}, t.TempDir(), "", nil, nil)
	if err != nil || !slices.Equal(command.Environment(), []string{"TERM=xterm-256color"}) {
		t.Fatal("empty environment did not receive the required TERM")
	}
}
