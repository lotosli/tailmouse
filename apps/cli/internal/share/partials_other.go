//go:build !darwin && !linux

package share

import "os"

func lockPartial(*os.File) (bool, error) { return false, ErrUploadStorage }
