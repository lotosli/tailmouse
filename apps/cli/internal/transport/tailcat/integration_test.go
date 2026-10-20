//go:build tailcatintegration

package tailcat

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"regexp"
	"runtime"
	"strings"
	"testing"
	"time"

	upstream "github.com/tailscale/tailcat"
	"tailmouse/apps/cli/internal/invitation"
	"tailmouse/apps/cli/internal/session"
	"tailscale.com/tailcfg"
	"tailscale.com/types/logger"
)

// TestHermeticTailcatTransport is run from the repository root with:
//
//	pnpm test:transport
//
// The command builds the recorded Tailcat Wasm revision and production PWA
// before running this test. No public relay or application backend is used.
func TestHermeticTailcatTransport(t *testing.T) {
	t.Run("official mode keeps the upstream zero-value relay", func(t *testing.T) {
		created, relay, err := newBackend(Config{OnConnection: discardConnection})
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = created.Close() })
		real := created.(*realBackend).server
		if relay.Mode != RelayOfficial || real.Region != nil ||
			real.RegionID != 0 || real.DERPMapURL != "" {
			t.Fatalf("official construction populated a relay override: %#v", relay)
		}
	})

	for _, mode := range []RelayMode{RelayCustomHost, RelayCustomMap} {
		t.Run(string(mode)+" connects native server to browser Wasm", func(t *testing.T) {
			testRelayBrowserWasm(t, mode, "chromium")
		})
	}
}

// Additional real engines reuse the exact transport assertions; they do not
// establish branded Safari/Edge, current-version or physical-device support.
func TestHermeticTailcatBrowserEngines(t *testing.T) {
	t.Run("invalid selector fails before browser launch", func(t *testing.T) {
		payload := []byte(`{"engine":"constructor","baseURL":"http://127.0.0.1:1","validFragment":"A","invalidFragment":"A","incorrectAddress":"synthetic","mismatchedFragment":"A"}`)
		err := runBrowserProbe(t, t.Context(), repositoryRoot(t), payload)
		if err == nil || !strings.Contains(err.Error(), "INPUT_INVALID") || strings.Contains(err.Error(), "stage: launch") {
			t.Fatal("invalid browser selector did not fail before launch")
		}
	})
	for _, engine := range []string{"firefox", "webkit"} {
		t.Run(engine, func(t *testing.T) {
			testRelayBrowserWasm(t, RelayCustomHost, engine)
		})
	}
}

// Run explicitly where Chrome stable is already installed. Missing Chrome is a
// prerequisite failure, not an automatic installation or a skipped assertion.
func TestHermeticTailcatChromeStable(t *testing.T) {
	testRelayBrowserWasm(t, RelayCustomHost, "chrome")
}

func testRelayBrowserWasm(t *testing.T, mode RelayMode, engine string) {
	region := runLocalDERP(t)
	browserLeft := make(chan struct{}, 1)
	host, err := session.NewHost(t.Context(), session.Config{
		Mode: "leash", NoPassword: true, Readonly: true, TTL: 5 * time.Minute, ReconnectGrace: 30 * time.Second,
		SessionID: [16]byte{1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16},
	}, time.Now(), func(event session.Event) error {
		if event.Kind == session.BrowserDisconnected {
			select {
			case browserLeft <- struct{}{}:
			default:
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := host.ConfigureLeash(); err != nil {
		t.Fatal(err)
	}
	config := Config{
		DERPHosts:  []string{"localhost"},
		DERPRegion: 900,
		OnConnection: func(stream ByteStream) {
			host.Accept(stream)
		},
	}
	var mapServer *httptest.Server
	var mapRegion *tailcfg.DERPRegion
	mapRequested := make(chan bool, 1)
	if mode == RelayCustomMap {
		copyRegion := *region
		copyRegion.Nodes = make([]*tailcfg.DERPNode, len(region.Nodes))
		for i, node := range region.Nodes {
			copyNode := *node
			copyNode.InsecureForTests = false
			copyRegion.Nodes[i] = &copyNode
		}
		mapRegion = &copyRegion
		mapServer = newMapTLSServer(t, func(writer http.ResponseWriter, request *http.Request) {
			select {
			case mapRequested <- request.Header.Get("Tailcat-Mode") == "server":
			default:
			}
			if err := json.NewEncoder(writer).Encode(&tailcfg.DERPMap{Regions: map[tailcfg.DERPRegionID]*tailcfg.DERPRegion{900: mapRegion}}); err != nil {
				t.Error("could not write the controlled DERP map")
			}
		})
		config.DERPHosts, config.DERPRegion = nil, 0
		config.DERPMapURL = "https://map.example.test/derp.json"
	}
	server, err := start(t.Context(), config, func(config Config) (backend, Relay, error) {
		created, relay, err := newBackend(config)
		if err != nil {
			return nil, Relay{}, err
		}
		// Production custom hosts use the required 443/3478 ports. This
		// build-tagged test replaces only the upstream region with the same
		// region identity on random localhost ports so it stays unprivileged.
		if mapServer == nil {
			created.(*realBackend).server.Region = region
		} else {
			real := created.(*realBackend)
			real.server.DERPMapURL = mapServer.URL
			real.mapTransport = mapServer.Client().Transport
			if err := real.selectRegion(t.Context()); err != nil {
				return nil, Relay{}, err
			}
			if !reflect.DeepEqual(real.server.Region, mapRegion) {
				t.Fatal("validated map selection changed the controlled region")
			}
			// Only after production HTTPS acquisition, validation and upstream
			// selection succeed, allow this owned relay's self-signed TLS.
			// Tailcat has no per-client trust-root option. This fixture-only
			// substitution cannot accept an unsafe map in production.
			real.server.Region = region
		}
		return created, relay, nil
	})
	if err != nil {
		t.Fatalf("start local Tailcat adapter: %v", err)
	}
	if mapServer != nil {
		select {
		case serverMode := <-mapRequested:
			if !serverMode {
				t.Fatal("custom map lost server selection semantics")
			}
		default:
			t.Fatal("custom map was not fetched")
		}
		// A successful browser connection after shutdown proves that the
		// full selected region, not a map reference, crossed the invitation.
		mapServer.Close()
	}
	t.Cleanup(func() {
		_ = host.Close("local_revoke")
		cleanupContext, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		if err := server.Close(cleanupContext); err != nil && !t.Failed() {
			t.Error("local Tailcat adapter cleanup failed")
		}
	})
	relay := server.Relay()
	if err := host.Listen(string(relay.Mode), relay.Host, time.Now()); err != nil {
		t.Fatal(err)
	}

	if relay.Mode != mode || relay.Host != "localhost" {
		t.Fatalf("adapter changed safe local relay metadata: %#v", relay)
	}
	if mode == RelayCustomHost && (relay.RegionID != 900 || relay.RegionCode != defaultCustomRegionCode || relay.RegionName != defaultCustomRegionName) {
		t.Fatal("adapter lost custom-host display labels")
	}

	address, err := server.CopyAddress()
	if err != nil {
		t.Fatal(err)
	}
	defer eraseBytes(address)
	assertFullLocalRegion(t, address, region)
	assertPSKInvitation(t, address)
	testCanceledDial(t, address)

	root := repositoryRoot(t)
	dist := filepath.Join(root, "apps", "web", "dist")
	if _, err := os.Stat(filepath.Join(dist, "index.html")); err != nil {
		t.Fatalf("production Web build is missing: %v", err)
	}
	staticServer := httptest.NewServer(http.FileServer(http.Dir(dist)))
	t.Cleanup(staticServer.Close)

	incorrectAddress := wrongServerAddress(t, address)
	defer eraseBytes(incorrectAddress)
	request := browserRequest{
		Engine:           engine,
		BaseURL:          staticServer.URL,
		ValidFragment:    mouseCardFragment(t, string(address), invitation.ModeLeash),
		InvalidFragment:  mouseCardFragment(t, string(incorrectAddress), invitation.ModeLeash),
		IncorrectAddress: string(incorrectAddress),
	}
	payload, err := json.Marshal(request)
	request.ValidFragment = ""
	request.InvalidFragment = ""
	request.IncorrectAddress = ""
	if err != nil {
		t.Fatal(err)
	}
	defer eraseBytes(payload)

	probeContext, cancelProbe := context.WithCancel(t.Context())
	probeDone := make(chan error, 1)
	probeFinished := make(chan struct{})
	go func() {
		defer close(probeFinished)
		probeDone <- runBrowserProbe(t, probeContext, root, payload)
	}()
	defer func() {
		cancelProbe()
		select {
		case <-probeFinished:
		case <-time.After(5 * time.Second):
			t.Error("browser probe did not stop during cleanup")
		}
	}()
	select {
	case <-browserLeft:
		if err := host.Close("normal"); err != nil {
			t.Fatal(err)
		}
	case err := <-probeDone:
		if err != nil {
			t.Fatal(err)
		}
		t.Fatal("browser probe ended before visitor disconnection")
	case <-time.After(30 * time.Second):
		t.Fatal("native session handler did not finish")
	}
	// Assert drain immediately, while the unrelated incorrect-token test is
	// still running. Its sixty-second timeout must not hide TCP TIME-WAIT.
	drainContext, cancelDrain := context.WithTimeout(t.Context(), 2*time.Second)
	defer cancelDrain()
	if err := server.backend.DrainTCP(drainContext); err != nil {
		t.Fatal("native passive close did not drain within two seconds")
	}
	if err := <-probeDone; err != nil {
		t.Fatal(err)
	}

	closeContext, cancelClose := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancelClose()
	if err := server.Close(closeContext); err != nil {
		t.Fatalf("graceful Tailcat close: %v", err)
	}
	if err := server.Close(closeContext); err != nil {
		t.Fatalf("repeated Tailcat close: %v", err)
	}
	if _, err := server.CopyAddress(); !errors.Is(err, ErrClosed) {
		t.Fatalf("address after close: %v, want ErrClosed", err)
	}
}

func wrongServerAddress(t *testing.T, address []byte) []byte {
	t.Helper()
	parsed, err := upstream.ParseAddr(upstream.Addr(address))
	if err != nil {
		t.Fatal("cannot construct the incorrect test credential")
	}
	other := upstream.NewPrivateKey()
	parsed.ServerPublic = other.Public.ServerPublic
	parsed.ServerDiscoPublic = other.Public.ServerDiscoPublic
	return []byte(parsed.Addr())
}

func assertFullLocalRegion(t *testing.T, address []byte, want *tailcfg.DERPRegion) {
	t.Helper()
	parsed, err := upstream.ParseAddr(upstream.Addr(address))
	if err != nil {
		t.Fatal("adapter produced an invalid connection credential")
	}
	if len(parsed.Region) != 1 || len(parsed.Region[0].Nodes) != 1 {
		t.Fatal("adapter credential omitted the local DERP region")
	}
	if parsed.PresharedKey.IsZero() {
		t.Fatal("adapter credential omitted Tailcat's default pre-shared key")
	}
	got := parsed.Region[0]
	gotNode := got.Nodes[0]
	wantNode := want.Nodes[0]
	if got.RegionID == 0 || gotNode.RegionID != got.RegionID ||
		gotNode.HostName != wantNode.HostName || gotNode.IPv4 != wantNode.IPv4 ||
		gotNode.IPv6 != wantNode.IPv6 || gotNode.STUNPort != wantNode.STUNPort ||
		gotNode.DERPPort != wantNode.DERPPort ||
		gotNode.InsecureForTests != wantNode.InsecureForTests {
		t.Fatal("adapter credential changed the self-contained DERP node")
	}
}

func assertPSKInvitation(t *testing.T, address []byte) {
	t.Helper()
	now := time.Now().Round(time.Second)
	card := invitation.MouseCard{
		Version:     invitation.CardVersion,
		Mode:        invitation.ModeLeash,
		TailcatAddr: string(address),
		Port:        invitation.VirtualPort,
		SessionID:   [16]byte{1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16},
		ExpiresAt:   now.Add(5 * time.Minute).Unix(),
		ProtocolMin: invitation.LeashProtocol,
		ProtocolMax: invitation.LeashProtocol,
	}
	encoded, err := invitation.Encode(card)
	if err != nil {
		t.Fatal("PSK-bearing address did not fit the MouseCard")
	}
	defer eraseBytes(encoded)
	fragment := "#/v1/" + base64.RawURLEncoding.EncodeToString(encoded)
	decoded, err := invitation.ParseFragment(fragment, now)
	fragment = ""
	if err != nil || decoded != card {
		t.Fatal("PSK-bearing MouseCard did not round-trip as one opaque field")
	}
	created, err := invitation.New("https://link.tailmouse.com/", card)
	if err != nil {
		t.Fatal("PSK-bearing invitation exceeded the existing URL bound")
	}
	defer created.Erase()
	var rendered bytes.Buffer
	if err := created.Render(&rendered, now, invitation.DisplayOptions{Relay: "official", NoQR: false}); err != nil {
		t.Fatal("PSK-bearing invitation did not fit the existing QR contract")
	}
	eraseBytes(rendered.Bytes())

	oversized := card
	oversized.TailcatAddr += strings.Repeat("x", invitation.MaxInvitationBytes)
	partial, err := invitation.New("https://link.tailmouse.com/", oversized)
	if partial != nil {
		partial.Erase()
	}
	if partial != nil || !errors.Is(err, invitation.ErrInvitationSize) {
		t.Fatal("oversized PSK-bearing invitation did not fail before display")
	}
}

func testCanceledDial(t *testing.T, address []byte) {
	t.Helper()
	client := &upstream.Client{
		Server: upstream.Addr(address),
		Logf:   logger.Discard,
	}
	t.Cleanup(func() { _ = client.Close() })
	connected, cancelConnected := context.WithTimeout(t.Context(), 30*time.Second)
	defer cancelConnected()
	for {
		attempt, cancelAttempt := context.WithTimeout(connected, 3*time.Second)
		_, err := client.Ping(attempt)
		cancelAttempt()
		if err == nil {
			break
		}
		if connected.Err() != nil {
			t.Fatal("local Tailcat client did not reach the controlled relay")
		}
	}

	canceled, cancel := context.WithCancel(t.Context())
	cancel()
	_, err := client.DialTCPPort(canceled, VirtualPort)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled Tailcat dial error = %v, want context.Canceled", err)
	}
}

type browserRequest struct {
	Engine           string `json:"engine"`
	BaseURL          string `json:"baseURL"`
	ValidFragment    string `json:"validFragment"`
	InvalidFragment  string `json:"invalidFragment"`
	IncorrectAddress string `json:"incorrectAddress"`
}

func mouseCardFragment(t *testing.T, address string, mode invitation.Mode) string {
	t.Helper()
	identifier := [16]byte{1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16}
	protocolIdentifier := invitation.LeashProtocol
	if mode == invitation.ModeLeash {
		protocolIdentifier = invitation.LeashProtocol
	}
	encoded, err := invitation.Encode(invitation.MouseCard{
		Version:     invitation.CardVersion,
		Mode:        mode,
		TailcatAddr: address,
		Port:        invitation.VirtualPort,
		SessionID:   identifier,
		ExpiresAt:   time.Now().Add(5 * time.Minute).Unix(),
		ProtocolMin: protocolIdentifier,
		ProtocolMax: protocolIdentifier,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer eraseBytes(encoded)
	return base64.RawURLEncoding.EncodeToString(encoded)
}

func runBrowserProbe(t *testing.T, ctx context.Context, root string, payload []byte) error {
	t.Helper()
	node, err := exec.LookPath("node")
	if err != nil {
		return errors.New("node is required for the browser transport integration test")
	}
	probeContext, cancelProbe := context.WithTimeout(ctx, 2*time.Minute)
	defer cancelProbe()
	command := exec.CommandContext(
		probeContext,
		node,
		filepath.Join(root, "tests", "integration", "tailcat", "browser.mjs"),
	)
	command.Dir = root
	command.WaitDelay = 3 * time.Second
	command.Stdin = bytes.NewReader(payload)
	var output, versionOutput bytes.Buffer
	command.Stdout = &versionOutput
	command.Stderr = &output
	if err := command.Run(); err != nil {
		message := strings.TrimSpace(output.String())
		if len(message) > 512 {
			message = message[:512]
		}
		return fmt.Errorf("browser transport probe failed: %w: %s", err, message)
	}
	expectedTrace := strings.Join([]string{
		"browser transport stage: input",
		"browser transport stage: launch",
		"browser transport stage: session",
		"browser transport stage: game-view",
		"browser transport stage: busy",
		"browser transport stage: mode-mismatch",
		"browser transport stage: session-close",
		"browser transport stage: incorrect-token",
		"browser transport stage: context-close",
		"browser transport stage: browser-close",
		"browser transport stage: done",
	}, "\n")
	if strings.TrimSpace(output.String()) != expectedTrace {
		return errors.New("browser transport probe emitted an invalid stage trace")
	}
	result := strings.Split(strings.TrimSpace(versionOutput.String()), "\n")
	if len(result) != 2 || result[1] != "DIAL_FAILED" && result[1] != "DIAL_TIMEOUT" {
		return errors.New("browser transport probe emitted an invalid rejection outcome")
	}
	version := result[0]
	if len(version) > 64 || !regexp.MustCompile(`^\d+(?:\.\d+){1,3}$`).MatchString(version) {
		return errors.New("browser transport probe emitted an invalid runtime version")
	}
	t.Logf("browser transport runtime version: %s; incorrect-token outcome: %s", version, result[1])
	return nil
}

func repositoryRoot(t *testing.T) string {
	t.Helper()
	_, filename, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("cannot locate integration test source")
	}
	return filepath.Clean(filepath.Join(filepath.Dir(filename), "..", "..", "..", "..", ".."))
}

func eraseBytes(value []byte) {
	for index := range value {
		value[index] = 0
	}
}
