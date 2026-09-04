//go:build windows

package main

import (
	"fmt"
	"os"
)

func leashResizeEvents(console *leashLocalConsole) <-chan struct{} { return console.resized }

func leashResizeSignal(os.Signal) bool { return false }

func leashSignalName(value int) string { return fmt.Sprintf("SIGNAL_%d", value) }
