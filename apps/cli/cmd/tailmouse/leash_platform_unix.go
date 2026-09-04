//go:build darwin || linux

package main

import (
	"fmt"
	"os"
	"syscall"

	"golang.org/x/sys/unix"
)

func leashResizeEvents(*leashLocalConsole) <-chan struct{} { return nil }

func leashResizeSignal(value os.Signal) bool { return value == syscall.SIGWINCH }

func leashSignalName(value int) string {
	name := unix.SignalName(syscall.Signal(value))
	if name == "" {
		return fmt.Sprintf("SIGNAL_%d", value)
	}
	return name
}
