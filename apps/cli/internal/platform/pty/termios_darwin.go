package pty

import "golang.org/x/sys/unix"

const (
	readTermios  = unix.TIOCGETA
	writeTermios = unix.TIOCSETA
)
