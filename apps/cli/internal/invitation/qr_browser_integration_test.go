//go:build tailcatintegration && darwin

package invitation

import (
	"bytes"
	"context"
	"encoding/json"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestQRBrowserDecode(t *testing.T) {
	_, source, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("cannot locate QR acceptance probe")
	}
	root := filepath.Join(filepath.Dir(source), "..", "..", "..", "..")
	fixtures := []struct {
		Source string   `json:"source"`
		Bitmap [][]bool `json:"bitmap"`
	}{}
	for _, value := range []string{
		"https://link.tailmouse.com/T6wxZ8",
		string(testInvitation(t, ModeLeash).url),
		string(testInvitation(t, ModeLeash).url),
		"https://example.invalid/#/v1/" + strings.Repeat("a", MaxInvitationBytes-1-len("https://example.invalid/#/v1/")),
	} {
		bitmap, err := qrBitmap([]byte(value))
		if err != nil {
			t.Fatal("synthetic QR encoding failed")
		}
		var rendered bytes.Buffer
		writeTerminalQR(&rendered, addQuietZone(bitmap))
		decoded := decodeTerminalBitmap(t, rendered.String())
		fixtures = append(fixtures, struct {
			Source string   `json:"source"`
			Bitmap [][]bool `json:"bitmap"`
		}{value, decoded})
	}
	input, err := json.Marshal(fixtures)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, "node", filepath.Join(root, "tests", "integration", "invitation", "qr.mjs"))
	command.Dir, command.Stdin = root, bytes.NewReader(input)
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("native browser QR decoding failed: %v; %s", err, output)
	}
	if string(output) != "QR_DECODE_PASSED 4\n" {
		t.Fatal("QR probe did not verify every synthetic fixture")
	}
}
