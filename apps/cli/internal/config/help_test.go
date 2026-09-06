package config

import (
	"bytes"
	"errors"
	"strings"
	"testing"
)

func TestHelpDocumentsCommandsBoundariesAndModeFlags(t *testing.T) {
	for _, command := range []string{"", "escape", "leash", "version", "config path"} {
		var output bytes.Buffer
		if err := WriteHelp(&output, command); err != nil {
			t.Fatal(err)
		}
		text := output.String()
		for _, required := range []string{"tailmouse leash", "tailmouse escape", "tailmouse version", "tailmouse config path",
			"--squeak", "--verbose", "TAILMOUSE_CONFIG", "flags > environment > config.toml > defaults", "passwords", "https://link.tailmouse.com/", "Escape uses identifier 1", "Leash uses identifier 2"} {
			if !strings.Contains(text, required) {
				t.Fatalf("%q help missing %q", command, required)
			}
		}
		if strings.Contains(text, "Escape flags:") != (command == "escape" || command == "") ||
			strings.Contains(text, "Leash flags:") != (command == "leash" || command == "") {
			t.Fatal("help selected the wrong mode")
		}
		if command == "leash" && (!strings.Contains(text, "not native GUI") || !strings.Contains(text, "no shell expansion") ||
			!strings.Contains(text, "--no-password") || !strings.Contains(text, "host (default)") || !strings.Contains(text, "Obsolete for Leash") ||
			!strings.Contains(text, "tailmouse leash -- codex") || !strings.Contains(text, "AI CLI")) {
			t.Fatal("leash help omitted its authority or terminal boundary")
		}
	}
	if err := WriteHelp(brokenHelpWriter{}, ""); err == nil {
		t.Fatal("help output error was lost")
	}
}

type brokenHelpWriter struct{}

func (brokenHelpWriter) Write([]byte) (int, error) { return 0, errors.New("output unavailable") }

func TestSqueakSourceAndConfigCommandFlags(t *testing.T) {
	options, help, err := Resolve([]string{"escape", "--squeak"}, nil, t.TempDir())
	if err != nil || help || !options.Verbose || options.SourceOf("verbose") != Flag {
		t.Fatal("squeak did not preserve canonical verbose attribution")
	}
	options, help, err = Resolve([]string{"config", "path", "--config", "selected.toml"}, nil, "")
	if err != nil || help || options.ConfigPath != "selected.toml" || options.SourceOf("config") != Flag {
		t.Fatal("config path did not honor its explicit flag")
	}
	for _, args := range [][]string{{"config", "--help"}, {"config", "-h"}, {"config", "path", "--help"}} {
		if _, help, err := Resolve(args, nil, ""); err != nil || !help {
			t.Fatalf("help unavailable for %v", args)
		}
	}
}
