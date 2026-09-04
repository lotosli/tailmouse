package tailcat

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	upstream "github.com/tailscale/tailcat"
	"tailscale.com/tailcfg"
)

const relayMapFixture = `{"Regions":{"900":{"RegionID":900,"RegionCode":"fixture","RegionName":"Fixture","Nodes":[{"Name":"fixture","RegionID":900,"HostName":"relay.example.invalid","DERPPort":443,"STUNPort":3478}]}}}`

type mapRoundTripFunc func(*http.Request) (*http.Response, error)

func (fn mapRoundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return fn(request)
}

func newMapTLSServer(t *testing.T, handler http.HandlerFunc) *httptest.Server {
	t.Helper()
	server := httptest.NewUnstartedServer(handler)
	server.Config.ErrorLog = log.New(io.Discard, "", 0)
	server.StartTLS()
	t.Cleanup(server.Close)
	return server
}

func TestRelayMapTrustedHTTPSPreservesDataWithoutCaching(t *testing.T) {
	var requests, missingHeader atomic.Int32
	server := newMapTLSServer(t, func(writer http.ResponseWriter, request *http.Request) {
		requests.Add(1)
		if request.Header.Get("Tailcat-Mode") != "server" {
			missingHeader.Add(1)
		}
		if request.URL.Path == "/start" {
			http.Redirect(writer, request, "/map", http.StatusFound)
			return
		}
		_, _ = io.WriteString(writer, relayMapFixture)
	})
	var expected tailcfg.DERPMap
	if err := json.Unmarshal([]byte(relayMapFixture), &expected); err != nil {
		t.Fatal("invalid static map fixture")
	}
	for range 2 {
		actual, err := fetchRelayMap(t.Context(), server.URL+"/start", server.Client().Transport)
		if err != nil || !reflect.DeepEqual(actual, &expected) {
			t.Fatal("trusted HTTPS redirect did not preserve the complete map")
		}
	}
	if requests.Load() != 4 || missingHeader.Load() != 0 {
		t.Fatal("map acquisition cached a response or omitted the server-mode header")
	}
	if _, err := fetchRelayMap(t.Context(), server.URL+"/map", nil); !errors.Is(err, errRelayMap) || requests.Load() != 4 {
		t.Fatal("untrusted TLS certificate was accepted or reached the HTTP handler")
	}
}

func TestRelayMapRejectsUnsafeRedirectBeforeDestinationRequest(t *testing.T) {
	for _, scenario := range []string{"http", "userinfo", "fragment", "loop"} {
		t.Run(scenario, func(t *testing.T) {
			var destinations, redirects atomic.Int32
			plain := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { destinations.Add(1) }))
			t.Cleanup(plain.Close)
			server := newMapTLSServer(t, func(writer http.ResponseWriter, request *http.Request) {
				if request.URL.Path == "/map" {
					destinations.Add(1)
					_, _ = io.WriteString(writer, relayMapFixture)
					return
				}
				redirects.Add(1)
				location := plain.URL + "/tcSyntheticMapSecret"
				switch scenario {
				case "userinfo":
					location = "https://user:tcSyntheticMapSecret@" + request.Host + "/map"
				case "fragment":
					location = "https://" + request.Host + "/map#tcSyntheticMapSecret"
				case "loop":
					location = "/redirect"
				}
				http.Redirect(writer, request, location, http.StatusFound)
			})
			_, err := fetchRelayMap(t.Context(), server.URL+"/redirect", server.Client().Transport)
			if !errors.Is(err, errRelayMap) || strings.Contains(err.Error(), "tcSyntheticMapSecret") || destinations.Load() != 0 {
				t.Fatal("unsafe redirect reached its destination or disclosed response data")
			}
			want := int32(1)
			if scenario == "loop" {
				want = 10
			}
			if redirects.Load() != want {
				t.Fatal("redirect request budget was not exact")
			}
		})
	}
}

func TestRelayMapRejectsInitialURLsBeforeRequest(t *testing.T) {
	for _, source := range []string{"http://maps.example.invalid", "https://user:tcSyntheticMapSecret@maps.example.invalid", "https://maps.example.invalid/#tcSyntheticMapSecret", "/relative", "https:", "://invalid", "https://maps.example.invalid:bad/"} {
		called := false
		_, err := fetchRelayMap(t.Context(), source, mapRoundTripFunc(func(*http.Request) (*http.Response, error) {
			called = true
			return nil, errors.New("unexpected request")
		}))
		if !errors.Is(err, errRelayMap) || called || strings.Contains(err.Error(), "tcSyntheticMapSecret") {
			t.Fatal("invalid initial URL reached HTTP or lost redaction")
		}
	}
}

func TestRelayMapRejectsUnsafeStructureBeforeSelection(t *testing.T) {
	for _, scenario := range []string{"empty", "nil region", "region mismatch", "zero region", "empty nodes", "nil node", "node mismatch", "empty host", "insecure node", "raw certificate", "unsafe unselected region"} {
		t.Run(scenario, func(t *testing.T) {
			var value tailcfg.DERPMap
			if err := json.Unmarshal([]byte(relayMapFixture), &value); err != nil {
				t.Fatal("invalid static map fixture")
			}
			region := value.Regions[900]
			switch scenario {
			case "empty":
				value.Regions = nil
			case "nil region":
				value.Regions[900] = nil
			case "region mismatch":
				region.RegionID = 901
			case "zero region":
				value.Regions[0] = region
			case "empty nodes":
				region.Nodes = nil
			case "nil node":
				region.Nodes[0] = nil
			case "node mismatch":
				region.Nodes[0].RegionID = 901
			case "empty host":
				region.Nodes[0].HostName = ""
			case "insecure node":
				region.Nodes[0].InsecureForTests = true
			case "raw certificate":
				region.Nodes[0].CertName = "sha256-raw:" + strings.Repeat("0", 64)
			case "unsafe unselected region":
				value.Regions[901] = &tailcfg.DERPRegion{RegionID: 901, Nodes: []*tailcfg.DERPNode{{RegionID: 901, HostName: "unused.example.invalid", InsecureForTests: true}}}
			}
			body, err := json.Marshal(value)
			if err != nil {
				t.Fatal("cannot encode static map fixture")
			}
			backend := &realBackend{server: &upstream.Server{DERPMapURL: "https://maps.example.invalid/tcSyntheticMapSecret"}, mapTransport: mapRoundTripFunc(func(*http.Request) (*http.Response, error) {
				return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader(string(body)))}, nil
			})}
			ctx, cancel := context.WithTimeout(t.Context(), time.Second)
			defer cancel()
			if err := backend.Start(ctx); !errors.Is(err, errRelayMap) || backend.server.Region != nil || !backend.server.Key.IsZero() {
				t.Fatal("unsafe map was not rejected before upstream region selection/start")
			}
		})
	}
}

func TestRelayMapOfficialSourceUsesSecureAcquisition(t *testing.T) {
	requests := 0
	var native *realBackend
	_, err := start(t.Context(), Config{OnConnection: discardConnection}, func(config Config) (backend, Relay, error) {
		created, relay, err := newBackend(config)
		if err != nil {
			return nil, Relay{}, err
		}
		native = created.(*realBackend)
		native.mapTransport = mapRoundTripFunc(func(request *http.Request) (*http.Response, error) {
			requests++
			if request.URL.String() != upstream.DefaultDERPMapURL || request.URL.Scheme != "https" {
				t.Error("official mode did not preserve the upstream HTTPS source")
			}
			return nil, errors.New("tcSyntheticMapSecret")
		})
		return native, relay, nil
	})
	if !errors.Is(err, ErrStart) || strings.Contains(err.Error(), "tcSyntheticMapSecret") || requests != 1 {
		t.Fatal("official acquisition retried or lost safe startup classification")
	}
	if native.server.Region != nil || !native.server.Key.IsZero() {
		t.Fatal("failed official acquisition selected a region or created a host key")
	}
}

func TestRelayMapBodyBoundsAndFailureRedaction(t *testing.T) {
	for _, scenario := range []string{"exact limit", "oversize", "declared oversize", "status", "malformed", "null", "transport", "read", "close"} {
		t.Run(scenario, func(t *testing.T) {
			body := relayMapFixture
			if scenario == "exact limit" || scenario == "oversize" {
				body += strings.Repeat(" ", maxRelayMapBytes-len(body))
				if scenario == "oversize" {
					body += " "
				}
			} else if scenario == "malformed" {
				body = "tcSyntheticMapSecret"
			} else if scenario == "null" {
				body = "null"
			}
			reader := &mapBody{Reader: strings.NewReader(body)}
			response := &http.Response{StatusCode: http.StatusOK, Body: reader, ContentLength: -1}
			if scenario == "declared oversize" {
				response.ContentLength = maxRelayMapBytes + 1
			} else if scenario == "status" {
				response.StatusCode = http.StatusServiceUnavailable
			} else if scenario == "read" {
				reader.readErr = errors.New("tcSyntheticMapSecret")
			} else if scenario == "close" {
				reader.closeErr = errors.New("tcSyntheticMapSecret")
			}
			var requestContext context.Context
			_, err := fetchRelayMap(t.Context(), "https://maps.example.invalid/tcSyntheticMapSecret", mapRoundTripFunc(func(request *http.Request) (*http.Response, error) {
				requestContext = request.Context()
				deadline, exists := requestContext.Deadline()
				if !exists || time.Until(deadline) <= 0 || time.Until(deadline) > relayMapTimeout {
					t.Error("HTTP acquisition omitted its ten-second bound")
				}
				if scenario == "transport" {
					return nil, errors.New("tcSyntheticMapSecret")
				}
				return response, nil
			}))
			if scenario == "exact limit" {
				if err != nil {
					t.Fatal("valid map at the exact byte limit was rejected")
				}
			} else if !errors.Is(err, errRelayMap) || strings.Contains(err.Error(), "tcSyntheticMapSecret") {
				t.Fatal("map failure was accepted or not redacted")
			}
			if scenario != "transport" && !reader.closed || reader.readBytes > maxRelayMapBytes+1 {
				t.Fatal("map body was not closed or exceeded its read budget")
			}
			if (scenario == "declared oversize" || scenario == "status") && reader.readBytes != 0 {
				t.Fatal("rejected response body was read")
			}
			if requestContext.Err() == nil {
				t.Fatal("completed acquisition retained its request context")
			}
		})
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if _, err := fetchRelayMap(ctx, "https://maps.example.invalid", nil); !errors.Is(err, context.Canceled) {
		t.Fatal("pre-canceled acquisition lost its classification")
	}
}

type mapBody struct {
	io.Reader
	readErr, closeErr error
	readBytes         int
	closed            bool
}

func (body *mapBody) Read(buffer []byte) (int, error) {
	if body.readErr != nil {
		return 0, body.readErr
	}
	count, err := body.Reader.Read(buffer)
	body.readBytes += count
	return count, err
}

func (body *mapBody) Close() error {
	body.closed = true
	return body.closeErr
}
