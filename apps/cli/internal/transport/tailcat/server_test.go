package tailcat

import (
	"context"
	"errors"
	"net"
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
	parsed, err := upstream.ParseConnBlob(key.Public.ConnBlob())
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
		name     string
		address  string
		startErr error
		want     error
	}{
		{name: "upstream start", startErr: errors.New("dial " + secret), want: ErrStart},
		{name: "bad credential", address: secret, want: ErrCredential},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			fake := &fakeBackend{address: test.address, startErr: test.startErr}
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
	if !errors.Is(err, ErrDrain) {
		t.Fatalf("close error = %v, want ErrDrain", err)
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
	return string(key.Public.ConnBlob())
}

type fakeBackend struct {
	mu sync.Mutex

	address   string
	startErr  error
	drainErr  error
	closeErr  error
	startHook func()
	drainHook func(context.Context)

	startCalls int
	drainCalls int
	closeCalls int
}

func (f *fakeBackend) Start() error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.startCalls++
	if f.startHook != nil {
		f.startHook()
	}
	return f.startErr
}

func (f *fakeBackend) ConnBlob() string {
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
