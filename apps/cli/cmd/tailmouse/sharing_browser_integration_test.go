//go:build tailcatintegration && (darwin || linux)

package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"tailmouse/apps/cli/internal/share"
	tailcattransport "tailmouse/apps/cli/internal/transport/tailcat"
)

func TestHermeticSimpleSharing(t *testing.T) {
	_, source, _, _ := runtime.Caller(0)
	root := filepath.Clean(filepath.Join(filepath.Dir(source), "../../../.."))
	ctx, cancel := context.WithTimeout(t.Context(), 150*time.Second)
	defer cancel()
	relayMap := tailcattransport.LocalTestDERPMap(t)
	static := http.FileServer(http.Dir(filepath.Join(root, "apps/web/dist")))
	web := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Referrer-Policy", "no-referrer")
		if r.URL.Path == "/__test/map.json" {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write(relayMap)
			return
		}
		if r.URL.Path == "/tailmouse-config.json" {
			_, port, _ := net.SplitHostPort(r.Host)
			origin := "https://localhost:" + port
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{"version": 1, "frontendBase": origin, "contentBase": origin, "testSingleOrigin": true, "derpMap": origin + "/__test/map.json", "releaseManifest": "/web-manifest.json"})
			return
		}
		if r.URL.Path == "/.tailmouse/workspace/" {
			r.URL.Path = "/"
		}
		static.ServeHTTP(w, r)
	}))
	defer web.Close()
	_, port, _ := net.SplitHostPort(web.Listener.Addr().String())
	origin := "https://localhost:" + port
	dir := t.TempDir()
	_ = os.Mkdir(filepath.Join(dir, "nested"), 0700)
	data := bytes.Repeat([]byte("native download\n"), 1000)
	if err := os.WriteFile(filepath.Join(dir, "nested", "report.txt"), data, 0600); err != nil {
		t.Fatal(err)
	}
	_ = os.WriteFile(filepath.Join(dir, ".hidden"), []byte("not shared"), 0600)
	o := share.Options{Command: "files", Offer: dir, TextEnabled: true, Text: "native host text", Cwd: dir, FrontendBase: origin, ContentBase: origin, TestSingleOrigin: true, MaxFile: 1 << 20, MaxTotal: 2 << 20, MaxFiles: 10, MaxClients: 1, TTL: 2 * time.Minute, Approval: "auto"}
	host, token, err := share.NewHost(ctx, o, nil)
	if err != nil {
		t.Fatal("native sharing fixture failed")
	}
	defer host.Close()
	start := tailcattransport.LocalTestStarter(t)
	transport, err := start(ctx, tailcattransport.Config{DERPHosts: []string{"localhost"}, BindPeer: true, OnConnection: func(stream tailcattransport.ByteStream) { host.Serve(stream, tailcattransport.PeerIdentity(stream)) }})
	if err != nil {
		t.Fatal("native fixture transport failed")
	}
	defer transport.Close(context.Background())
	address, err := transport.CopyAddress()
	if err != nil {
		t.Fatal("native fixture invitation failed")
	}
	defer clear(address)
	host.Ready()
	link, err := host.Invitation(string(address), token)
	if err != nil {
		t.Fatal("native fixture invitation failed")
	}
	spki := sha256.Sum256(web.Certificate().RawSubjectPublicKeyInfo)
	payload, _ := json.Marshal(map[string]string{"origin": origin, "nativeURL": link, "spki": base64.StdEncoding.EncodeToString(spki[:])})
	defer clear(payload)
	command := exec.CommandContext(ctx, "node", filepath.Join(root, "tests/integration/tailcat/simple-sharing.mjs"))
	command.Dir = root
	command.Stdin = bytes.NewReader(payload)
	command.WaitDelay = 3 * time.Second
	var output bytes.Buffer
	command.Stdout = &output
	command.Stderr = &output
	if err := command.Run(); err != nil {
		safe := strings.TrimSpace(output.String())
		if len(safe) > 160 || !strings.HasPrefix(safe, "sharing stage:") {
			safe = "browser failure (details suppressed)"
		}
		t.Fatal(safe)
	}
	if strings.TrimSpace(output.String()) != "sharing stage: complete" || host.TextValue() != "native visitor reply" {
		t.Fatal("sharing acceptance did not complete")
	}
}
