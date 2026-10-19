package share

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"hash"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"unicode"
	"unicode/utf8"

	"golang.org/x/text/unicode/norm"
)

var (
	ErrUploadName    = errors.New("UPLOAD_NAME_INVALID")
	ErrUploadLimit   = errors.New("UPLOAD_LIMIT")
	ErrUploadStorage = errors.New("UPLOAD_STORAGE")
	ErrUploadHash    = errors.New("UPLOAD_HASH_MISMATCH")
	ErrUploadClosed  = errors.New("UPLOAD_CLOSED")
)

type Receipt struct {
	Type   string `json:"type"`
	Upload string `json:"upload"`
	Name   string `json:"name"`
	Size   int64  `json:"size"`
	SHA256 string `json:"sha256"`
	Path   string `json:"path"`
}

type Receiver struct {
	ownership                             *os.File
	ownershipKey                          []byte
	stageID                               string
	mu                                    sync.Mutex
	root, stage                           *os.Root
	stageName                             string
	rootDirectory                         *os.File
	sessionDirectory                      *os.File
	maxFile, maxTotal, consumed, reserved int64
	maxFiles, attempts                    int
	closed                                bool
	active                                map[string]*Upload
	receipts                              map[string]ownedReceipt
	label                                 string
}
type ownedReceipt struct {
	owner   string
	receipt Receipt
	err     error
}
type Upload struct {
	temporary       string
	mu              sync.Mutex
	receiver        *Receiver
	file            *os.File
	hash            hash.Hash
	id, name, owner string
	size, received  int64
	closed          bool
	result          *Receipt
	resultErr       error
	cleaned         bool
}

func randomID() string {
	var b [16]byte
	_, err := rand.Read(b[:])
	if err != nil {
		panic("system randomness unavailable")
	}
	return hex.EncodeToString(b[:])
}

func SafeName(value string) (string, error) {
	if !utf8.ValidString(value) {
		return "", ErrUploadName
	}
	value = norm.NFC.String(value)
	if value == "" || len(value) > 180 || strings.HasPrefix(value, ".") || strings.ContainsAny(value, "/\\:") || strings.ContainsFunc(value, unicode.IsControl) || strings.TrimSpace(value) != value || strings.HasSuffix(value, ".") {
		return "", ErrUploadName
	}
	base := strings.ToUpper(strings.SplitN(value, ".", 2)[0])
	switch base {
	case "CON", "PRN", "AUX", "NUL", "CLOCK$":
		return "", ErrUploadName
	}
	if len(base) == 4 && (strings.HasPrefix(base, "COM") || strings.HasPrefix(base, "LPT")) && base[3] >= '0' && base[3] <= '9' {
		return "", ErrUploadName
	}
	// Encoded separators are rejected too; uploads never interpret URL escapes.
	lower := strings.ToLower(value)
	if strings.Contains(lower, "%2f") || strings.Contains(lower, "%5c") || strings.Contains(lower, "%00") {
		return "", ErrUploadName
	}
	return value, nil
}

func NewReceiver(directory, cwd string, maxFile, maxTotal int64, maxFiles int) (*Receiver, error) {
	absolute, err := filepath.Abs(directory)
	if err != nil {
		return nil, ErrUploadStorage
	}
	resolved, err := filepath.EvalSymlinks(absolute)
	if err != nil {
		return nil, ErrUploadStorage
	}
	home, _ := os.UserHomeDir()
	homeResolved, _ := filepath.EvalSymlinks(home)
	if filepath.Dir(resolved) == resolved || resolved == homeResolved || maxFile < 1 || maxTotal < maxFile || maxFiles < 1 {
		return nil, ErrConfig
	}
	root, err := os.OpenRoot(absolute)
	if err != nil {
		return nil, ErrUploadStorage
	}
	fail := func() (*Receiver, error) { _ = root.Close(); return nil, ErrUploadStorage }
	if err = root.Mkdir(".tailmouse-partials", 0700); err != nil && !errors.Is(err, os.ErrExist) {
		return fail()
	}
	info, err := root.Lstat(".tailmouse-partials")
	if err != nil || !info.IsDir() || info.Mode().Perm() != 0700 {
		return fail()
	}
	partials, err := root.OpenRoot(".tailmouse-partials")
	if err != nil {
		return fail()
	}
	defer partials.Close()
	key, err := partialKey(partials)
	if err != nil {
		return fail()
	}
	if err = cleanupPartials(partials, key); err != nil {
		return fail()
	}
	// A new random directory is the sole cleanup ownership boundary. Existing
	// directories are never recursively removed based only on their names.
	id := randomID()
	if err = partials.Mkdir(id, 0700); err != nil {
		return fail()
	}
	stageName := ".tailmouse-partials/" + id
	stage, err := partials.OpenRoot(id)
	if err != nil {
		_ = root.Remove(stageName)
		return fail()
	}
	rootDir, err := root.Open(".")
	if err != nil {
		_ = stage.Close()
		_ = root.Remove(stageName)
		return fail()
	}
	stageDir, err := stage.Open(".")
	if err != nil {
		_ = rootDir.Close()
		_ = stage.Close()
		_ = root.Remove(stageName)
		return fail()
	}
	ownership, err := ownStage(stage, key, id)
	if err != nil {
		_ = stageDir.Close()
		_ = rootDir.Close()
		_ = stage.Close()
		_ = root.Remove(stageName)
		return fail()
	}
	label := "uploads"
	if rel, e := filepath.Rel(cwd, absolute); e == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		label = filepath.ToSlash(rel)
	}
	return &Receiver{ownership: ownership, ownershipKey: key, stageID: id, root: root, stage: stage, stageName: stageName, rootDirectory: rootDir, sessionDirectory: stageDir, maxFile: maxFile, maxTotal: maxTotal, maxFiles: maxFiles, active: map[string]*Upload{}, receipts: map[string]ownedReceipt{}, label: label}, nil
}

func (r *Receiver) Begin(owner, name string, size int64) (*Upload, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed {
		return nil, ErrUploadClosed
	}
	if r.attempts >= r.maxFiles {
		return nil, ErrUploadLimit
	}
	r.attempts++
	name, err := SafeName(name)
	if err != nil {
		return nil, err
	}
	if size < 0 || size > r.maxFile || size > r.maxTotal-r.consumed-r.reserved || len(r.active) >= 2 {
		return nil, ErrUploadLimit
	}
	id := randomID()
	temporary := id + "-" + ownershipTag(r.ownershipKey, r.stageID, id) + ".part"
	file, err := r.stage.OpenFile(temporary, os.O_CREATE|os.O_EXCL|os.O_RDWR, 0600)
	if err != nil {
		return nil, ErrUploadStorage
	}
	u := &Upload{temporary: temporary, receiver: r, file: file, hash: sha256.New(), id: id, name: name, size: size, owner: owner}
	r.active[id] = u
	r.reserved += size
	return u, nil
}
func (u *Upload) ID() string { return u.id }
func (u *Upload) Write(data []byte) (int, error) {
	u.mu.Lock()
	defer u.mu.Unlock()
	if u.closed {
		return 0, ErrUploadClosed
	}
	r := u.receiver
	r.mu.Lock()
	if r.closed {
		r.mu.Unlock()
		return 0, ErrUploadClosed
	}
	available := r.maxTotal - r.consumed
	if int64(len(data)) > available || int64(len(data)) > u.size-u.received {
		// Invalid excess bytes still consume remaining traffic allowance.
		r.consumed += min(int64(len(data)), available)
		r.mu.Unlock()
		return 0, ErrUploadLimit
	}
	n, err := u.file.Write(data)
	if n > 0 {
		_, _ = u.hash.Write(data[:n])
		u.received += int64(n)
		r.consumed += int64(n)
		r.reserved -= int64(n)
	}
	r.mu.Unlock()
	if err != nil || n != len(data) {
		return n, ErrUploadStorage
	}
	return n, nil
}
func (u *Upload) Finish(ctx context.Context, digest string) (Receipt, error) {
	u.mu.Lock()
	defer u.mu.Unlock()
	if u.result != nil {
		return *u.result, u.resultErr
	}
	if u.closed {
		return Receipt{}, ErrUploadClosed
	}
	r := u.receiver
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed || ctx.Err() != nil {
		return Receipt{}, ErrUploadClosed
	}
	sum, err := hex.DecodeString(digest)
	if err != nil || len(sum) != 32 || digest != strings.ToLower(digest) || u.received != u.size || subtle.ConstantTimeCompare(sum, u.hash.Sum(nil)) != 1 {
		return Receipt{}, ErrUploadHash
	}
	if err = u.file.Sync(); err != nil {
		return Receipt{}, ErrUploadStorage
	}
	ext := filepath.Ext(u.name)
	stem := strings.TrimSuffix(u.name, ext)
	if len(ext) > 120 {
		stem, ext = u.name, ""
	}
	for len(stem)+len(ext)+13 > 180 {
		_, n := utf8.DecodeLastRuneInString(stem)
		stem = stem[:len(stem)-n]
	}
	name := stem + "-" + randomID()[:12] + ext
	if err = commitUpload(r, u.file, u.temporary, name); err != nil {
		return Receipt{}, ErrUploadStorage
	}
	// A durable commit is recorded before any reply can be lost. The receipt
	// survives disconnect and finish/status never writes another final file.
	result := Receipt{Type: "upload.completed", Upload: u.id, Name: name, Size: u.size, SHA256: digest, Path: filepath.ToSlash(filepath.Join(r.label, name))}
	u.result = &result
	delete(r.active, u.id)
	u.closed = true
	if err = r.rootDirectory.Sync(); err != nil {
		u.resultErr = ErrUploadStorage
	}
	closeErr := u.file.Close()
	removeErr := r.stage.Remove(u.temporary)
	u.cleaned = closeErr == nil && removeErr == nil
	if closeErr != nil || removeErr != nil {
		u.resultErr = ErrUploadStorage
	}
	r.receipts[u.id] = ownedReceipt{u.owner, result, u.resultErr}
	return result, u.resultErr
}
func (r *Receiver) Status(owner, id string) (Receipt, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	v, ok := r.receipts[id]
	if !ok || v.owner != owner {
		return Receipt{}, ErrUploadClosed
	}
	return v.receipt, v.err
}
func (u *Upload) Cancel() error {
	u.mu.Lock()
	defer u.mu.Unlock()
	if u.closed {
		return nil
	}
	u.closed = true
	r := u.receiver
	r.mu.Lock()
	r.reserved -= u.size - u.received
	delete(r.active, u.id)
	r.mu.Unlock()
	a, b := u.file.Close(), r.stage.Remove(u.temporary)
	if a != nil || b != nil {
		return ErrUploadStorage
	}
	return nil
}
func (r *Receiver) Close() error {
	r.mu.Lock()
	if r.closed {
		r.mu.Unlock()
		return nil
	}
	r.closed = true
	uploads := make([]*Upload, 0, len(r.active))
	for _, u := range r.active {
		uploads = append(uploads, u)
	}
	r.mu.Unlock()
	var err error
	for _, u := range uploads {
		err = errors.Join(err, u.Cancel())
	}
	err = errors.Join(err, r.stage.Remove(".owner"), r.sessionDirectory.Close(), r.rootDirectory.Close(), r.stage.Close(), r.root.Remove(r.stageName), r.ownership.Close(), r.root.Close())
	if err != nil {
		return ErrUploadStorage
	}
	return nil
}

var _ io.Writer = (*Upload)(nil)
