//go:build tailcatintegration

package tailcat

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"tailscale.com/derp/derpserver"
	"tailscale.com/net/stun"
	"tailscale.com/tailcfg"
	"tailscale.com/types/key"
	"tailscale.com/types/logger"
)

// LocalTestStarter is available only in integration builds. It keeps all
// upstream fixture types and localhost certificate policy inside the adapter.
func LocalTestStarter(t testing.TB, networks ...*LocalTestNetwork) func(context.Context, Config) (*Server, error) {
	t.Helper()
	if len(networks) > 1 || len(networks) == 1 && networks[0] == nil {
		t.Fatal("local test relay accepts at most one non-nil network profile")
	}
	var wrappers []func(*derpserver.Server) http.Handler
	if len(networks) == 1 {
		wrappers = append(wrappers, networks[0].link.handler)
	}
	region := runLocalDERP(t, wrappers...)
	return func(ctx context.Context, config Config) (*Server, error) {
		if len(config.DERPHosts) != 1 || config.DERPHosts[0] != "localhost" || config.DERPMapURL != "" {
			return nil, errors.New("local test relay requires an explicit localhost host")
		}
		return start(ctx, config, func(config Config) (backend, Relay, error) {
			created, relay, err := newBackend(config)
			if err != nil {
				return nil, Relay{}, err
			}
			created.(*realBackend).server.Region = region
			return created, relay, nil
		})
	}
}

func runLocalDERP(t testing.TB, wrappers ...func(*derpserver.Server) http.Handler) *tailcfg.DERPRegion {
	t.Helper()
	derp := derpserver.New(key.NewNode(), logger.Discard)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		derp.Close()
		t.Fatalf("listen for local DERP: %v", err)
	}
	handler := derpserver.AddWebSocketSupport(derp, derpserver.Handler(derp))
	if len(wrappers) != 0 {
		handler = wrappers[0](derp)
	}
	httpsServer := httptest.NewUnstartedServer(handler)
	if err := httpsServer.Listener.Close(); err != nil {
		_ = listener.Close()
		derp.Close()
		t.Fatalf("replace local DERP listener: %v", err)
	}
	httpsServer.Listener = listener
	httpsServer.Config.ErrorLog = logger.StdLogger(logger.Discard)
	httpsServer.Config.TLSNextProto = make(
		map[string]func(*http.Server, *tls.Conn, http.Handler),
	)
	httpsServer.StartTLS()

	stunListener, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		httpsServer.Close()
		derp.Close()
		t.Fatalf("listen for local STUN: %v", err)
	}
	stunDone := make(chan struct{})
	go serveLocalSTUN(stunListener, stunDone)
	t.Cleanup(func() {
		_ = stunListener.Close()
		httpsServer.CloseClientConnections()
		httpsServer.Close()
		derp.Close()
		select {
		case <-stunDone:
		case <-time.After(time.Second):
			t.Error("local STUN server did not stop")
		}
	})

	return &tailcfg.DERPRegion{
		RegionID:   900,
		RegionCode: defaultCustomRegionCode,
		RegionName: defaultCustomRegionName,
		Nodes: []*tailcfg.DERPNode{{
			Name:             "mouse-1",
			RegionID:         900,
			HostName:         "localhost",
			IPv4:             "127.0.0.1",
			IPv6:             "none",
			STUNPort:         stunListener.LocalAddr().(*net.UDPAddr).Port,
			DERPPort:         httpsServer.Listener.Addr().(*net.TCPAddr).Port,
			InsecureForTests: true,
			STUNTestIP:       "127.0.0.1",
		}},
	}
}

func serveLocalSTUN(listener *net.UDPConn, done chan<- struct{}) {
	defer close(done)
	var buffer [1500]byte
	for {
		length, source, err := listener.ReadFromUDPAddrPort(buffer[:])
		if err != nil {
			return
		}
		transaction, err := stun.ParseBindingRequest(buffer[:length])
		if err != nil {
			continue
		}
		_, _ = listener.WriteToUDPAddrPort(stun.Response(transaction, source), source)
	}
}

// LocalTestDERPMap exposes only a hermetic relay fixture, never an invitation.
func LocalTestDERPMap(t testing.TB) []byte {
	t.Helper()
	region := runLocalDERP(t)
	data, err := json.Marshal(&tailcfg.DERPMap{Regions: map[tailcfg.DERPRegionID]*tailcfg.DERPRegion{region.RegionID: region}})
	if err != nil {
		t.Fatal(err)
	}
	return data
}
