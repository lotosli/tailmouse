package share

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"strings"
	"sync"
	"unicode"
	"unicode/utf8"
)

var ErrFile = errors.New("FILE_UNAVAILABLE")
var ErrTransferLimit = errors.New("TRANSFER_LIMIT")

type FileEntry struct {
	Name string `json:"name"`
	Path string `json:"path"`
	Dir  bool   `json:"dir"`
	Size int64  `json:"size"`
}
type FileList struct {
	Type    string      `json:"type"`
	Path    string      `json:"path"`
	Entries []FileEntry `json:"entries"`
	Next    int         `json:"next"`
	More    bool        `json:"more"`
}
type FileRequest struct {
	Type   string `json:"type"`
	Path   string `json:"path"`
	Offset int    `json:"offset,omitempty"`
}
type FileOffer struct {
	root               *os.Root
	single             string
	mu                 sync.Mutex
	maxFile, remaining int64
	attempts, active   int
}

func safeOfferPath(value string, root bool) bool {
	if root && value == "" {
		return true
	}
	if len(value) > 1024 || !utf8.ValidString(value) || !fs.ValidPath(value) || strings.ContainsAny(value, "\\:") {
		return false
	}
	for _, part := range strings.Split(value, "/") {
		if len(part) > 180 || strings.HasPrefix(part, ".") || strings.ContainsFunc(part, unicode.IsControl) {
			return false
		}
	}
	return true
}
func NewFileOffer(target string, single bool, maxFile, maxTotal int64, maxFiles int) (*FileOffer, error) {
	if maxFile < 1 || maxTotal < maxFile || maxFiles < 1 {
		return nil, ErrConfig
	}
	directory, name := target, ""
	if single {
		directory, name = filepath.Dir(target), filepath.Base(target)
		if !safeOfferPath(name, false) {
			return nil, ErrFile
		}
	}
	root, err := os.OpenRoot(directory)
	if err != nil {
		return nil, ErrFile
	}
	o := &FileOffer{root: root, single: name, maxFile: maxFile, remaining: maxTotal, attempts: maxFiles}
	if single {
		file, err := o.open(name)
		if err != nil {
			_ = root.Close()
			return nil, err
		}
		_ = file.Close()
	}
	return o, nil
}
func (o *FileOffer) Close() error { return o.root.Close() }
func (o *FileOffer) open(name string) (*os.File, error) {
	if !safeOfferPath(name, false) || o.single != "" && name != o.single {
		return nil, ErrFile
	}
	// Lstat rejects links before OpenRoot's independent confinement check.
	info, err := o.root.Lstat(name)
	if err != nil || !info.Mode().IsRegular() {
		return nil, ErrFile
	}
	file, err := openOfferedFile(o.root, name)
	if err != nil {
		return nil, ErrFile
	}
	info, err = file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() < 0 || info.Size() > o.maxFile {
		_ = file.Close()
		return nil, ErrFile
	}
	return file, nil
}
func (o *FileOffer) List(name string, offset int) (FileList, error) {
	result := FileList{Type: "files.list", Path: name, Entries: []FileEntry{}}
	if !safeOfferPath(name, true) || offset < 0 || offset > 10000 {
		return result, ErrFile
	}
	if o.single != "" {
		if name != "" || offset != 0 {
			return result, ErrFile
		}
		file, err := o.open(o.single)
		if err != nil {
			return result, err
		}
		defer file.Close()
		info, err := file.Stat()
		if err != nil {
			return result, ErrFile
		}
		result.Entries = append(result.Entries, FileEntry{o.single, o.single, false, info.Size()})
		return result, nil
	}
	dir := name
	if dir == "" {
		dir = "."
	}
	file, err := o.root.Open(dir)
	if err != nil {
		return result, ErrFile
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.IsDir() {
		return result, ErrFile
	}
	for skipped := 0; skipped < offset; {
		count := min(offset-skipped, 40)
		entries, e := file.ReadDir(count)
		skipped += len(entries)
		if e != nil {
			if e == io.EOF {
				return result, nil
			}
			return result, ErrFile
		}
	}
	entries, err := file.ReadDir(41)
	if err != nil && err != io.EOF {
		return result, ErrFile
	}
	result.More = len(entries) > 40 && offset+40 < 10000
	result.Next = offset + min(40, len(entries))
	for _, entry := range entries[:min(40, len(entries))] {
		rel := entry.Name()
		if name != "" {
			rel = name + "/" + rel
		}
		if !safeOfferPath(rel, false) || entry.Type()&os.ModeSymlink != 0 {
			continue
		}
		info, err := entry.Info()
		if err != nil || !info.IsDir() && !info.Mode().IsRegular() {
			continue
		}
		if info.Mode().IsRegular() && info.Size() > o.maxFile {
			continue
		}
		result.Entries = append(result.Entries, FileEntry{entry.Name(), rel, info.IsDir(), info.Size()})
	}
	return result, nil
}
func (o *FileOffer) reserve(size int64) bool {
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.active >= 2 || o.attempts <= 0 || size > o.remaining {
		return false
	}
	o.active++
	o.attempts--
	o.remaining -= size
	return true
}
func (o *FileOffer) Serve(ctx context.Context, stream Stream) {
	f, err := ReadFrame(stream)
	if err != nil {
		return
	}
	var request FileRequest
	if Decode(f, &request) != nil {
		_ = sendError(stream, "BAD_FRAME")
		return
	}
	if request.Type == "files.list" {
		list, err := o.List(request.Path, request.Offset)
		if err != nil {
			_ = sendError(stream, err.Error())
			return
		}
		_ = WriteJSON(stream, list)
		return
	}
	if request.Type != "download.begin" || request.Offset != 0 {
		_ = sendError(stream, "BAD_FRAME")
		return
	}
	file, err := o.open(request.Path)
	if err != nil {
		_ = sendError(stream, err.Error())
		return
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		_ = sendError(stream, "FILE_UNAVAILABLE")
		return
	}
	if !o.reserve(info.Size()) {
		_ = sendError(stream, "TRANSFER_LIMIT")
		return
	}
	defer func() { o.mu.Lock(); o.active--; o.mu.Unlock() }()
	if WriteJSON(stream, struct {
		Type string `json:"type"`
		Name string `json:"name"`
		Size int64  `json:"size"`
	}{"download.ready", path.Base(request.Path), info.Size()}) != nil {
		return
	}
	hash := sha256.New()
	remaining := info.Size()
	buffer := make([]byte, ChunkSize)
	for remaining > 0 {
		if ctx.Err() != nil {
			return
		}
		n, err := io.ReadFull(file, buffer[:min(int64(len(buffer)), remaining)])
		if err != nil {
			_ = sendError(stream, "FILE_UNAVAILABLE")
			return
		}
		_, _ = hash.Write(buffer[:n])
		if WriteFrame(stream, DataFrame, buffer[:n]) != nil {
			return
		}
		remaining -= int64(n)
	}
	after, err := file.Stat()
	if err != nil || after.Size() != info.Size() || !after.ModTime().Equal(info.ModTime()) || ctx.Err() != nil {
		_ = sendError(stream, "FILE_UNAVAILABLE")
		return
	}
	if WriteFrame(stream, EndFrame, nil) != nil {
		return
	}
	_ = WriteJSON(stream, struct {
		Type   string `json:"type"`
		Size   int64  `json:"size"`
		SHA256 string `json:"sha256"`
	}{"download.completed", info.Size(), hex.EncodeToString(hash.Sum(nil))})
}
