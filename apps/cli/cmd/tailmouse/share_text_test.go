package main

import (
	"context"
	"strings"
	"tailmouse/apps/cli/internal/share"
	"testing"
	"time"
)

func TestLocalTextComposerUpdatesTheSameLiveSession(t *testing.T) {
	host, _, err := share.NewHost(context.Background(), share.Options{TextEnabled: true, Text: "initial", Cwd: t.TempDir(), TTL: time.Minute}, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer host.Close()
	host.Ready()
	if !host.HasText() {
		t.Fatal("missing text resource")
	}
	var input shareTextInput
	var output strings.Builder
	for _, chunk := range []string{"first\r", "\nsecond\x7f!\r", "\x1b[D", "last\tline\r"} {
		if err := input.Feed(host, []byte(chunk), &output); err != nil {
			t.Fatal(err)
		}
	}
	if host.TextValue() != "last\tline" || strings.Count(output.String(), "Shared text updated.") != 3 {
		t.Fatal("text update or CRLF handling failed")
	}
	if err := input.Feed(host, []byte("\r"), &output); err != nil || host.TextValue() != "" {
		t.Fatal("empty text did not clear session")
	}
	if err := input.Feed(host, []byte(strings.Repeat("a", share.MaxText+1)), &output); err != nil {
		t.Fatal(err)
	}
	if len(input.data) != share.MaxText {
		t.Fatal("input buffer exceeded text limit")
	}
	if err := input.Feed(host, []byte("\r"), &output); err != nil {
		t.Fatal(err)
	}
	if err := host.ReplaceText("\x1b"); err == nil {
		t.Fatal("invalid text was accepted")
	}
	if err := input.Feed(host, []byte("x"), failingWriter{}); err == nil {
		t.Fatal("local output failure hidden")
	}
	host.Close()
	if err := host.ReplaceText("late"); err == nil {
		t.Fatal("closed host accepted text")
	}
}
