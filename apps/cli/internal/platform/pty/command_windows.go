//go:build windows

package pty

import (
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"unicode/utf16"
	"unicode/utf8"

	"golang.org/x/sys/windows"

	"tailmouse/apps/cli/internal/leash"
)

// Prepare all strings before allocating a terminal or starting a child. Neither
// executable lookup nor the environment block may consult later host state.
func commandWindows(snapshot *leash.Command) (application, arguments *uint16, environment []uint16, directory *uint16, failure error) {
	argv, env, cwd := snapshot.Argv(), snapshot.Environment(), snapshot.Cwd()
	for _, values := range [][]string{argv, env, {cwd}} {
		for _, value := range values {
			if !utf8.ValidString(value) {
				return nil, nil, nil, nil, &StartError{code: 2, cause: leash.ErrCommand}
			}
		}
	}
	info, err := os.Stat(cwd)
	if err != nil {
		return nil, nil, nil, nil, &StartError{code: 7, cause: err}
	}
	if !info.IsDir() {
		return nil, nil, nil, nil, &StartError{code: 7, cause: windows.ERROR_DIRECTORY}
	}
	path, err := executableWindows(argv[0], cwd, env)
	if err != nil {
		return nil, nil, nil, nil, launchError(err)
	}
	application, err = windows.UTF16PtrFromString(path)
	if err != nil {
		return nil, nil, nil, nil, launchError(err)
	}
	line, err := windows.UTF16FromString(windows.ComposeCommandLine(argv))
	if err != nil {
		return nil, nil, nil, nil, launchError(err)
	}
	// CreateProcessW's limit includes the terminating NUL.
	if len(line) > 32767 {
		return nil, nil, nil, nil, launchError(windows.ERROR_FILENAME_EXCED_RANGE)
	}
	directory, err = windows.UTF16PtrFromString(cwd)
	if err != nil {
		return nil, nil, nil, nil, launchError(err)
	}
	slices.SortFunc(env, func(a, b string) int {
		return strings.Compare(strings.ToUpper(environmentName(a)), strings.ToUpper(environmentName(b)))
	})
	for _, value := range env {
		environment = append(environment, utf16.Encode([]rune(value))...)
		environment = append(environment, 0)
	}
	environment = append(environment, 0)
	return application, &line[0], environment, directory, nil
}

func environmentName(entry string) string {
	// Preserve inherited Windows per-drive entries such as =C:=C:\work.
	start := 0
	if strings.HasPrefix(entry, "=") {
		start = 1
	}
	if index := strings.IndexByte(entry[start:], '='); index >= 0 {
		return entry[:start+index]
	}
	return entry
}

func environmentValue(environment []string, name string) string {
	for _, entry := range environment {
		key := environmentName(entry)
		if strings.EqualFold(key, name) && len(entry) > len(key) {
			return entry[len(key)+1:]
		}
	}
	return ""
}

func executableWindows(name, cwd string, environment []string) (string, error) {
	extensions := environmentValue(environment, "PATHEXT")
	if extensions == "" {
		extensions = ".COM;.EXE;.BAT;.CMD"
	}
	suffixes := []string{}
	if filepath.Ext(name) != "" {
		suffixes = append(suffixes, "")
	}
	for _, extension := range strings.Split(extensions, ";") {
		if strings.HasPrefix(extension, ".") && !strings.ContainsAny(extension, `:/\`) {
			suffixes = append(suffixes, extension)
		}
	}
	directories := filepath.SplitList(environmentValue(environment, "PATH"))
	if strings.ContainsAny(name, `:/\`) {
		directories = []string{""}
	}
	var denied bool
	for _, directory := range directories {
		candidate := name
		if directory != "" {
			candidate = filepath.Join(directory, name)
		}
		candidate = storedWindowsPath(candidate, cwd, environment)
		for _, suffix := range suffixes {
			path := candidate + suffix
			info, err := os.Stat(path)
			if err == nil && !info.IsDir() {
				return path, nil
			}
			if errors.Is(err, os.ErrPermission) || (err == nil && info.IsDir()) {
				denied = true
			} else if err != nil && !errors.Is(err, os.ErrNotExist) {
				return "", err
			}
		}
	}
	if denied {
		return "", os.ErrPermission
	}
	return "", os.ErrNotExist
}

// Resolve Windows drive-relative and rooted paths against the captured cwd and
// inherited per-drive directories, never filepath.Abs's ambient process cwd.
func storedWindowsPath(name, cwd string, environment []string) string {
	if filepath.IsAbs(name) {
		return filepath.Clean(name)
	}
	volume := filepath.VolumeName(name)
	if volume == "" {
		if len(name) > 0 && os.IsPathSeparator(name[0]) {
			return filepath.VolumeName(cwd) + filepath.Clean(name)
		}
		return filepath.Join(cwd, name)
	}
	base := volume + `\`
	if strings.EqualFold(volume, filepath.VolumeName(cwd)) {
		base = cwd
	} else if stored := environmentValue(environment, "="+volume); filepath.IsAbs(stored) && strings.EqualFold(volume, filepath.VolumeName(stored)) {
		base = stored
	}
	return filepath.Join(base, name[len(volume):])
}
