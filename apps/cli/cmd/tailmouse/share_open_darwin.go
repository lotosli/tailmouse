package main

import (
	"context"
	"os/exec"
	"strings"
)

func openShareBrowser(ctx context.Context, address string) error {
	command := exec.CommandContext(ctx, "/usr/bin/osascript", "-")
	command.Stdin = strings.NewReader("open location \"" + strings.ReplaceAll(strings.ReplaceAll(address, "\\", "\\\\"), "\"", "\\\"") + "\"\n")
	return command.Run()
}
