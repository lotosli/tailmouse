//go:build tailmouse_dependencies

// Package dependencies keeps accepted Go product dependencies visible to the
// module graph before every milestone has a concrete import. Delete each blank
// import once production code imports that module directly.
package dependencies

import (
	_ "github.com/BurntSushi/toml"
	_ "github.com/creack/pty"
	_ "golang.org/x/sys/unix"
	_ "golang.org/x/term"
)
