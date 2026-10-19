//go:build tailcatintegration && (darwin || linux)

package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
	"tailmouse/apps/cli/internal/share"
	tailcattransport "tailmouse/apps/cli/internal/transport/tailcat"
)

func TestHermeticResourceWorkspace(t *testing.T)    { resourceWorkspace(t, false) }
func TestHermeticResourceSingleOrigin(t *testing.T) { resourceWorkspace(t, true) }
func resourceWorkspace(t *testing.T, singleOrigin bool) {
	_, source, _, _ := runtime.Caller(0)
	root := filepath.Clean(filepath.Join(filepath.Dir(source), "../../../.."))
	dist := filepath.Join(root, "apps/web/dist")
	if _, e := os.Stat(filepath.Join(dist, ".tailmouse/bridge.html")); e != nil {
		t.Fatal("resource Web build is required")
	}
	var mutations atomic.Int64
	app := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/ws":
			c, e := websocket.Accept(w, r, &websocket.AcceptOptions{OriginPatterns: []string{r.Host}})
			if e != nil {
				return
			}
			defer c.CloseNow()
			for {
				kind, b, e := c.Read(r.Context())
				if e != nil {
					return
				}
				if c.Write(r.Context(), kind, b) != nil {
					return
				}
			}
		case "/write":
			mutations.Add(1)
			w.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(w, `{"saved":true}`)
		case "/app.js":
			w.Header().Set("Content-Type", "text/javascript")
			_, _ = io.WriteString(w, `document.querySelector('#write').onclick=async()=>{await fetch('/write',{method:'POST',body:'one'});document.querySelector('#result').textContent='Saved once'};try{void parent.parent.document.body;document.querySelector('#isolation').textContent='ISOLATION FAILED'}catch{document.querySelector('#isolation').textContent='Preview isolated'};const socket=new WebSocket(location.origin.replace('http','ws')+'/ws');socket.onopen=()=>socket.send('hello');socket.onmessage=e=>document.querySelector('#socket').textContent='Socket '+e.data;`)
		default:
			w.Header().Set("Content-Type", "text/html")
			_, _ = io.WriteString(w, `<!doctype html><html><body><h1>Shared application</h1><button id="write">Save once</button><p id="result"></p><p id="isolation"></p><p id="socket"></p><script src="/app.js"></script></body></html>`)
		}
	}))
	defer app.Close()
	fixtureRoot := t.TempDir()
	fixtureScript := `document.querySelector('#hmr').textContent='Vite initial';
 document.querySelector('#write').onclick=async()=>{await fetch('/write',{method:'POST',body:'one'});document.querySelector('#result').textContent='Saved once'};
 try{void parent.parent.document.body;document.querySelector('#isolation').textContent='ISOLATION FAILED'}catch{document.querySelector('#isolation').textContent='Preview isolated'};
 const socket=new WebSocket(location.origin.replace('http','ws')+'/ws');socket.onopen=()=>socket.send('hello');socket.onmessage=e=>document.querySelector('#socket').textContent='Socket '+e.data;
 if(import.meta.hot){import.meta.hot.accept();import.meta.hot.dispose(()=>socket.close())}`
	fixtureHTML := `<!doctype html><html><body><h1>Shared application</h1><button id="write">Save once</button><p id="result"></p><p id="isolation"></p><p id="socket"></p><p id="hmr"></p><script type="module" src="/app.js"></script></body></html>`
	for name, value := range map[string]string{"index.html": fixtureHTML, "app.js": fixtureScript} {
		if err := os.WriteFile(filepath.Join(fixtureRoot, name), []byte(value), 0600); err != nil {
			t.Fatal(err)
		}
	}
	fixture := exec.CommandContext(t.Context(), "node", filepath.Join(root, "tests/integration/tailcat/resource-app.mjs"))
	fixtureInput, _ := json.Marshal(map[string]string{"root": fixtureRoot, "target": app.URL})
	fixture.Stdin = bytes.NewReader(fixtureInput)
	fixture.WaitDelay = time.Second
	stdout, err := fixture.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err = fixture.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = fixture.Process.Kill(); _ = fixture.Wait() }()
	fixtureAddress := make(chan string, 1)
	go func() {
		scanner := bufio.NewScanner(stdout)
		var reply struct {
			URL string `json:"url"`
		}
		if scanner.Scan() {
			_ = json.Unmarshal(scanner.Bytes(), &reply)
		}
		fixtureAddress <- reply.URL
	}()
	var appURL string
	select {
	case appURL = <-fixtureAddress:
		if !strings.HasPrefix(appURL, "http://127.0.0.1:") {
			t.Fatal("Vite fixture did not start")
		}
	case <-time.After(10 * time.Second):
		t.Fatal("Vite fixture startup deadline")
	}
	var host *share.Host
	static := http.FileServer(http.Dir(dist))
	web := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		if r.URL.Path == "/__test/hmr" && r.Method == "POST" {
			if err := os.WriteFile(filepath.Join(fixtureRoot, "app.js"), []byte(strings.ReplaceAll(fixtureScript, "Vite initial", "Vite updated")), 0600); err != nil {
				w.WriteHeader(500)
				return
			}
			w.WriteHeader(204)
			return
		}
		if r.URL.Path == "/__test/revoke" && r.Method == "POST" {
			host.Rotate()
			w.WriteHeader(204)
			return
		}
		if strings.HasPrefix(r.Host, "s-") {
			w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'self' https: wss:; frame-src https:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'")
		}
		if r.URL.Path == "/tailmouse-config.json" {
			_, port, _ := net.SplitHostPort(r.Host)
			w.Header().Set("Content-Type", "application/json")
			configuration := map[string]any{"version": 1, "frontendBase": "https://ui.localhost:" + port, "contentBase": "https://content.localhost:" + port}
			if singleOrigin {
				configuration["testSingleOrigin"] = true
				configuration["frontendBase"] = "https://localhost:" + port
				configuration["contentBase"] = "https://localhost:" + port
			}
			_ = json.NewEncoder(w).Encode(configuration)
			return
		}
		if r.URL.Path == "/.tailmouse/sw.js" {
			w.Header().Set("Service-Worker-Allowed", "/")
		}
		if singleOrigin {
			if r.URL.Path == "/.tailmouse/workspace/" {
				r.URL.Path = "/"
			}
			if strings.HasPrefix(r.URL.Path, "/.tailmouse/p/") && strings.HasSuffix(r.URL.Path, "/bridge.html") {
				r.URL.Path = "/.tailmouse/bridge.html"
			}
		}
		static.ServeHTTP(w, r)
	}))
	defer web.Close()
	_, port, _ := strings.Cut(strings.TrimPrefix(web.URL, "https://"), ":")
	ctx, cancel := context.WithTimeout(t.Context(), 150*time.Second)
	defer cancel()
	uploadDir := t.TempDir()
	options := share.Options{Command: "dev", Argv: []string{"/bin/sh", "-c", "printf 'resource-terminal-ready\\n'; while IFS= read -r line; do printf 'resource-result:%s\\n' \"$line\"; done"}, Cwd: uploadDir, Directory: uploadDir, Target: appURL, MaxFile: 1 << 20, MaxTotal: 2 << 20, MaxFiles: 10, MaxClients: 2, TTL: 2 * time.Minute, Approval: "auto", FrontendBase: "https://ui.localhost:" + port, ContentBase: "https://content.localhost:" + port}
	if singleOrigin {
		options.TestSingleOrigin = true
		options.FrontendBase = "https://localhost:" + port
		options.ContentBase = options.FrontendBase
	}
	var token string
	var e error
	host, token, e = share.NewHost(ctx, options, os.Environ())
	if e != nil {
		t.Fatal("resource host initialization failed")
	}
	defer host.Close()
	terminalOutput := &lockedLeashCapture{}
	host.Terminal().SetLocal(terminalOutput)
	start := tailcattransport.LocalTestStarter(t)
	transport, e := start(ctx, tailcattransport.Config{DERPHosts: []string{"localhost"}, BindPeer: true, OnConnection: func(s tailcattransport.ByteStream) { host.Serve(s, tailcattransport.PeerIdentity(s)) }})
	if e != nil {
		t.Fatal("local resource transport failed")
	}
	defer transport.Close(context.Background())
	address, e := transport.CopyAddress()
	if e != nil {
		t.Fatal("resource invitation unavailable")
	}
	defer clear(address)
	host.Ready()
	link, e := host.Invitation(string(address), token)
	if e != nil {
		t.Fatal("resource invitation construction failed")
	}
	spki := sha256.Sum256(web.Certificate().RawSubjectPublicKeyInfo)
	payload, _ := json.Marshal(struct {
		URL          string `json:"url"`
		SPKI         string `json:"spki"`
		SingleOrigin bool   `json:"singleOrigin"`
	}{link, base64.StdEncoding.EncodeToString(spki[:]), singleOrigin})
	defer clear(payload)
	command := exec.CommandContext(ctx, "node", filepath.Join(root, "tests/integration/tailcat/resources.mjs"))
	command.Dir = root
	command.Stdin = bytes.NewReader(payload)
	command.WaitDelay = 3 * time.Second
	var output bytes.Buffer
	command.Stdout = &output
	command.Stderr = &output
	if e = command.Run(); e != nil {
		safe := strings.TrimSpace(output.String())
		if len(safe) > 200 || !strings.HasPrefix(safe, "resource stage:") {
			safe = "unclassified browser failure (output suppressed)"
		}
		t.Fatalf("resource browser acceptance failed: %s; input=%t result=%t", safe, strings.Contains(terminalOutput.text(), "after-hmr"), strings.Contains(terminalOutput.text(), "resource-result:after-hmr"))
	}
	if strings.TrimSpace(output.String()) != "resource stage: complete" {
		t.Fatal("unexpected resource probe output")
	}
	if mutations.Load() != 1 {
		t.Fatal("HTTP write was lost or replayed")
	}
	files, e := os.ReadDir(uploadDir)
	if e != nil {
		t.Fatal(e)
	}
	committed := 0
	for _, entry := range files {
		if strings.HasPrefix(entry.Name(), "sample-") {
			b, e := os.ReadFile(filepath.Join(uploadDir, entry.Name()))
			if e != nil {
				t.Fatal(e)
			}
			sum := sha256.Sum256(b)
			want := sha256.Sum256(bytes.Repeat([]byte("resource upload\n"), 10000))
			if hex.EncodeToString(sum[:]) != hex.EncodeToString(want[:]) {
				t.Fatal("uploaded bytes differ")
			}
			committed++
		}
	}
	if committed != 1 {
		t.Fatal("upload was not committed exactly once")
	}
}
