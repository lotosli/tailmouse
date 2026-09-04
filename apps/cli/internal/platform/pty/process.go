// Package pty owns native terminal and child-process resources.
package pty

// StartError exposes the PRD's startup code without disclosing command data.
type StartError struct {
	code  int
	cause error
}

func (err StartError) Error() string    { return "terminal process startup failed" }
func (err StartError) GoString() string { return err.Error() }
func (err StartError) Unwrap() error    { return err.cause }
func (err StartError) ExitCode() int    { return err.code }

// Result is a completed child outcome, not a TailMouse internal error.
type Result struct {
	ExitCode int
	Signal   int
}
