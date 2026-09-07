package tailcat

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	upstream "github.com/tailscale/tailcat"
	"tailscale.com/tailcfg"
)

func TestNewBackendOfficialUsesZeroValueRelay(t *testing.T) {
	accepted := make(chan ByteStream, 1)
	created, relay, err := newBackend(Config{
		OnConnection: func(stream ByteStream) { accepted <- stream },
	})
	if err != nil {
		t.Fatal(err)
	}
	real := created.(*realBackend).server
	if relay.Mode != RelayOfficial {
		t.Fatalf("relay mode = %q, want %q", relay.Mode, RelayOfficial)
	}
	if real.Region != nil || real.RegionID != 0 || real.DERPMapURL != "" {
		t.Fatal("official mode populated an upstream relay override")
	}
	if !real.PresharedKey.IsZero() || real.DisablePresharedKey {
		t.Fatal("adapter bypassed Tailcat's default pre-shared-key generation")
	}
	if len(real.ServedTCPPorts) != 1 ||
		real.ServedTCPPorts[0].First != VirtualPort ||
		real.ServedTCPPorts[0].Last != VirtualPort {
		t.Fatalf("served ports = %#v, want only %d", real.ServedTCPPorts, VirtualPort)
	}
	if handler := real.OnTCP(VirtualPort - 1); handler != nil {
		t.Fatal("unexpected handler for a non-TailMouse port")
	}
	handler := real.OnTCP(VirtualPort)
	if handler == nil {
		t.Fatal("missing handler for the TailMouse port")
	}
	client, server := net.Pipe()
	defer client.Close()
	handler(server)
	select {
	case got := <-accepted:
		if got != server {
			t.Fatal("adapter changed the accepted byte stream")
		}
		_ = got.Close()
	case <-time.After(time.Second):
		t.Fatal("connection callback was not invoked")
	}
}

func TestNewBackendBuildsCustomRegion(t *testing.T) {
	created, relay, err := newBackend(Config{
		DERPHosts:    []string{" Z.example.com. ", "a.example.com", "z.example.com"},
		OnConnection: discardConnection,
	})
	if err != nil {
		t.Fatal(err)
	}
	real := created.(*realBackend).server
	if relay != (Relay{
		Mode:       RelayCustomHost,
		RegionID:   900,
		RegionCode: "mouse",
		RegionName: "TailMouse Custom DERP",
		Host:       "a.example.com",
	}) {
		t.Fatalf("relay = %#v", relay)
	}
	region := real.Region
	if region == nil || region.RegionID != 900 || region.RegionCode != "mouse" ||
		region.RegionName != "TailMouse Custom DERP" {
		t.Fatalf("custom region = %#v", region)
	}
	if len(region.Nodes) != 2 {
		t.Fatalf("node count = %d, want 2", len(region.Nodes))
	}
	for index, wantHost := range []string{"a.example.com", "z.example.com"} {
		node := region.Nodes[index]
		if node.HostName != wantHost || node.RegionID != 900 ||
			node.DERPPort != 443 || node.STUNPort != 3478 {
			t.Fatalf("node %d = %#v", index, node)
		}
	}

	key := upstream.NewPrivateKey()
	key.Public.Region = []*tailcfg.DERPRegion{region}
	parsed, err := upstream.ParseAddr(key.Public.Addr())
	if err != nil {
		t.Fatal(err)
	}
	if len(parsed.Region) != 1 || len(parsed.Region[0].Nodes) != 2 ||
		parsed.Region[0].Nodes[0].HostName != "a.example.com" ||
		parsed.Region[0].Nodes[1].HostName != "z.example.com" {
		t.Fatalf("full region was not retained in ConnBlob: %#v", parsed.Region)
	}
}

func TestNewBackendUsesCustomMap(t *testing.T) {
	created, relay, err := newBackend(Config{
		DERPMapURL:   "https://maps.example.com/derp.json?channel=stable",
		OnConnection: discardConnection,
	})
	if err != nil {
		t.Fatal(err)
	}
	real := created.(*realBackend).server
	if relay.Mode != RelayCustomMap || real.Region != nil ||
		real.DERPMapURL != "https://maps.example.com/derp.json?channel=stable" {
		t.Fatalf("custom map configuration = %#v, %#v", relay, real)
	}
}

func TestCustomRegionUsesLabelsAndEmbedsConnectionPorts(t *testing.T) {
	created, relay, err := newBackend(Config{
		DERPHosts: []string{"relay.example.com"}, DERPRegion: 999,
		DERPPort: 8443, STUNPort: 5349, RegionCode: "private", RegionName: "Private DERP",
		OnConnection: discardConnection,
	})
	if err != nil {
		t.Fatal(err)
	}
	key := upstream.NewPrivateKey()
	configured := created.(*realBackend).server.Region
	if configured.RegionID != 999 || configured.RegionCode != "private" || configured.RegionName != "Private DERP" ||
		relay.RegionID != 999 || relay.RegionCode != "private" || relay.RegionName != "Private DERP" {
		t.Fatal("custom region labels were not applied to the host")
	}
	key.Public.Region = []*tailcfg.DERPRegion{configured}
	decoded, err := upstream.ParseAddr(key.Public.Addr())
	if err != nil || len(decoded.Region) != 1 {
		t.Fatal("custom region did not round-trip")
	}
	region := decoded.Region[0]
	// Tailcat deliberately strips cosmetic IDs/labels. The browser needs the
	// complete connection fields, not matching local display identifiers.
	if len(region.Nodes) != 1 || region.Nodes[0].DERPPort != 8443 || region.Nodes[0].STUNPort != 5349 ||
		region.Nodes[0].HostName != "relay.example.com" {
		t.Fatal("custom connection ports or hostname were lost")
	}
}

func TestCustomRegionRejectsInvalidPortsAndLabels(t *testing.T) {
	for _, invalid := range []func(*Config){
		func(c *Config) { c.DERPPort = -1 },
		func(c *Config) { c.DERPPort = 65536 },
		func(c *Config) { c.STUNPort = -1 },
		func(c *Config) { c.STUNPort = 65536 },
		func(c *Config) { c.RegionCode = strings.Repeat("x", 33) },
		func(c *Config) { c.RegionName = strings.Repeat("x", 129) },
		func(c *Config) { c.RegionName = "invalid\nlabel" },
		func(c *Config) { c.RegionCode = string([]byte{0xff}) },
	} {
		config := Config{DERPHosts: []string{"relay.example.com"}, OnConnection: discardConnection}
		invalid(&config)
		if _, _, err := newBackend(config); !errors.Is(err, ErrInvalidConfig) {
			t.Fatal("invalid custom region was accepted")
		}
	}
}

func TestRelayConfigurationRejectsInvalidInput(t *testing.T) {
	longLabel := strings.Repeat("a", 64) + ".example"
	tests := []struct {
		name   string
		config Config
	}{
		{name: "missing handler", config: Config{}},
		{name: "hosts and map", config: testConfig([]string{"derp.example.com"}, "https://maps.example.com/map")},
		{name: "region without hosts", config: Config{DERPRegion: 900, OnConnection: discardConnection}},
		{name: "HTTP map", config: testConfig(nil, "http://maps.example.com/map")},
		{name: "relative map", config: testConfig(nil, "maps/derp.json")},
		{name: "map user info", config: testConfig(nil, "https://user@maps.example.com/map")},
		{name: "map fragment", config: testConfig(nil, "https://maps.example.com/map#secret")},
		{name: "low region", config: testConfigWithRegion([]string{"derp.example.com"}, 899)},
		{name: "high region", config: testConfigWithRegion([]string{"derp.example.com"}, 1000)},
		{name: "empty host", config: testConfig([]string{" "}, "")},
		{name: "host scheme", config: testConfig([]string{"https://derp.example.com"}, "")},
		{name: "host path", config: testConfig([]string{"derp.example.com/path"}, "")},
		{name: "host credential", config: testConfig([]string{"user@derp.example.com"}, "")},
		{name: "IP address", config: testConfig([]string{"192.0.2.1"}, "")},
		{name: "empty label", config: testConfig([]string{"derp..example.com"}, "")},
		{name: "leading hyphen", config: testConfig([]string{"-derp.example.com"}, "")},
		{name: "trailing hyphen", config: testConfig([]string{"derp-.example.com"}, "")},
		{name: "Unicode", config: testConfig([]string{"dérp.example.com"}, "")},
		{name: "long label", config: testConfig([]string{longLabel}, "")},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, _, err := newBackend(test.config)
			if !errors.Is(err, ErrInvalidConfig) {
				t.Fatalf("error = %v, want ErrInvalidConfig", err)
			}
		})
	}
}

func TestStartReturnsOwnedCredentialAndRelay(t *testing.T) {
	address := syntheticAddress(t, "relay.example.com")
	fake := &fakeBackend{address: address}
	server, err := start(context.Background(), Config{}, func(Config) (backend, Relay, error) {
		return fake, Relay{Mode: RelayOfficial}, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if fake.startCalls != 1 {
		t.Fatalf("start calls = %d, want 1", fake.startCalls)
	}
	if relay := server.Relay(); relay.Mode != RelayOfficial || relay.Host != "relay.example.com" {
		t.Fatalf("relay = %#v", relay)
	}
	first, err := server.CopyAddress()
	if err != nil || string(first) != address {
		t.Fatalf("address copy = %q, %v", first, err)
	}
	first[0] = 'x'
	second, err := server.CopyAddress()
	if err != nil || string(second) != address {
		t.Fatal("address copy aliases adapter memory")
	}
}

func TestStartPreservesConfiguredCustomRelayMetadata(t *testing.T) {
	address := syntheticAddress(t, "a.example.com", "z.example.com")
	want := Relay{
		Mode:       RelayCustomHost,
		RegionID:   912,
		RegionCode: "mouse",
		RegionName: "TailMouse Custom DERP",
		Host:       "a.example.com",
	}
	server, err := start(context.Background(), Config{}, func(Config) (backend, Relay, error) {
		return &fakeBackend{address: address}, want, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if got := server.Relay(); got != want {
		t.Fatalf("relay = %#v, want %#v", got, want)
	}
}

func TestStartFailuresAreRedactedAndClosed(t *testing.T) {
	const secret = "tcSyntheticBearerCredential"
	tests := []struct {
		name       string
		address    string
		startErr   error
		startPanic any
		want       error
	}{
		{name: "pre-shared-key generation panic", startPanic: "tcSyntheticBearerCredential", want: ErrStart},
		{name: "upstream start", startErr: errors.New("dial " + secret), want: ErrStart},
		{name: "upstream cancellation", startErr: errors.Join(errors.New(secret), context.Canceled), want: context.Canceled},
		{name: "upstream deadline", startErr: errors.Join(errors.New(secret), context.DeadlineExceeded), want: context.DeadlineExceeded},
		{name: "bad credential", address: secret, want: ErrCredential},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			fake := &fakeBackend{address: test.address, startErr: test.startErr, startPanic: test.startPanic}
			_, err := start(context.Background(), Config{}, func(Config) (backend, Relay, error) {
				return fake, Relay{Mode: RelayOfficial}, nil
			})
			if !errors.Is(err, test.want) {
				t.Fatalf("error = %v, want %v", err, test.want)
			}
			if strings.Contains(err.Error(), secret) {
				t.Fatalf("error leaked credential: %v", err)
			}
			if fake.closeCalls != 1 {
				t.Fatalf("close calls = %d, want 1", fake.closeCalls)
			}
		})
	}
}

func TestStartHonorsCancellationWithoutLeakingBackend(t *testing.T) {
	canceled, cancel := context.WithCancel(context.Background())
	cancel()
	called := false
	_, err := start(canceled, Config{}, func(Config) (backend, Relay, error) {
		called = true
		return nil, Relay{}, nil
	})
	if !errors.Is(err, context.Canceled) || called {
		t.Fatalf("pre-canceled start = %v, factory called = %v", err, called)
	}

	duringStart, cancelDuringStart := context.WithCancel(context.Background())
	fake := &fakeBackend{address: syntheticAddress(t, "relay.example.com")}
	fake.startHook = cancelDuringStart
	_, err = start(duringStart, Config{}, func(Config) (backend, Relay, error) {
		return fake, Relay{Mode: RelayOfficial}, nil
	})
	if !errors.Is(err, context.Canceled) || fake.closeCalls != 1 {
		t.Fatalf("canceled start = %v, close calls = %d", err, fake.closeCalls)
	}
}

func TestRealStartupCancelsInFlightMapHeadersAndBody(t *testing.T) {
	for _, phase := range []string{"headers", "body"} {
		for _, deadline := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/deadline=%v", phase, deadline), func(t *testing.T) {
				requested := make(chan bool, 1)
				requestDone := make(chan struct{})
				mapServer := newMapTLSServer(t, func(writer http.ResponseWriter, request *http.Request) {
					requested <- request.Header.Get("Tailcat-Mode") == "server"
					if phase == "body" {
						_, _ = writer.Write([]byte(`{"Regions":`))
						writer.(http.Flusher).Flush()
					}
					<-request.Context().Done()
					close(requestDone)
				})
				defer mapServer.Close()
				timeout := time.Minute
				if deadline {
					timeout = time.Second
				}
				ctx, cancel := context.WithTimeout(context.Background(), timeout)
				defer cancel()
				finished := make(chan error, 1)
				go func() {
					_, err := start(ctx, Config{OnConnection: discardConnection}, func(config Config) (backend, Relay, error) {
						created, relay, err := newBackend(config)
						if err != nil {
							return nil, Relay{}, err
						}
						// Trust only this fixture's certificate in this backend instance.
						real := created.(*realBackend)
						real.server.DERPMapURL = mapServer.URL + "/tcSyntheticMapSecret"
						real.mapTransport = mapServer.Client().Transport
						return created, relay, nil
					})
					finished <- err
				}()
				select {
				case serverMode := <-requested:
					if !serverMode {
						t.Error("map selection lost the upstream server-mode header")
					}
				case <-time.After(2 * time.Second):
					cancel()
					t.Fatal("map request did not start")
				}
				if !deadline {
					cancel()
				}
				select {
				case err := <-finished:
					want := context.Canceled
					if deadline {
						want = context.DeadlineExceeded
					}
					if !errors.Is(err, want) || strings.Contains(err.Error(), mapServer.URL) || strings.Contains(err.Error(), "tcSyntheticMapSecret") {
						t.Fatal("in-flight startup lost cancellation or disclosed map data")
					}
				case <-time.After(2 * time.Second):
					t.Fatal("startup did not honor cancellation within the caller bound")
				}
				select {
				case <-requestDone:
				case <-time.After(time.Second):
					t.Fatal("canceled startup retained its HTTP request")
				}
			})
		}
	}
}

func TestStartRejectsUnexpectedCustomHostCredential(t *testing.T) {
	fake := &fakeBackend{address: syntheticAddress(t, "other.example.com")}
	_, err := start(context.Background(), Config{}, func(Config) (backend, Relay, error) {
		return fake, Relay{Mode: RelayCustomHost, Host: "expected.example.com"}, nil
	})
	if !errors.Is(err, ErrCredential) || fake.closeCalls != 1 {
		t.Fatalf("error = %v, close calls = %d", err, fake.closeCalls)
	}
}

func TestCloseIsBoundedIdempotentAndErasesCredential(t *testing.T) {
	fake := &fakeBackend{address: syntheticAddress(t, "relay.example.com")}
	server, err := start(context.Background(), Config{}, func(Config) (backend, Relay, error) {
		return fake, Relay{Mode: RelayOfficial}, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	fake.drainHook = func(ctx context.Context) {
		deadline, ok := ctx.Deadline()
		if !ok || time.Until(deadline) > drainLimit || time.Until(deadline) < drainLimit-time.Second {
			t.Errorf("drain deadline = %v, want approximately %v", deadline, drainLimit)
		}
	}
	if err := server.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
	if fake.drainCalls != 1 || fake.closeCalls != 1 {
		t.Fatalf("drain/close calls = %d/%d", fake.drainCalls, fake.closeCalls)
	}
	if _, err := server.CopyAddress(); !errors.Is(err, ErrClosed) {
		t.Fatalf("address after close = %v, want ErrClosed", err)
	}
	if err := server.Close(context.Background()); err != nil ||
		fake.drainCalls != 1 || fake.closeCalls != 1 {
		t.Fatalf("second close = %v, calls = %d/%d", err, fake.drainCalls, fake.closeCalls)
	}
}

func TestClosePreservesSafeFailureClassifications(t *testing.T) {
	fake := &fakeBackend{
		address:  syntheticAddress(t, "relay.example.com"),
		drainErr: errors.New("drain tcSyntheticSecret"),
		closeErr: errors.New("close tcSyntheticSecret"),
	}
	server, err := start(context.Background(), Config{}, func(Config) (backend, Relay, error) {
		return fake, Relay{Mode: RelayOfficial}, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	err = server.Close(context.Background())
	if !errors.Is(err, ErrDrain) || !errors.Is(err, ErrClose) {
		t.Fatalf("close error = %v", err)
	}
	if strings.Contains(err.Error(), "tcSyntheticSecret") {
		t.Fatalf("close leaked upstream error: %v", err)
	}
}

func TestCloseUsesEarlierCallerDeadline(t *testing.T) {
	fake := &fakeBackend{
		address:  syntheticAddress(t, "relay.example.com"),
		drainErr: context.DeadlineExceeded,
	}
	fake.drainHook = func(ctx context.Context) { <-ctx.Done() }
	server, err := start(context.Background(), Config{}, func(Config) (backend, Relay, error) {
		return fake, Relay{Mode: RelayOfficial}, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Millisecond)
	defer cancel()
	started := time.Now()
	err = server.Close(ctx)
	if time.Since(started) > time.Second {
		t.Fatal("close ignored the caller deadline")
	}
	if !errors.Is(err, ErrDrain) || !errors.Is(err, context.DeadlineExceeded) || errors.Is(err, ErrClose) {
		t.Fatalf("close error = %v, want bounded drain without close failure", err)
	}
	if fake.closeCalls != 1 {
		t.Fatal("bounded drain did not force-close the backend")
	}
	if _, err := server.CopyAddress(); !errors.Is(err, ErrClosed) {
		t.Fatal("bounded drain left the invitation address available")
	}
}

func discardConnection(stream ByteStream) {
	_ = stream.Close()
}

func testConfig(hosts []string, mapURL string) Config {
	return Config{DERPHosts: hosts, DERPMapURL: mapURL, OnConnection: discardConnection}
}

func testConfigWithRegion(hosts []string, region int) Config {
	return Config{DERPHosts: hosts, DERPRegion: region, OnConnection: discardConnection}
}

func syntheticAddress(t *testing.T, hosts ...string) string {
	t.Helper()
	key := upstream.NewPrivateKey()
	region := &tailcfg.DERPRegion{
		RegionID:   900,
		RegionCode: "mouse",
		RegionName: "Synthetic Test DERP",
	}
	for _, host := range hosts {
		region.Nodes = append(region.Nodes, &tailcfg.DERPNode{
			Name:     "test-node",
			RegionID: 900,
			HostName: host,
			DERPPort: 443,
			STUNPort: 3478,
		})
	}
	key.Public.Region = []*tailcfg.DERPRegion{region}
	return string(key.Public.Addr())
}

type fakeBackend struct {
	mu sync.Mutex

	address    string
	startErr   error
	startPanic any
	drainErr   error
	closeErr   error
	startHook  func()
	drainHook  func(context.Context)

	startCalls int
	drainCalls int
	closeCalls int
}

func (f *fakeBackend) Start(context.Context) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.startCalls++
	if f.startHook != nil {
		f.startHook()
	}
	if f.startPanic != nil {
		panic(f.startPanic)
	}
	return f.startErr
}

func (f *fakeBackend) TailcatAddr() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.address
}

func (f *fakeBackend) DrainTCP(ctx context.Context) error {
	f.mu.Lock()
	f.drainCalls++
	hook := f.drainHook
	err := f.drainErr
	f.mu.Unlock()
	if hook != nil {
		hook(ctx)
	}
	return err
}

func (f *fakeBackend) Close() error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.closeCalls++
	return f.closeErr
}
