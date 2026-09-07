//go:build tailcatintegration

package tailcat

import (
	"context"

	upstream "github.com/tailscale/tailcat"
	"tailscale.com/types/logger"
)

// DialLocalTestStream keeps the hermetic integration client's upstream values
// inside the adapter boundary. The caller owns both returned cleanup paths.
func DialLocalTestStream(ctx context.Context, address []byte, port uint16) (ByteStream, func() error, error) {
	client := &upstream.Client{Server: upstream.Addr(address), Logf: logger.Discard}
	stream, err := client.DialTCPPort(ctx, port)
	if err != nil {
		_ = client.Close()
		return nil, nil, err
	}
	return stream, client.Close, nil
}
