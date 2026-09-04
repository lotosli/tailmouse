//go:build tailcatintegration && (darwin || linux)

package main

import (
	"encoding/json"
	"io"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// One aggregate budget covers ordinary and service-worker requests together.
// The origin owns only fixed build files, never invitation/session data.
func startupStaticHandler(t *testing.T, dist string) http.Handler {
	t.Helper()
	var manifest struct {
		Files map[string]json.RawMessage `json:"files"`
	}
	source, err := os.ReadFile(filepath.Join(dist, "web-manifest.json"))
	if err != nil || json.Unmarshal(source, &manifest) != nil || len(manifest.Files) == 0 {
		t.Fatal("startup acceptance requires a valid static build manifest")
	}
	manifest.Files["web-manifest.json"] = nil
	var mu sync.Mutex
	var next time.Time
	var wasmRequests, transferred int64
	t.Cleanup(func() {
		mu.Lock()
		defer mu.Unlock()
		t.Logf("static origin transferred %d bytes across page and worker requests; Wasm requests %d", transferred, wasmRequests)
	})
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		name := strings.TrimPrefix(r.URL.Path, "/")
		if name == "" {
			name = "index.html"
		}
		if _, ok := manifest.Files[name]; !ok || r.Method != http.MethodGet || r.URL.RawQuery != "" {
			http.NotFound(w, r)
			return
		}
		if strings.HasSuffix(name, ".wasm") {
			mu.Lock()
			wasmRequests++
			mu.Unlock()
		}
		file := name
		for _, encoding := range []struct{ token, suffix string }{{"br", ".br"}, {"gzip", ".gz"}} {
			if _, ok := manifest.Files[name+encoding.suffix]; ok && strings.Contains(r.Header.Get("Accept-Encoding"), encoding.token) {
				file += encoding.suffix
				w.Header().Set("Content-Encoding", encoding.token)
				w.Header().Set("Vary", "Accept-Encoding")
				break
			}
		}
		input, err := os.Open(filepath.Join(dist, file))
		if err != nil {
			http.Error(w, "Build file unavailable.", http.StatusInternalServerError)
			return
		}
		defer input.Close()
		w.Header().Set("Content-Type", mime.TypeByExtension(filepath.Ext(name)))
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("Cache-Control", "no-cache")
		if file != name {
			w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		}
		wait := func(duration time.Duration) bool {
			timer := time.NewTimer(duration)
			defer timer.Stop()
			select {
			case <-timer.C:
				return true
			case <-r.Context().Done():
				return false
			}
		}
		if !wait(60 * time.Millisecond) {
			return
		}
		buffer := make([]byte, 16<<10)
		for {
			n, readErr := input.Read(buffer)
			if n > 0 {
				mu.Lock()
				if now := time.Now(); next.Before(now) {
					next = now
				}
				next = next.Add(time.Duration(int64(n) * int64(time.Second) / (9_000_000 / 8)))
				deadline := next
				mu.Unlock()
				if !wait(time.Until(deadline)) {
					return
				}
				written, err := w.Write(buffer[:n])
				mu.Lock()
				transferred += int64(written)
				mu.Unlock()
				if err != nil {
					return
				}
				if err := http.NewResponseController(w).Flush(); err != nil {
					return
				}
			}
			if readErr != nil {
				if readErr != io.EOF {
					t.Error("startup static file read failed")
				}
				return
			}
		}
	})
}
