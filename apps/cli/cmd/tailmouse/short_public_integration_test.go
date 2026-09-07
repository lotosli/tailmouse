//go:build tailcatintegration && darwin

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	nativepty "github.com/creack/pty"
)

// Explicit post-deployment acceptance only. Never selected by the hermetic gate.
// Run with TAILMOUSE_PUBLIC_SHORT_ACCEPTANCE=1 and
// -tags=tailcatintegration -run=^TestOfficialShortLeashBrowser$ from a process
// without a controlling terminal, so credentials cannot escape the owned PTY.
func TestOfficialShortLeashBrowser(t *testing.T) {
	if os.Getenv("TAILMOUSE_PUBLIC_SHORT_ACCEPTANCE") != "1" || flag.Lookup("test.run").Value.String() != "^TestOfficialShortLeashBrowser$" {
		t.Skip("requires explicit post-deployment opt-in and exact public-short test selector")
	}
	if terminal, err := os.OpenFile("/dev/tty", os.O_RDWR, 0); err == nil {
		terminal.Close()
		t.Fatal("public short acceptance requires a process without a controlling terminal")
	}
	ctx, cancel := context.WithTimeout(t.Context(), 3*time.Minute)
	defer cancel()
	_, source, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("cannot locate public short acceptance probe")
	}
	node, err := exec.LookPath("node")
	if err != nil {
		t.Fatal("Node is required for public short acceptance")
	}
	root := filepath.Clean(filepath.Join(filepath.Dir(source), "../../../.."))
	directory := t.TempDir()
	terminal, input, err := nativepty.Open()
	if err != nil {
		t.Fatal("cannot create the owned credential terminal")
	}
	t.Cleanup(func() { terminal.Close(); input.Close() })
	reader, output, err := os.Pipe()
	if err != nil {
		t.Fatal("cannot create owned output capture")
	}
	t.Cleanup(func() { reader.Close(); output.Close() })
	capture := &publicShortCapture{ready: make(chan struct{}, 1)}
	t.Cleanup(capture.erase)
	outputDone := make(chan error, 1)
	go func() {
		_, err := io.CopyN(capture, reader, 128<<10)
		if errors.Is(err, io.EOF) {
			err = nil
		} else if err == nil {
			err = errors.New("public short output exceeded its bound")
		}
		outputDone <- err
	}()
	args := []string{"leash", "--web-base-url=https://link.tailmouse.com/", "--ttl=3m", "--kill-on-expire", "--start-on=connect", "--post-exit-ttl=3s", "--cwd=" + directory, "--title=Public short zsh acceptance", "--", "/bin/zsh", "-f", "-i"}
	environment := []string{"PATH=/usr/bin:/bin", "HOME=" + directory, "ZDOTDIR=" + directory, "HISTFILE=/dev/null", "TERM=xterm-256color", "LC_ALL=en_US.UTF-8", "PS1=tailmouse-public> "}
	var diagnostics bytes.Buffer
	done := make(chan int, 1)
	go func() {
		code := runWithSignals(ctx, input, args, environment, directory, output, &diagnostics, startTailcat, nil)
		output.Close()
		done <- code
	}()
	finished := false
	t.Cleanup(func() {
		cancel()
		joined := finished
		if !finished {
			select {
			case <-done:
				joined = true
			case <-time.After(25 * time.Second):
				t.Error("public short Host cleanup exceeded its bound")
			}
		}
		select {
		case err := <-outputDone:
			if err != nil {
				t.Error("public short output capture failed")
			}
		case <-time.After(time.Second):
			reader.Close()
			<-outputDone
			t.Error("public short output capture did not finish")
		}
		if joined {
			clear(diagnostics.Bytes())
			diagnostics.Reset()
		}
	})
	select {
	case <-capture.ready:
	case <-done:
		finished = true
		t.Fatal("public short Host exited before presenting its invitation")
	case <-ctx.Done():
		t.Fatal("public short invitation deadline exceeded")
	}
	presentation := capture.snapshot()
	url, bitmap, err := parsePublicShortPresentation(presentation)
	clear(presentation)
	if err != nil {
		t.Fatal("public short presentation was not one six-character URL and a 37 by 19 QR")
	}
	accessCode := readBrowserIntegrationAccessCode(t, ctx, terminal)
	request, err := json.Marshal(struct {
		URL        string   `json:"url"`
		Bitmap     [][]bool `json:"bitmap"`
		AccessCode string   `json:"accessCode"`
	}{url, bitmap, string(accessCode[:])})
	clear(accessCode[:])
	if err != nil {
		t.Fatal("public browser input could not be encoded")
	}
	defer clear(request)
	command := exec.CommandContext(ctx, node, filepath.Join(filepath.Dir(source), "short_public_browser_test.mjs"))
	command.Dir, command.Stdin, command.WaitDelay = root, bytes.NewReader(request), 3*time.Second
	var result bytes.Buffer
	command.Stdout, command.Stderr = &result, &result
	if command.Run() != nil || result.String() != "PUBLIC_SHORT_ACCEPTANCE_PASSED\n" {
		message := "public short browser acceptance failed; private probe output discarded"
		if regexp.MustCompile(`^Public short acceptance failed at (input|browser-launch|compact-qr|protected-public-connect|zsh-input-output|disconnect|fresh-stream-reconnect|host-end|host-end-deletion)\.\n$`).Match(result.Bytes()) {
			message = strings.TrimSpace(result.String())
		}
		clear(result.Bytes())
		t.Fatal(message)
	}
	select {
	case code := <-done:
		finished = true
		if code != 19 || strings.Contains(diagnostics.String(), "short_invitation_delete") {
			t.Fatal("public short Host did not preserve shell exit and successful cleanup")
		}
	case <-ctx.Done():
		t.Fatal("public short Host did not finish after browser acceptance")
	}
	t.Log("public protected short URL, 37x19 QR decode, zsh I/O, same-PID reconnect and Host-end deletion verified")
}

type publicShortCapture struct {
	mu    sync.Mutex
	data  bytes.Buffer
	ready chan struct{}
}

func (capture *publicShortCapture) Write(data []byte) (int, error) {
	capture.mu.Lock()
	defer capture.mu.Unlock()
	count, err := capture.data.Write(data)
	if regexp.MustCompile(`(?m)^Open: https://link\.tailmouse\.com/[0-9A-Za-z]{6}\n`).Match(capture.data.Bytes()) {
		select {
		case capture.ready <- struct{}{}:
		default:
		}
	}
	return count, err
}

func (capture *publicShortCapture) snapshot() []byte {
	capture.mu.Lock()
	defer capture.mu.Unlock()
	return bytes.Clone(capture.data.Bytes())
}

func (capture *publicShortCapture) erase() {
	capture.mu.Lock()
	defer capture.mu.Unlock()
	clear(capture.data.Bytes())
	capture.data.Reset()
}

func parsePublicShortPresentation(data []byte) (string, [][]bool, error) {
	failure := errors.New("invalid public short presentation")
	urls := regexp.MustCompile(`(?m)^Open: (https://link\.tailmouse\.com/[0-9A-Za-z]{6})\n`).FindAllSubmatch(data, -1)
	if len(urls) != 1 || bytes.Contains(data, []byte("#/v1/")) {
		return "", nil, failure
	}
	var bitmap [][]bool
	for _, line := range strings.Split(string(data), "\n") {
		if !strings.HasPrefix(line, "\x1b[30;47m") {
			continue
		}
		if !strings.HasSuffix(line, "\x1b[0m") {
			return "", nil, failure
		}
		line = strings.TrimSuffix(strings.TrimPrefix(line, "\x1b[30;47m"), "\x1b[0m")
		top, bottom := make([]bool, 0, 37), make([]bool, 0, 37)
		for _, cell := range line {
			if !strings.ContainsRune(" ▀▄█", cell) {
				return "", nil, failure
			}
			top = append(top, cell == '▀' || cell == '█')
			bottom = append(bottom, cell == '▄' || cell == '█')
		}
		if len(top) != 37 {
			return "", nil, failure
		}
		bitmap = append(bitmap, top, bottom)
	}
	if len(bitmap) != 38 {
		return "", nil, failure
	}
	for _, dark := range bitmap[37] {
		if dark {
			return "", nil, failure
		}
	}
	return string(urls[0][1]), bitmap[:37], nil
}

func TestPublicShortPresentationCapture(t *testing.T) {
	valid := strings.Repeat("\x1b[30;47m"+strings.Repeat(" ", 37)+"\x1b[0m\n", 19) + "\nOpen: https://link.tailmouse.com/T6wxZ8\n"
	capture := &publicShortCapture{ready: make(chan struct{}, 1)}
	defer capture.erase()
	if _, err := capture.Write([]byte(strings.TrimSuffix(valid, "\n"))); err != nil {
		t.Fatal(err)
	}
	select {
	case <-capture.ready:
		t.Fatal("partial invitation line became ready")
	default:
	}
	if _, err := capture.Write([]byte("\n")); err != nil {
		t.Fatal(err)
	}
	select {
	case <-capture.ready:
	default:
		t.Fatal("complete synthetic presentation did not become ready")
	}
	url, bitmap, err := parsePublicShortPresentation(capture.snapshot())
	if err != nil || url != "https://link.tailmouse.com/T6wxZ8" || len(bitmap) != 37 {
		t.Fatal("synthetic compact presentation was not parsed")
	}
	for _, invalid := range []string{"", valid + "Open: https://link.tailmouse.com/T6wxZ8\n", valid + "#/v1/synthetic", strings.Replace(valid, "T6wxZ8", "short", 1), strings.Replace(valid, "\x1b[0m", "", 1), strings.Replace(valid, " ", "x", 1), strings.Replace(valid, strings.Repeat(" ", 37), strings.Repeat(" ", 36), 1), strings.Replace(valid, "\x1b[30;47m", "", 1)} {
		if _, _, err := parsePublicShortPresentation([]byte(invalid)); err == nil {
			t.Fatal("malformed synthetic presentation was accepted")
		}
	}
}
