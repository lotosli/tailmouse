package main

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func updateArchive(t *testing.T, zipped bool, entry string) []byte {
	t.Helper()
	var buffer bytes.Buffer
	if zipped {
		writer := zip.NewWriter(&buffer)
		file, err := writer.Create(entry)
		if err != nil {
			t.Fatal(err)
		}
		_, _ = file.Write([]byte("new executable"))
		if err = writer.Close(); err != nil {
			t.Fatal(err)
		}
	} else {
		gzipWriter := gzip.NewWriter(&buffer)
		writer := tar.NewWriter(gzipWriter)
		if err := writer.WriteHeader(&tar.Header{Name: entry, Mode: 0755, Size: 14}); err != nil {
			t.Fatal(err)
		}
		_, _ = writer.Write([]byte("new executable"))
		_ = writer.Close()
		_ = gzipWriter.Close()
	}
	return buffer.Bytes()
}
func TestUpdatePreservesOldBinaryUntilVerified(t *testing.T) {
	for _, tc := range []struct {
		name, goos, mode string
		check            bool
		success          bool
	}{
		{"tar", "linux", "ok", false, true}, {"zip", "windows", "ok", false, true}, {"check", "linux", "ok", true, true}, {"same", "linux", "same", false, true},
		{"digest", "linux", "digest", false, false}, {"archive", "linux", "archive", false, false}, {"missing-binary", "linux", "entry", false, false}, {"http", "linux", "http", false, false}, {"json", "linux", "json", false, false}, {"tag", "linux", "tag", false, false}, {"missing-checksum", "linux", "sums", false, false}, {"duplicate-checksum", "linux", "duplicate", false, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			target := filepath.Join(dir, "tailmouse")
			_ = os.WriteFile(target, []byte("previous executable"), 0700)
			binary := "tailmouse"
			suffix := ".tar.gz"
			if tc.goos == "windows" {
				binary += ".exe"
				suffix = ".zip"
			}
			if tc.mode == "entry" {
				binary = "other"
			}
			archive := updateArchive(t, tc.goos == "windows", binary)
			if tc.mode == "archive" {
				archive = []byte("invalid")
			}
			digest := sha256.Sum256(archive)
			checksum := hex.EncodeToString(digest[:])
			if tc.mode == "digest" {
				checksum = strings.Repeat("0", 64)
			}
			name := "tailmouse_1.2.3_" + tc.goos + "_amd64" + suffix
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch {
				case r.URL.Path == "/latest":
					if tc.mode == "http" {
						http.Error(w, "missing", 404)
						return
					}
					if tc.mode == "json" {
						_, _ = io.WriteString(w, "invalid")
						return
					}
					tag := "v1.2.3"
					if tc.mode == "tag" {
						tag = "v../../escape"
					}
					_, _ = io.WriteString(w, `{"tag_name":"`+tag+`","draft":false}`)
				case strings.HasSuffix(r.URL.Path, "SHA256SUMS"):
					if tc.mode == "sums" {
						_, _ = io.WriteString(w, "not a checksum")
						return
					}
					line := checksum + "  " + name + "\n"
					if tc.mode == "duplicate" {
						line += line
					}
					_, _ = io.WriteString(w, line)
				default:
					_, _ = w.Write(archive)
				}
			}))
			defer server.Close()
			current := "old"
			if tc.mode == "same" {
				current = "1.2.3"
			}
			version, retained, err := updateExecutable(context.Background(), server.Client(), server.URL+"/latest", server.URL+"/", target, current, tc.goos, "amd64", tc.check)
			backupExpected := runtime.GOOS == "windows" && tc.success && !tc.check && tc.mode != "same"
			if (err == nil) != tc.success || (retained != "") != backupExpected {
				t.Fatalf("result %q %v", retained, err)
			}
			data, _ := os.ReadFile(target)
			expected := "previous executable"
			if tc.success && !tc.check && tc.mode != "same" {
				expected = "new executable"
			}
			if string(data) != expected {
				t.Fatal("unexpected replacement")
			}
			if tc.success && version != "1.2.3" {
				t.Fatal(version)
			}
			entries, _ := os.ReadDir(dir)
			expectedEntries := 1
			if retained != "" {
				expectedEntries++
				previous, err := os.ReadFile(retained)
				if err != nil || string(previous) != "previous executable" {
					t.Fatal("backup was not preserved")
				}
			}
			if len(entries) != expectedEntries {
				t.Fatal("staging files leaked")
			}
		})
	}
	if _, _, err := updateExecutable(context.Background(), http.DefaultClient, "invalid", "", "", "", "other", "386", false); err == nil {
		t.Fatal("unsupported platform")
	}
	if _, err := updateGet(context.Background(), http.DefaultClient, ":invalid"); err == nil {
		t.Fatal("invalid URL")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := updateGet(ctx, http.DefaultClient, "https://example.invalid"); err == nil {
		t.Fatal("canceled update")
	}
	var out, errout bytes.Buffer
	for _, args := range [][]string{{"--help"}, {"unexpected"}, {"a", "b"}} {
		code := runUpdate(ctx, args, &out, &errout)
		if len(args) == 1 && args[0] == "--help" && code != 0 {
			t.Fatal(code)
		}
		if args[0] != "--help" && code != 2 {
			t.Fatal(code)
		}
	}
	if code := runUpdate(ctx, []string{"--check"}, &out, &errout); code != 3 {
		t.Fatal(code)
	}
}

type wizardConsole struct {
	input   string
	output  strings.Builder
	failure bool
}

func (c *wizardConsole) ReadKey(ctx context.Context) (byte, error) {
	if ctx.Err() != nil {
		return 0, ctx.Err()
	}
	if len(c.input) == 0 {
		return 0, io.EOF
	}
	key := c.input[0]
	c.input = c.input[1:]
	return key, nil
}
func (c *wizardConsole) Write(_ context.Context, s string) error {
	if c.failure {
		return errors.New("write failed")
	}
	_, err := c.output.WriteString(s)
	return err
}
func (c *wizardConsole) Size() (int, int, error) { return 80, 24, nil }
func (c *wizardConsole) Close() error            { return nil }
func TestWizardChoosesExplicitResources(t *testing.T) {
	program := "sh"
	if runtime.GOOS == "windows" {
		program = "powershell.exe"
	}
	for _, tc := range []struct {
		input string
		want  []string
	}{
		{"1\r\r", []string{"web", "8080"}}, {"3\rmy file.zip\r", []string{"send", "my file.zip"}}, {"4\r\r", []string{"files", "."}}, {"5\rhello world\r", []string{"text", "hello world"}}, {"2\r\ry\r", []string{"cli", "--", program}}, {"7\r5173\r\ry\r", []string{"dev", "--web", "5173", "--", program}}, {"1\r8081\b0\r", []string{"web", "8080"}},
	} {
		console := &wizardConsole{input: tc.input}
		args, err := wizardArgs(context.Background(), console)
		if err != nil || strings.Join(args, "|") != strings.Join(tc.want, "|") {
			t.Fatal(args, err)
		}
	}
	for _, input := range []string{"q\r", "2\r\rn\r", "\x03", ""} {
		if _, err := wizardArgs(context.Background(), &wizardConsole{input: input}); !errors.Is(err, io.EOF) {
			t.Fatal(err)
		}
	}
	for _, input := range []string{"9\r", "1\r\x01", "1\r" + strings.Repeat("x", 4097), "1\r\xff\r"} {
		if _, err := wizardArgs(context.Background(), &wizardConsole{input: input}); err == nil {
			t.Fatal("invalid wizard input")
		}
	}
	if _, err := wizardArgs(context.Background(), &wizardConsole{failure: true}); err == nil {
		t.Fatal("output failure ignored")
	}
	dir := filepath.Join(t.TempDir(), "inbox")
	if _, err := wizardArgs(context.Background(), &wizardConsole{input: "6\r" + dir + "\ry\r"}); err != nil {
		t.Fatal(err)
	}
	if info, err := os.Stat(dir); err != nil || !info.IsDir() {
		t.Fatal("upload directory not created")
	}
	missing := filepath.Join(t.TempDir(), "inbox")
	if _, err := wizardArgs(context.Background(), &wizardConsole{input: "6\r" + missing + "\rn\r"}); !errors.Is(err, io.EOF) {
		t.Fatal(err)
	}
	if _, err := os.Stat(missing); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("directory created without consent")
	}
}
