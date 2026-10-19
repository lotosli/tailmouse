// Package tailcat is the only native boundary between TailMouse and the
// unstable Tailcat Go API.
package tailcat

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"os"
	"slices"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"

	upstream "github.com/tailscale/tailcat"
	"tailscale.com/tailcfg"
	"tailscale.com/wgengine/filter"
)

const (
	// VirtualPort is the only Tailcat TCP port accepted by TailMouse.
	VirtualPort uint16 = 44321
	drainLimit         = 2 * time.Second

	defaultCustomRegionID   = 900
	defaultCustomRegionCode = "mouse"
	defaultCustomRegionName = "TailMouse Custom DERP"
)

var (
	ErrInvalidConfig = errors.New("invalid tailcat transport configuration")
	ErrStart         = errors.New("tailcat transport start failed")
	ErrCredential    = errors.New("tailcat connection credential is invalid")
	ErrDrain         = errors.New("tailcat transport drain failed")
	ErrClose         = errors.New("tailcat transport close failed")
	ErrClosed        = errors.New("tailcat transport is closed")
)

// ByteStream is the transport contract consumed by the native session layer.
type ByteStream interface {
	io.Reader
	io.Writer
	io.Closer
}

// RelayMode identifies the configured relay source without exposing a map URL
// or connection credential.
type RelayMode string

const (
	RelayOfficial   RelayMode = "official"
	RelayCustomHost RelayMode = "custom-host"
	RelayCustomMap  RelayMode = "custom-map"
)

// Relay describes non-secret relay metadata safe for diagnostics.
type Relay struct {
	Mode       RelayMode
	RegionID   int
	RegionCode string
	RegionName string
	Host       string
}

// Config contains only the transport inputs needed to start Tailcat.
type Config struct {
	DERPHosts    []string
	DERPMapURL   string
	DERPRegion   int
	DERPPort     int
	STUNPort     int
	RegionCode   string
	RegionName   string
	OnConnection func(ByteStream)
	// Resource sessions may load a local validated map and select one region.
	DERPMapFile     string
	PreferredRegion int
	BindPeer        bool
}

// Server owns a started Tailcat server and its in-memory connection address.
// It deliberately implements no formatter or marshaler for the credential.
type Server struct {
	backend backend
	relay   Relay

	mu      sync.RWMutex
	address []byte
	closed  bool

	closeOnce sync.Once
	closeErr  error
}

type backend interface {
	Start(context.Context) error
	TailcatAddr() string
	DrainTCP(context.Context) error
	Close() error
}

type realBackend struct {
	server          *upstream.Server
	mapTransport    http.RoundTripper
	mapFile         string
	preferredRegion int
}

func (b *realBackend) Start(ctx context.Context) error {
	if err := b.selectRegion(ctx); err != nil {
		return err
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	return b.server.Start()
}

func (b *realBackend) selectRegion(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if b.server.Region != nil {
		return nil
	}
	ctx, cancel := context.WithTimeout(ctx, relayMapTimeout)
	defer cancel()
	source := b.server.DERPMapURL
	if source == "" {
		source = upstream.DefaultDERPMapURL
	}
	var relayMap *tailcfg.DERPMap
	var err error
	if b.mapFile != "" {
		file, openErr := os.Open(b.mapFile)
		if openErr != nil {
			return errRelayMap
		}
		data, readErr := io.ReadAll(io.LimitReader(file, maxRelayMapBytes+1))
		closeErr := file.Close()
		var value tailcfg.DERPMap
		if readErr != nil || closeErr != nil || len(data) > maxRelayMapBytes || json.Unmarshal(data, &value) != nil || !validRelayMap(&value) {
			return errRelayMap
		}
		relayMap = &value
	} else {
		relayMap, err = fetchRelayMap(ctx, source, b.mapTransport)
	}
	if err != nil {
		return err
	}
	if b.preferredRegion != 0 {
		region := relayMap.Regions[tailcfg.DERPRegionID(b.preferredRegion)]
		if region == nil {
			return errRelayMap
		}
		b.server.Region = region
		return nil
	}
	// Tailcat still owns selection. Supplying the complete validated map
	// prevents its fetcher from following insecure redirects or stale data.
	info := upstream.ConnInfo{RegionID: -1}
	if err := info.Expand(ctx, relayMap, upstream.ExpandForServer); err != nil {
		return err
	}
	if len(info.Region) != 1 || info.Region[0] == nil {
		return ErrCredential
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	b.server.Region = info.Region[0]
	return nil
}
func (b *realBackend) TailcatAddr() string                { return string(b.server.TailcatAddr()) }
func (b *realBackend) DrainTCP(ctx context.Context) error { return b.server.DrainTCP(ctx) }
func (b *realBackend) Close() error                       { return b.server.Close() }

type backendFactory func(Config) (backend, Relay, error)

// Start creates the production Tailcat adapter. Upstream error text is never
// returned because it can contain a bearer address.
func Start(ctx context.Context, config Config) (*Server, error) {
	return start(ctx, config, newBackend)
}

func start(ctx context.Context, config Config, factory backendFactory) (*Server, error) {
	if err := ctx.Err(); err != nil {
		return nil, fmt.Errorf("start transport: %w", err)
	}
	configured, configuredRelay, err := factory(config)
	if err != nil {
		return nil, err
	}
	if err := startBackend(ctx, configured); err != nil {
		_ = configured.Close()
		category := ErrStart
		if errors.Is(err, context.Canceled) {
			category = context.Canceled
		} else if errors.Is(err, context.DeadlineExceeded) {
			category = context.DeadlineExceeded
		}
		return nil, fmt.Errorf("start transport: %w", category)
	}
	if err := ctx.Err(); err != nil {
		_ = configured.Close()
		return nil, fmt.Errorf("start transport: %w", err)
	}
	address := configured.TailcatAddr()
	relay, err := relayFromAddress(configuredRelay.Mode, address)
	if err != nil {
		_ = configured.Close()
		return nil, err
	}
	if configuredRelay.Mode == RelayCustomHost {
		if relay.Host != configuredRelay.Host {
			_ = configured.Close()
			return nil, fmt.Errorf("inspect transport credential: %w", ErrCredential)
		}
		relay = configuredRelay
	}
	return &Server{
		backend: configured,
		relay:   relay,
		address: []byte(address),
	}, nil
}

// Tailcat v0.6 creates its pre-shared key inside Start and reports entropy
// failure by panicking. Contain any upstream startup panic at this volatile
// boundary and expose only the existing redacted start classification.
func startBackend(ctx context.Context, configured backend) (err error) {
	defer func() {
		if recover() != nil {
			err = ErrStart
		}
	}()
	return configured.Start(ctx)
}

func newBackend(config Config) (backend, Relay, error) {
	if config.DERPMapFile != "" && (config.DERPMapURL != "" || len(config.DERPHosts) > 0) || config.PreferredRegion < 0 {
		return nil, Relay{}, ErrInvalidConfig
	}
	configuredRelay, region, mapURL, err := normalizeRelay(config)
	if err != nil {
		return nil, Relay{}, err
	}
	server := &upstream.Server{
		Logf: func(string, ...any) {},
		OnTCP: func(port uint16) func(net.Conn) {
			if port != VirtualPort || config.OnConnection == nil {
				return nil
			}
			return func(connection net.Conn) {
				if config.BindPeer {
					config.OnConnection(&peerStream{Conn: connection})
				} else {
					config.OnConnection(connection)
				}
			}
		},
		ServedTCPPorts: []filter.PortRange{{First: VirtualPort, Last: VirtualPort}},
	}
	if region != nil {
		server.Region = region
	}
	if mapURL != "" {
		server.DERPMapURL = mapURL
	}
	if config.DERPMapFile != "" {
		configuredRelay.Mode = RelayCustomMap
	}
	return &realBackend{server: server, mapFile: config.DERPMapFile, preferredRegion: config.PreferredRegion}, configuredRelay, nil
}

// The transport binds the peer identity to its validated WireGuard address.
type peerStream struct{ net.Conn }

func (s *peerStream) PeerIdentity() string {
	if s == nil || s.Conn == nil || s.RemoteAddr() == nil {
		return ""
	}
	address, _, err := net.SplitHostPort(s.RemoteAddr().String())
	if err != nil {
		return ""
	}
	ip, err := netip.ParseAddr(address)
	if err != nil || !ip.Is6() || ip.Zone() != "" {
		return ""
	}
	return ip.String()
}
func PeerIdentity(stream ByteStream) string {
	peer, ok := stream.(*peerStream)
	if !ok {
		return ""
	}
	return peer.PeerIdentity()
}

func normalizeRelay(config Config) (Relay, *tailcfg.DERPRegion, string, error) {
	if config.OnConnection == nil {
		return Relay{}, nil, "", fmt.Errorf(
			"configure transport: %w: connection handler is required",
			ErrInvalidConfig,
		)
	}
	if len(config.DERPHosts) > 0 && config.DERPMapURL != "" {
		return Relay{}, nil, "", fmt.Errorf(
			"configure relay: %w: DERP host and map are mutually exclusive",
			ErrInvalidConfig,
		)
	}
	if config.DERPMapURL != "" {
		parsed, err := url.Parse(config.DERPMapURL)
		if err != nil || parsed.Scheme != "https" || parsed.Host == "" ||
			parsed.User != nil || parsed.Fragment != "" {
			return Relay{}, nil, "", fmt.Errorf(
				"configure relay: %w: DERP map must be an absolute HTTPS URL",
				ErrInvalidConfig,
			)
		}
		return Relay{Mode: RelayCustomMap}, nil, parsed.String(), nil
	}
	if len(config.DERPHosts) == 0 {
		if config.DERPRegion != 0 {
			return Relay{}, nil, "", fmt.Errorf(
				"configure relay: %w: custom region requires DERP hosts",
				ErrInvalidConfig,
			)
		}
		return Relay{Mode: RelayOfficial}, nil, "", nil
	}

	regionID := config.DERPRegion
	if regionID == 0 {
		regionID = defaultCustomRegionID
	}
	if regionID < 900 || regionID > 999 {
		return Relay{}, nil, "", fmt.Errorf(
			"configure relay: %w: custom region must be between 900 and 999",
			ErrInvalidConfig,
		)
	}
	derpPort, stunPort := config.DERPPort, config.STUNPort
	if derpPort == 0 {
		derpPort = 443
	}
	if stunPort == 0 {
		stunPort = 3478
	}
	if derpPort < 1 || derpPort > 65535 || stunPort < 1 || stunPort > 65535 {
		return Relay{}, nil, "", fmt.Errorf("configure relay: %w: invalid custom port", ErrInvalidConfig)
	}
	code, name := config.RegionCode, config.RegionName
	if code == "" {
		code = defaultCustomRegionCode
	}
	if name == "" {
		name = defaultCustomRegionName
	}
	if !validRegionLabel(code, 32) || !validRegionLabel(name, 128) {
		return Relay{}, nil, "", fmt.Errorf("configure relay: %w: invalid custom region label", ErrInvalidConfig)
	}
	hosts := make([]string, 0, len(config.DERPHosts))
	seen := make(map[string]struct{}, len(config.DERPHosts))
	for _, value := range config.DERPHosts {
		host, err := normalizeHostname(value)
		if err != nil {
			return Relay{}, nil, "", err
		}
		if _, exists := seen[host]; exists {
			continue
		}
		seen[host] = struct{}{}
		hosts = append(hosts, host)
	}
	if len(hosts) == 0 {
		return Relay{}, nil, "", fmt.Errorf(
			"configure relay: %w: at least one DERP host is required",
			ErrInvalidConfig,
		)
	}
	slices.Sort(hosts)
	region := &tailcfg.DERPRegion{
		RegionID:   tailcfg.DERPRegionID(regionID),
		RegionCode: code,
		RegionName: name,
	}
	for index, host := range hosts {
		region.Nodes = append(region.Nodes, &tailcfg.DERPNode{
			Name:     fmt.Sprintf("mouse-%d", index+1),
			RegionID: tailcfg.DERPRegionID(regionID),
			HostName: host,
			DERPPort: derpPort,
			STUNPort: stunPort,
		})
	}
	return Relay{
		Mode:       RelayCustomHost,
		RegionID:   regionID,
		RegionCode: code,
		RegionName: name,
		Host:       hosts[0],
	}, region, "", nil
}

func validRegionLabel(value string, maximum int) bool {
	return len(value) <= maximum && utf8.ValidString(value) && !strings.ContainsFunc(value, unicode.IsControl)
}

func normalizeHostname(value string) (string, error) {
	host := strings.ToLower(strings.TrimSuffix(strings.TrimSpace(value), "."))
	if host == "" || len(host) > 253 {
		return "", fmt.Errorf("configure relay: %w: invalid DERP hostname", ErrInvalidConfig)
	}
	if _, err := netip.ParseAddr(host); err == nil {
		return "", fmt.Errorf("configure relay: %w: DERP hostname cannot be an IP address", ErrInvalidConfig)
	}
	for _, label := range strings.Split(host, ".") {
		if len(label) == 0 || len(label) > 63 || label[0] == '-' || label[len(label)-1] == '-' {
			return "", fmt.Errorf("configure relay: %w: invalid DERP hostname", ErrInvalidConfig)
		}
		for _, character := range label {
			if character > 127 || !(character == '-' || character >= '0' && character <= '9' ||
				character >= 'a' && character <= 'z') {
				return "", fmt.Errorf("configure relay: %w: invalid DERP hostname", ErrInvalidConfig)
			}
		}
	}
	return host, nil
}

func relayFromAddress(mode RelayMode, address string) (Relay, error) {
	info, err := upstream.ParseAddr(upstream.Addr(address))
	if err != nil || len(info.Region) != 1 || info.Region[0] == nil || len(info.Region[0].Nodes) == 0 {
		return Relay{}, fmt.Errorf("inspect transport credential: %w", ErrCredential)
	}
	region := info.Region[0]
	host := ""
	for _, node := range region.Nodes {
		if node != nil && node.HostName != "" {
			host = node.HostName
			break
		}
	}
	return Relay{
		Mode:       mode,
		RegionID:   int(region.RegionID),
		RegionCode: region.RegionCode,
		RegionName: region.RegionName,
		Host:       host,
	}, nil
}

// Relay returns a copy of the adapter's safe relay metadata.
func (s *Server) Relay() Relay {
	return s.relay
}

// CopyAddress returns an explicit disposable copy for invitation construction.
func (s *Server) CopyAddress() ([]byte, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.closed {
		return nil, ErrClosed
	}
	return slices.Clone(s.address), nil
}

// Close drains for at most two seconds, closes Tailcat, and erases the
// adapter's retained address. Repeated calls return the first close result.
func (s *Server) Close(ctx context.Context) error {
	s.closeOnce.Do(func() {
		drainContext, cancel := context.WithTimeout(ctx, drainLimit)
		defer cancel()
		var failures []error
		if err := s.backend.DrainTCP(drainContext); err != nil {
			failures = append(failures, ErrDrain)
			if errors.Is(err, context.DeadlineExceeded) && errors.Is(drainContext.Err(), context.DeadlineExceeded) {
				// Preserve only the safe timeout classification. A gone peer
				// cannot acknowledge FIN; force-close still runs below.
				failures = append(failures, context.DeadlineExceeded)
			}
		}
		if err := s.backend.Close(); err != nil {
			failures = append(failures, ErrClose)
		}
		s.mu.Lock()
		for index := range s.address {
			s.address[index] = 0
		}
		s.address = nil
		s.closed = true
		s.mu.Unlock()
		s.closeErr = errors.Join(failures...)
	})
	return s.closeErr
}
