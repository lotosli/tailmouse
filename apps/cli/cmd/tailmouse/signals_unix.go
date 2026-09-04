//go:build darwin || linux

package main

import (
	"os"
	"syscall"
)

func processSignals() []os.Signal {
	// Notify turns a closed stdout pipe into a reported I/O failure so deferred
	// PTY and raw-terminal cleanup runs instead of abrupt process termination.
	return []os.Signal{os.Interrupt, syscall.SIGTERM, syscall.SIGHUP, syscall.SIGWINCH, syscall.SIGPIPE}
}

func shutdownSignal(value os.Signal) bool { return value == syscall.SIGTERM || value == syscall.SIGHUP }
