package config

import (
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

func TestDocumentedCLIExamples(t *testing.T) {
	for _, name := range []string{"README.md", "docs/custom-derp.md"} {
		t.Run(name, func(t *testing.T) {
			inShell, checked := false, 0
			for _, line := range strings.Split(readDocumentation(t, name), "\n") {
				if strings.HasPrefix(line, "```") {
					inShell = line == "```sh"
					continue
				}
				if !inShell || !strings.HasPrefix(line, "tailmouse ") {
					continue
				}
				// These examples deliberately contain only literal, unquoted words.
				// Reject shell syntax instead of pretending Fields is a shell parser.
				if strings.ContainsAny(line, "\"'`$\\|;&<>") {
					t.Fatal("documented example needs explicit shell-aware verification")
				}
				args := strings.Fields(line)[1:]
				options, help, err := Resolve(args, nil, t.TempDir())
				if err != nil || help != (args[len(args)-1] == "--help") {
					t.Fatalf("documented command %q: help=%v error=%v", line, help, err)
				}
				if !help {
					command := args[0]
					if command == "config" {
						command = "config path"
					}
					if options.Command != command {
						t.Fatalf("documented command selected %q, want %q", options.Command, command)
					}
					if command == "leash" {
						separator := slices.Index(args, "--")
						if separator < 0 || !slices.Equal(options.Leash.Argv, args[separator+1:]) {
							t.Fatal("documented Leash argv was not preserved")
						}
					}
				}
				checked++
			}
			if checked == 0 {
				t.Fatal("no documented CLI examples were checked")
			}
		})
	}
}

func TestDocumentedTOML(t *testing.T) {
	parts := strings.Split(readDocumentation(t, "docs/configuration.md"), "```toml\n")
	if len(parts) != 2 {
		t.Fatal("expected one complete TOML example")
	}
	contents, _, closed := strings.Cut(parts[1], "\n```")
	if !closed {
		t.Fatal("unterminated TOML example")
	}
	dir := t.TempDir()
	path := writeConfig(t, dir, contents)
	for _, command := range []string{"escape", "leash"} {
		args := []string{command, "--config", path}
		if command == "leash" {
			args = append(args, "--", "example-command")
		}
		options, help, err := Resolve(args, nil, dir)
		if err != nil || help {
			t.Fatalf("documented TOML for %s: %v", command, err)
		}
		wantTTL := 10 * time.Minute
		if command == "leash" {
			wantTTL = 0
		}
		if options.WebBaseURL != "https://web.example.invalid/" || options.SourceOf("web-base-url") != File ||
			options.TTL != wantTTL || options.SourceOf("ttl") != File ||
			len(options.Relay.Hosts) != 0 || options.Relay.MapURL != "" ||
			options.Relay.DERPPort != 443 || options.Relay.STUNPort != 3478 || options.Relay.RegionID != 900 ||
			options.Leash.ReconnectGrace != 30*time.Second || options.Leash.PostExitTTL != 0 || !options.Leash.PostExitHost ||
			options.Leash.ScrollbackBytes != 1<<20 || options.Leash.StartOn != "connect-or-enter" || !options.Leash.LocalInput {
			t.Fatal("documented configuration does not match its described settings")
		}
	}
}

func readDocumentation(t *testing.T, name string) string {
	t.Helper()
	contents, err := os.ReadFile(filepath.Join("..", "..", "..", "..", name))
	if err != nil {
		t.Fatal(err)
	}
	return string(contents)
}
