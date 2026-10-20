//go:build !windows

package main

import "os"

func replaceExecutable(candidate, target string) (string, error) {
	return "", os.Rename(candidate, target)
}
