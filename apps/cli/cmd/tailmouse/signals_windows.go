//go:build windows

package main

import (
	"os"
	"syscall"
)

func processSignals() []os.Signal         { return []os.Signal{os.Interrupt, syscall.SIGTERM} }
func shutdownSignal(value os.Signal) bool { return value == syscall.SIGTERM }
