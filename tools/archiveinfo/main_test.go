package main

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

func fixture(t *testing.T, format string, names []string, link bool) string {
	t.Helper()
	var encoded bytes.Buffer
	if format == ".zip" {
		archive := zip.NewWriter(&encoded)
		for _, name := range names {
			header := &zip.FileHeader{Name: name, Method: zip.Store}
			header.SetMode(0o644)
			if link {
				header.SetMode(os.ModeSymlink | 0o777)
			}
			writer, err := archive.CreateHeader(header)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := writer.Write([]byte("synthetic release bytes")); err != nil {
				t.Fatal(err)
			}
		}
		if err := archive.Close(); err != nil {
			t.Fatal(err)
		}
	} else {
		compressed := gzip.NewWriter(&encoded)
		archive := tar.NewWriter(compressed)
		for _, name := range names {
			content := []byte("synthetic release bytes")
			header := &tar.Header{Name: name, Mode: 0o644, Size: int64(len(content))}
			if link {
				header.Typeflag, header.Linkname, header.Size = tar.TypeSymlink, "outside", 0
				content = nil
			}
			if err := archive.WriteHeader(header); err != nil {
				t.Fatal(err)
			}
			if _, err := archive.Write(content); err != nil {
				t.Fatal(err)
			}
		}
		if err := archive.Close(); err != nil {
			t.Fatal(err)
		}
		if err := compressed.Close(); err != nil {
			t.Fatal(err)
		}
	}
	filename := filepath.Join(t.TempDir(), "release"+format)
	if err := os.WriteFile(filename, encoded.Bytes(), 0o600); err != nil {
		t.Fatal(err)
	}
	return filename
}

func TestArchiveInventory(t *testing.T) {
	for _, format := range []string{".zip", ".tar.gz"} {
		t.Run(format, func(t *testing.T) {
			filename := fixture(t, format, []string{"tailmouse", "README.md"}, false)
			var out bytes.Buffer
			if err := run([]string{filename}, &out); err != nil {
				t.Fatal(err)
			}
			var files []fileInfo
			if err := json.Unmarshal(out.Bytes(), &files); err != nil {
				t.Fatal(err)
			}
			sum := sha256.Sum256([]byte("synthetic release bytes"))
			if len(files) != 2 || files[0].Name != "README.md" || files[1].Name != "tailmouse" ||
				files[0].Bytes != 23 || files[0].SHA256 != hex.EncodeToString(sum[:]) {
				t.Fatalf("unexpected inventory: %+v", files)
			}
			for _, names := range [][]string{{"../outside"}, {"/absolute"}, {"a/../b"}, {"a\\b"}, {"a\nb"}, {"C:drive"}, {"."}, {strings.Repeat("a", 257)}, {"same", "same"}, nil} {
				if _, err := inspect(fixture(t, format, names, false)); err == nil {
					t.Fatal("unsafe or empty archive accepted")
				}
			}
			if _, err := inspect(fixture(t, format, []string{"link"}, true)); err == nil {
				t.Fatal("symlink accepted")
			}
			data, err := os.ReadFile(filename)
			if err != nil {
				t.Fatal(err)
			}
			for _, corrupt := range [][]byte{[]byte("not an archive"), data[:len(data)-8]} {
				if err := os.WriteFile(filename, corrupt, 0o600); err != nil {
					t.Fatal(err)
				}
				if _, err := inspect(filename); err == nil {
					t.Fatal("corrupt archive accepted")
				}
			}
		})
	}
	if err := run(nil, &bytes.Buffer{}); err == nil {
		t.Fatal("missing argument accepted")
	}
	if _, err := inspect(filepath.Join(t.TempDir(), "missing.zip")); err == nil {
		t.Fatal("missing file accepted")
	}
	if _, err := inspect(t.TempDir()); err == nil {
		t.Fatal("directory accepted")
	}
	if _, err := inspect(fixture(t, ".unknown", []string{"README.md"}, false)); err == nil {
		t.Fatal("unknown archive format accepted")
	}
}

func TestArchiveIntegrityAndBounds(t *testing.T) {
	for _, format := range []string{".zip", ".tar.gz"} {
		filename := fixture(t, format, []string{"tailmouse"}, false)
		data, err := os.ReadFile(filename)
		if err != nil {
			t.Fatal(err)
		}
		if format == ".zip" {
			offset := bytes.Index(data, []byte("synthetic release bytes"))
			if offset < 0 {
				t.Fatal("fixture content is missing")
			}
			data[offset] ^= 1
		} else {
			data[len(data)-8] ^= 1 // Corrupt gzip CRC without truncating content.
		}
		if err := os.WriteFile(filename, data, 0o600); err != nil {
			t.Fatal(err)
		}
		if _, err := inspect(filename); err == nil {
			t.Fatal("checksum corruption accepted")
		}
		names := make([]string, maxFiles+1)
		for index := range names {
			names[index] = "file-" + strconv.Itoa(index)
		}
		if _, err := inspect(fixture(t, format, names, false)); err == nil {
			t.Fatal("excessive file count accepted")
		}
	}

	filename := fixture(t, ".tar.gz", []string{"tailmouse"}, false)
	encoded, err := os.ReadFile(filename)
	if err != nil {
		t.Fatal(err)
	}
	compressed, err := gzip.NewReader(bytes.NewReader(encoded))
	if err != nil {
		t.Fatal(err)
	}
	raw, err := io.ReadAll(compressed)
	if err != nil {
		t.Fatal(err)
	}
	if err := compressed.Close(); err != nil {
		t.Fatal(err)
	}
	for _, kind := range []byte{0, tar.TypeLink, tar.TypeSymlink} {
		modified := bytes.Clone(raw)
		modified[156] = kind
		for index := 148; index < 156; index++ {
			modified[index] = ' '
		}
		var checksum int
		for _, value := range modified[:512] {
			checksum += int(value)
		}
		copy(modified[148:156], fmt.Sprintf("%06o\x00 ", checksum))
		var result bytes.Buffer
		writer := gzip.NewWriter(&result)
		if _, err := writer.Write(modified); err != nil {
			t.Fatal(err)
		}
		if err := writer.Close(); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filename, result.Bytes(), 0o600); err != nil {
			t.Fatal(err)
		}
		_, err := inspect(filename)
		if (kind == 0) != (err == nil) {
			t.Fatal("legacy regular-file or hard/symbolic-link classification failed")
		}
	}
	var hidden bytes.Buffer
	writer := gzip.NewWriter(&hidden)
	if _, err := writer.Write(append(raw, []byte("hidden content")...)); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filename, hidden.Bytes(), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := inspect(filename); err == nil {
		t.Fatal("content hidden after TAR end accepted")
	}

	oversized := filepath.Join(t.TempDir(), "oversized.zip")
	file, err := os.Create(oversized)
	if err != nil {
		t.Fatal(err)
	}
	if err := file.Truncate(maxBytes + 1); err != nil {
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := inspect(oversized); err == nil {
		t.Fatal("oversized archive accepted")
	}
}
