package pty

import "golang.org/x/sys/unix"

const (
	readTermios  = unix.TCGETS
	writeTermios = unix.TCSETS
)
