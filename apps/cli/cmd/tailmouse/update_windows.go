//go:build windows

package main

import (
	"errors"
	"os"
	"path/filepath"
)

func replaceExecutable(candidate, target string) (string, error) {
	backup := filepath.Join(filepath.Dir(candidate), "previous.exe")
	if err := os.Rename(target, backup); err != nil {
		return "", err
	}
	if err := os.Rename(candidate, target); err != nil {
		if restore := os.Rename(backup, target); restore != nil {
			return backup, errors.Join(err, restore)
		}
		return "", err
	}
	return backup, nil
}
