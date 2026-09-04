// Command archiveinfo inspects release archives without extracting their files.
package main

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"slices"
	"strings"
)

const maxBytes = 128 << 20
const maxFiles = 512

type fileInfo struct {
	Name   string `json:"name"`
	Bytes  int64  `json:"bytes"`
	SHA256 string `json:"sha256"`
}

func inspect(filename string) ([]fileInfo, error) {
	f, err := os.Open(filename)
	if err != nil {
		return nil, errors.New("archive is not readable")
	}
	defer f.Close()
	stat, err := f.Stat()
	if err != nil || !stat.Mode().IsRegular() || stat.Size() > maxBytes {
		return nil, errors.New("archive must be a bounded regular file")
	}
	var files []fileInfo
	var total int64
	seen := make(map[string]bool)
	add := func(name string, size int64, regular bool, reader io.Reader) error {
		if !regular || name == "." || name == ".." || len(name) == 0 || len(name) > 256 ||
			path.IsAbs(name) || path.Clean(name) != name || strings.HasPrefix(name, "../") ||
			strings.ContainsAny(name, "\\\x00\r\n\t:") || seen[name] || len(files) >= maxFiles ||
			size < 0 || size > maxBytes-total {
			return errors.New("archive contains an unsafe, duplicate or oversized entry")
		}
		hash := sha256.New()
		n, err := io.Copy(hash, io.LimitReader(reader, maxBytes-total+1))
		if err != nil || n != size || n > maxBytes-total {
			return errors.New("archive entry is corrupt or exceeds its declared bound")
		}
		total += n
		seen[name] = true
		files = append(files, fileInfo{Name: name, Bytes: n, SHA256: hex.EncodeToString(hash.Sum(nil))})
		return nil
	}
	if strings.HasSuffix(filename, ".zip") {
		archive, err := zip.NewReader(f, stat.Size())
		if err != nil || len(archive.File) > maxFiles {
			return nil, errors.New("invalid or oversized ZIP directory")
		}
		for _, entry := range archive.File {
			if entry.UncompressedSize64 > maxBytes {
				return nil, errors.New("ZIP entry exceeds its size bound")
			}
			reader, err := entry.Open()
			if err != nil {
				return nil, errors.New("ZIP entry cannot be opened")
			}
			err = add(entry.Name, int64(entry.UncompressedSize64), entry.Mode().IsRegular(), reader)
			closeErr := reader.Close()
			if err != nil {
				return nil, err
			}
			if closeErr != nil {
				return nil, errors.New("ZIP entry could not be closed")
			}
		}
	} else if strings.HasSuffix(filename, ".tar.gz") {
		compressed, err := gzip.NewReader(f)
		if err != nil {
			return nil, errors.New("invalid gzip header")
		}
		defer compressed.Close()
		bounded := &io.LimitedReader{R: compressed, N: maxBytes + 1}
		archive := tar.NewReader(bounded)
		for {
			entry, err := archive.Next()
			if errors.Is(err, io.EOF) {
				break
			}
			if err != nil {
				return nil, errors.New("invalid TAR entry")
			}
			// tar.Reader normalizes legacy NUL regular-file headers to TypeReg.
			regular := entry.Typeflag == tar.TypeReg
			if err := add(entry.Name, entry.Size, regular, archive); err != nil {
				return nil, err
			}
		}
		// Consume the gzip trailer to verify its checksum, and reject a second
		// nonempty archive hidden after TAR's end marker. Zero padding is legal.
		tail, err := io.ReadAll(io.LimitReader(bounded, 256<<10+1))
		if err != nil || bounded.N <= 0 || len(tail) > 256<<10 || len(bytes.Trim(tail, "\x00")) != 0 {
			return nil, errors.New("invalid or oversized TAR/gzip trailer")
		}
	} else {
		return nil, errors.New("unsupported release archive format")
	}
	if len(files) == 0 {
		return nil, errors.New("release archive contains no files")
	}
	slices.SortFunc(files, func(a, b fileInfo) int { return strings.Compare(a.Name, b.Name) })
	return files, nil
}

func run(args []string, out io.Writer) error {
	if len(args) != 1 {
		return errors.New("expected one release archive path")
	}
	files, err := inspect(args[0])
	if err != nil {
		return err
	}
	return json.NewEncoder(out).Encode(files)
}

func main() {
	if err := run(os.Args[1:], os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, "Archive inspection failed:", err)
		os.Exit(1)
	}
}
