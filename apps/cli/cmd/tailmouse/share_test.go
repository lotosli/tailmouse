package main

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
)

func TestResourceJSONErrorsAreRedactedAndStructured(t *testing.T) {
	for _, args := range [][]string{{"cli", "--json"}, {"receive", "--json", "/absent/private-receive"}} {
		var output, diagnostic bytes.Buffer
		code := run(t.Context(), nil, args, nil, t.TempDir(), &output, &diagnostic, startTailcat)
		if code == 0 {
			t.Fatal("invalid command accepted")
		}
		var event struct{ Event, Code string }
		if json.Unmarshal(output.Bytes(), &event) != nil || event.Event != "share.error" || event.Code == "" {
			t.Fatal("structured failure missing")
		}
		if strings.Contains(output.String()+diagnostic.String(), "private-receive") {
			t.Fatal("private path leaked")
		}
	}
}
