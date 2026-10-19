package main

import (
	"context"
	"errors"
)

func openShareBrowser(context.Context, string) error {
	return errors.New("local resource workspace browser launch is unavailable on this platform")
}
