package tailcat

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"tailscale.com/tailcfg"
)

const (
	relayMapTimeout  = 10 * time.Second
	maxRelayMapBytes = 8 << 20
)

var errRelayMap = errors.New("DERP map acquisition failed")

// The transport is private to this adapter. Tests can trust their own local
// certificate without changing process-wide clients or certificate stores.
func fetchRelayMap(ctx context.Context, source string, transport http.RoundTripper) (*tailcfg.DERPMap, error) {
	ctx, cancel := context.WithTimeout(ctx, relayMapTimeout)
	defer cancel()
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	address, err := url.Parse(source)
	if err != nil || !validMapURL(address) {
		return nil, errRelayMap
	}
	client := &http.Client{
		Transport: transport,
		CheckRedirect: func(request *http.Request, via []*http.Request) error {
			if len(via) >= 10 || !validMapURL(request.URL) {
				return errRelayMap
			}
			return nil
		},
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, address.String(), nil)
	if err != nil {
		return nil, errRelayMap
	}
	request.Header.Set("Tailcat-Mode", "server")
	response, err := client.Do(request)
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, errRelayMap
	}
	if response.StatusCode != http.StatusOK || response.ContentLength > maxRelayMapBytes {
		_ = response.Body.Close() // The rejected response remains the root failure.
		return nil, errRelayMap
	}
	body, readErr := io.ReadAll(io.LimitReader(response.Body, maxRelayMapBytes+1))
	closeErr := response.Body.Close()
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	if readErr != nil || closeErr != nil || len(body) > maxRelayMapBytes {
		return nil, errRelayMap
	}
	var relayMap tailcfg.DERPMap
	if json.Unmarshal(body, &relayMap) != nil || !validRelayMap(&relayMap) {
		return nil, errRelayMap
	}
	return &relayMap, nil
}

func validMapURL(address *url.URL) bool {
	return address != nil && address.Scheme == "https" && address.Hostname() != "" &&
		address.User == nil && address.Fragment == "" && address.Opaque == ""
}

// Validate every region before upstream selection can probe even one node.
// Do not silently strip unsafe fields and then claim the map was accepted.
func validRelayMap(relayMap *tailcfg.DERPMap) bool {
	if len(relayMap.Regions) == 0 {
		return false
	}
	for id, region := range relayMap.Regions {
		if id <= 0 || region == nil || region.RegionID != id || len(region.Nodes) == 0 {
			return false
		}
		for _, node := range region.Nodes {
			if node == nil || node.RegionID != id || node.HostName == "" ||
				node.InsecureForTests || strings.HasPrefix(node.CertName, "sha256-raw:") {
				return false
			}
		}
	}
	return true
}
