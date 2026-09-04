// Package leash owns terminal-mode state without operating-system or transport I/O.
package leash

import (
	"errors"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"unicode"
	"unicode/utf8"
)

var ErrCommand = errors.New("invalid leash command snapshot")

// Command is immutable after construction. It deliberately has no exported
// fields or serialized representation: process arguments and environment are
// not diagnostics or browser metadata.
type Command struct {
	argv, environment []string
	cwd, title        string
}

// NewCommand receives an absolute working directory resolved by the CLI.
// Environment overrides use last-value-wins semantics, as os/exec does.
// TERM is a product invariant; no shell or environment expansion occurs here.
func NewCommand(argv []string, cwd, title string, inherited, overrides []string) (*Command, error) {
	if len(argv) == 0 || argv[0] == "" || !filepath.IsAbs(cwd) || strings.ContainsRune(cwd, 0) {
		return nil, ErrCommand
	}
	for _, value := range argv {
		if strings.ContainsRune(value, 0) {
			return nil, ErrCommand
		}
	}
	if title == "" {
		title = filepath.Base(argv[0])
	}
	if !utf8.ValidString(title) || len(title) > 256 || strings.ContainsFunc(title, unicode.IsControl) {
		return nil, ErrCommand
	}
	environment := make([]string, 0, len(inherited)+len(overrides)+1)
	positions := make(map[string]int)
	for index, values := range [][]string{inherited, overrides, {"TERM=xterm-256color"}} {
		for _, value := range values {
			equal := strings.IndexByte(value, '=')
			// Windows inherits hidden per-drive directory variables such as
			// =C:=C:\work. They are not accepted as explicit --env overrides.
			if equal == 0 && index == 0 && runtime.GOOS == "windows" {
				if next := strings.IndexByte(value[1:], '='); next >= 0 {
					equal = next + 1
				}
			}
			if equal <= 0 || strings.ContainsRune(value, 0) {
				return nil, ErrCommand
			}
			key := value[:equal]
			if runtime.GOOS == "windows" {
				key = strings.ToUpper(key)
			}
			if position, exists := positions[key]; exists {
				environment[position] = value
			} else {
				positions[key] = len(environment)
				environment = append(environment, value)
			}
		}
	}
	return &Command{argv: slices.Clone(argv), cwd: cwd, title: title, environment: environment}, nil
}

func (command *Command) Argv() []string        { return slices.Clone(command.argv) }
func (command *Command) Environment() []string { return slices.Clone(command.environment) }
func (command *Command) Cwd() string           { return command.cwd }
func (command *Command) Title() string         { return command.title }
func (command Command) String() string         { return "leash command (redacted)" }
func (command Command) GoString() string       { return command.String() }
