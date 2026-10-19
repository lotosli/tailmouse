//go:build tailcatintegration

package tailcat

import (
	"context"
	"errors"

	upstream "github.com/tailscale/tailcat"
	"tailscale.com/types/logger"
)

// DialLocalTestStream keeps the hermetic integration client's upstream values
// inside the adapter boundary. The caller owns both returned cleanup paths.
// Close the stream before invoking client cleanup so its TCP FIN can drain.
func DialLocalTestStream(ctx context.Context, address []byte, port uint16) (ByteStream, func() error, error) {
	client := &upstream.Client{Server: upstream.Addr(address), Logf: logger.Discard}
	stream, err := client.DialTCPPort(ctx, port)
	if err != nil {
		_ = client.Close()
		return nil, nil, err
	}
	return stream, func() error {
		// Destroying the userspace stack immediately after stream.Close can
		// discard its FIN and leave the Host's authentication worker waiting.
		// Cleanup gets its own bound even if the dial context was canceled.
		drainContext, cancel := context.WithTimeout(context.Background(), drainLimit)
		defer cancel()
		var failures []error
		if err := client.DrainTCP(drainContext); err != nil {
			failures = append(failures, ErrDrain)
		}
		if err := client.Close(); err != nil {
			failures = append(failures, ErrClose)
		}
		return errors.Join(failures...)
	}, nil
}
