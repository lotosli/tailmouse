package main

import (
	"archive/tar"
	"archive/zip"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"time"
)

var releaseTag = regexp.MustCompile(`^v[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$`)
var errUpdate = errors.New("update failed; the existing executable was preserved")

func runUpdate(ctx context.Context, args []string, stdout, stderr io.Writer) int {
	if len(args) > 1 || len(args) == 1 && args[0] != "--check" && args[0] != "--help" {
		_, _ = fmt.Fprintln(stderr, "Usage: tailmouse update [--check]")
		return 2
	}
	if len(args) == 1 && args[0] == "--help" {
		_, err := fmt.Fprintln(stdout, "tailmouse update [--check]\nDownload the latest official release, verify SHA-256 and replace this executable. Homebrew/Scoop installations should use their package manager.")
		if err != nil {
			return 6
		}
		return 0
	}
	target, err := os.Executable()
	if err != nil {
		_, _ = fmt.Fprintln(stderr, "Cannot locate this executable.")
		return 3
	}
	if strings.Contains(filepath.ToSlash(target), "/Cellar/") || strings.Contains(strings.ToLower(filepath.ToSlash(target)), "/scoop/apps/") {
		_, _ = fmt.Fprintln(stdout, "Use brew upgrade tailmouse or scoop update tailmouse for a package-manager installation.")
		return 0
	}
	client := &http.Client{Timeout: 45 * time.Second, CheckRedirect: func(req *http.Request, via []*http.Request) error {
		if len(via) >= 5 || req.URL.Scheme != "https" || req.URL.User != nil {
			return errUpdate
		}
		switch req.URL.Hostname() {
		case "github.com", "api.github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com":
			return nil
		}
		return errUpdate
	}}
	check := len(args) == 1
	ctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	version, retained, err := updateExecutable(ctx, client, "https://api.github.com/repos/lotosli/tailmouse/releases/latest", "https://github.com/lotosli/tailmouse/releases/download/", target, buildVersion, runtime.GOOS, runtime.GOARCH, check)
	if retained != "" {
		_, _ = fmt.Fprintln(stdout, "Previous executable retained at:", retained, "(remove after this process exits).")
	}
	if err != nil {
		_, _ = fmt.Fprintln(stderr, "Update could not finish. The existing executable was preserved or its recovery location is shown above. Check network access and write permissions, then retry.")
		return 3
	}
	verb := "Installed"
	if check {
		verb = "Latest available"
	}
	if version == buildVersion {
		verb = "Already current"
	}
	if _, err = fmt.Fprintln(stdout, verb+": "+version); err != nil {
		return 6
	}
	return 0
}
func updateGet(ctx context.Context, client *http.Client, url string) (io.ReadCloser, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, errUpdate
	}
	req.Header.Set("User-Agent", "TailMouse-updater")
	req.Header.Set("Accept", "application/vnd.github+json")
	response, err := client.Do(req)
	if err != nil {
		return nil, errUpdate
	}
	if response.StatusCode != http.StatusOK {
		_ = response.Body.Close()
		return nil, errUpdate
	}
	return response.Body, nil
}
func updateExecutable(ctx context.Context, client *http.Client, api, base, target, current, goos, goarch string, check bool) (version, retained string, failure error) {
	if goos != "darwin" && goos != "linux" && goos != "windows" || goarch != "amd64" && goarch != "arm64" {
		return "", "", errUpdate
	}
	body, err := updateGet(ctx, client, api)
	if err != nil {
		return "", "", err
	}
	var release struct {
		Tag   string `json:"tag_name"`
		Draft bool   `json:"draft"`
	}
	decoder := json.NewDecoder(io.LimitReader(body, 1<<20))
	err = decoder.Decode(&release)
	_ = body.Close()
	if err != nil || !releaseTag.MatchString(release.Tag) || len(release.Tag) > 64 || release.Draft {
		return "", "", errUpdate
	}
	version = strings.TrimPrefix(release.Tag, "v")
	if check || current == version {
		return version, "", nil
	}
	suffix := ".tar.gz"
	binary := "tailmouse"
	if goos == "windows" {
		suffix = ".zip"
		binary += ".exe"
	}
	name := "tailmouse_" + version + "_" + goos + "_" + goarch + suffix
	body, err = updateGet(ctx, client, base+release.Tag+"/SHA256SUMS")
	if err != nil {
		return "", "", err
	}
	sums, err := io.ReadAll(io.LimitReader(body, (1<<20)+1))
	_ = body.Close()
	if err != nil || len(sums) > 1<<20 {
		return "", "", errUpdate
	}
	expected := ""
	for _, line := range strings.Split(string(sums), "\n") {
		fields := strings.Fields(line)
		if len(fields) == 2 && fields[1] == name {
			if expected != "" {
				return "", "", errUpdate
			}
			expected = fields[0]
		}
	}
	digest, err := hex.DecodeString(expected)
	if err != nil || len(digest) != 32 {
		return "", "", errUpdate
	}
	info, err := os.Lstat(target)
	if err != nil || !info.Mode().IsRegular() {
		return "", "", errUpdate
	}
	dir, err := os.MkdirTemp(filepath.Dir(target), ".tailmouse-update-")
	if err != nil {
		return "", "", errUpdate
	}
	defer func() {
		if retained == "" {
			_ = os.RemoveAll(dir)
		}
	}()
	archive, err := os.Create(filepath.Join(dir, "archive"))
	if err != nil {
		return "", "", errUpdate
	}
	defer archive.Close()
	body, err = updateGet(ctx, client, base+release.Tag+"/"+name)
	if err != nil {
		return "", "", err
	}
	hash := sha256.New()
	n, err := io.Copy(io.MultiWriter(archive, hash), io.LimitReader(body, (96<<20)+1))
	_ = body.Close()
	if err != nil || n > 96<<20 || hex.EncodeToString(hash.Sum(nil)) != expected {
		return "", "", errUpdate
	}
	if _, err = archive.Seek(0, io.SeekStart); err != nil {
		return "", "", errUpdate
	}
	candidate := filepath.Join(dir, binary)
	out, err := os.OpenFile(candidate, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0700)
	if err != nil {
		return "", "", errUpdate
	}
	err = extractUpdate(archive, n, goos == "windows", binary, out)
	syncErr := out.Sync()
	closeErr := out.Close()
	if err != nil || syncErr != nil || closeErr != nil || ctx.Err() != nil {
		return "", "", errUpdate
	}
	retained, err = replaceExecutable(candidate, target)
	if err != nil {
		return "", retained, errUpdate
	}
	return version, retained, nil
}
func extractUpdate(file *os.File, size int64, zipped bool, name string, out io.Writer) error {
	var source io.Reader
	if zipped {
		reader, err := zip.NewReader(file, size)
		if err != nil || len(reader.File) > 64 {
			return errUpdate
		}
		var entry *zip.File
		for _, item := range reader.File {
			if item.Name == name {
				if entry != nil || !item.Mode().IsRegular() || item.UncompressedSize64 > 64<<20 {
					return errUpdate
				}
				entry = item
			}
		}
		if entry == nil {
			return errUpdate
		}
		stream, err := entry.Open()
		if err != nil {
			return errUpdate
		}
		defer stream.Close()
		source = stream
	} else {
		gz, err := gzip.NewReader(file)
		if err != nil {
			return errUpdate
		}
		defer gz.Close()
		reader := tar.NewReader(gz)
		for count := 0; count < 64; count++ {
			entry, err := reader.Next()
			if err != nil {
				return errUpdate
			}
			if entry.Name == name {
				if entry.Typeflag != tar.TypeReg || entry.Size < 1 || entry.Size > 64<<20 {
					return errUpdate
				}
				source = reader
				break
			}
		}
		if source == nil {
			return errUpdate
		}
	}
	n, err := io.Copy(out, io.LimitReader(source, (64<<20)+1))
	if err != nil || n < 1 || n > 64<<20 {
		return errUpdate
	}
	return nil
}
