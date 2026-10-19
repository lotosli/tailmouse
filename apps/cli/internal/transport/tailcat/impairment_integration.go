//go:build tailcatintegration

package tailcat

import (
	"bufio"
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
	"tailscale.com/derp"
	"tailscale.com/derp/derpserver"
	"tailscale.com/net/wsconn"
)

// RTT is added propagation delay. Each direction varies by +/- jitter/2,
// clamped at zero. Kbit is decimal full-duplex bandwidth.
type TestNetworkProfile struct {
	RTTMS    int `json:"rttMS"`
	JitterMS int `json:"jitterMS"`
	Loss     int `json:"loss"`
	Kbit     int `json:"kbit"`
}

type impairmentProfile = TestNetworkProfile

// LocalTestNetwork exposes only bounded test controls and safe counters to the
// native CLI integration tests. It is absent from normal application builds.
type LocalTestNetwork struct {
	link relayImpairment
}

func NewLocalTestNetwork(profile TestNetworkProfile) *LocalTestNetwork {
	network := &LocalTestNetwork{}
	network.link.configure(profile)
	return network
}

func (network *LocalTestNetwork) Pause(duration time.Duration)    { network.link.pause(duration) }
func (network *LocalTestNetwork) Inspect() [2]impairmentDirection { return network.link.inspect() }

// Restore removes impairment only after the measured slow-consumer window.
// Existing counters and already scheduled packets remain truthful evidence.
func (network *LocalTestNetwork) Restore() {
	network.link.mu.Lock()
	defer network.link.mu.Unlock()
	network.link.profile = impairmentProfile{}
	network.link.pauseUntil = time.Time{}
	for side := range network.link.directions {
		network.link.directions[side].next = time.Time{}
	}
}

type impairmentDirection struct {
	Packets, Dropped, Bytes, Delivered uint64
	Connections                        uint64
	MaxQueue                           int
	DelayMinMS, DelayMaxMS             float64
	next                               time.Time
}

type relayImpairment struct {
	mu          sync.Mutex
	profile     impairmentProfile
	directions  [2]impairmentDirection
	connections [2]*impairedConnection
	pauseUntil  time.Time
}

func (link *relayImpairment) configure(profile impairmentProfile) {
	link.mu.Lock()
	defer link.mu.Unlock()
	link.profile, link.directions, link.pauseUntil = profile, [2]impairmentDirection{}, time.Time{}
}

func (link *relayImpairment) pause(duration time.Duration) {
	link.mu.Lock()
	defer link.mu.Unlock()
	link.pauseUntil = time.Now().Add(duration)
}

func (link *relayImpairment) inspect() [2]impairmentDirection {
	link.mu.Lock()
	defer link.mu.Unlock()
	return link.directions
}

// disconnect closes the current native HTTP-upgrade and browser WebSocket
// transports, not the application stream or individual encrypted packets.
// Keep the listener available so Tailcat can establish new DERP connections.
func (link *relayImpairment) disconnect() error {
	link.mu.Lock()
	connections := link.connections
	link.mu.Unlock()
	if connections[0] == nil || connections[1] == nil {
		return errors.New("both test DERP transports must be connected")
	}
	var result error
	for _, connection := range connections {
		if err := connection.Close(); err != nil && !errors.Is(err, net.ErrClosed) {
			result = errors.Join(result, err)
		}
	}
	return result
}

func (link *relayImpairment) schedule(side, size int, now time.Time) (time.Time, bool) {
	link.mu.Lock()
	defer link.mu.Unlock()
	state, profile := &link.directions[side], link.profile
	state.Packets++
	state.Bytes += uint64(size)
	// An outage discards complete encrypted packets; inner TCP must recover.
	// Fractional accumulation gives exactly N losses per 100 packets without
	// nondeterministic seeds or accidentally omitting the 1% test condition.
	lost := profile.Loss > 0 && (state.Packets*uint64(profile.Loss))/100 != ((state.Packets-1)*uint64(profile.Loss))/100
	if now.Before(link.pauseUntil) || lost {
		state.Dropped++
		return time.Time{}, false
	}
	start := now
	if state.next.After(start) {
		start = state.next
	}
	if profile.Kbit > 0 {
		start = start.Add(time.Duration(size) * 8 * time.Second / time.Duration(profile.Kbit*1000))
	}
	state.next = start
	delay := time.Duration(profile.RTTMS) * time.Millisecond / 2
	if profile.JitterMS > 0 {
		delay += time.Duration(int((state.Packets*37+uint64(side)*13)%uint64(profile.JitterMS+1))-profile.JitterMS/2) * time.Millisecond
	}
	return start.Add(max(0, delay)), true
}

// handler adds a packet boundary without replacing the upstream relay. The
// native HTTP upgrade remains entirely upstream; WebSocket acceptance uses the
// same existing package and wsconn adapter as AddWebSocketSupport.
func (link *relayImpairment) handler(server *derpserver.Server) http.Handler {
	native := derpserver.Handler(server)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.EqualFold(r.Header.Get("Upgrade"), "websocket") ||
			!strings.Contains(r.Header.Get("Sec-WebSocket-Protocol"), "derp") {
			native.ServeHTTP(&impairedHijacker{ResponseWriter: w, link: link}, r)
			return
		}
		socket, err := websocket.Accept(w, r, &websocket.AcceptOptions{
			Subprotocols: []string{"derp"}, OriginPatterns: []string{"*"},
			CompressionMode: websocket.CompressionDisabled,
		})
		if err != nil {
			return
		}
		defer socket.CloseNow()
		if socket.Subprotocol() != "derp" {
			return
		}
		connection := wsconn.NetConn(r.Context(), socket, websocket.MessageBinary, r.RemoteAddr)
		shaped, reader := link.connection(connection, bufio.NewReader(connection), 1)
		defer shaped.Close()
		server.Accept(r.Context(), shaped, bufio.NewReadWriter(reader, bufio.NewWriter(shaped)), r.RemoteAddr)
	})
}

type impairedHijacker struct {
	http.ResponseWriter
	link *relayImpairment
}

func (writer *impairedHijacker) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	hijacker, ok := writer.ResponseWriter.(http.Hijacker)
	if !ok {
		return nil, nil, errors.New("test HTTP connection cannot be hijacked")
	}
	connection, buffered, err := hijacker.Hijack()
	if err != nil {
		return nil, nil, err
	}
	shaped, reader := writer.link.connection(connection, buffered.Reader, 0)
	return shaped, bufio.NewReadWriter(reader, buffered.Writer), nil
}

type impairedConnection struct {
	net.Conn
	cancel context.CancelFunc
	reader *io.PipeReader
	done   chan struct{}
}

// DERP may replace the Hijack reader with one built directly on this Conn.
// Keep that path on the scheduled pipe too: only the framing worker may read
// the underlying socket, otherwise both readers race and bypass impairment.
func (connection *impairedConnection) Read(buffer []byte) (int, error) {
	return connection.reader.Read(buffer)
}

func (connection *impairedConnection) Close() error {
	connection.cancel()
	_ = connection.reader.Close()
	err := connection.Conn.Close()
	<-connection.done
	return err
}

type scheduledPacket struct {
	kind       derp.FrameType
	payload    []byte
	receivedAt time.Time
	deliverAt  time.Time
}

func (link *relayImpairment) connection(connection net.Conn, input *bufio.Reader, side int) (*impairedConnection, *bufio.Reader) {
	ctx, cancel := context.WithCancel(context.Background())
	reader, writer := io.Pipe()
	shaped := &impairedConnection{Conn: connection, cancel: cancel, reader: reader, done: make(chan struct{})}
	link.mu.Lock()
	link.connections[side] = shaped
	link.directions[side].Connections++
	link.mu.Unlock()
	queue := make(chan scheduledPacket, 128)
	var workers sync.WaitGroup
	workers.Go(func() {
		defer close(queue)
		for {
			kind, size, err := derp.ReadFrameHeader(input)
			if err != nil {
				return
			}
			// Client-info and encrypted packet frames are small. Fail closed on
			// a corrupt fixture rather than allocating an unbounded test queue.
			if size > derp.MaxPacketSize+32 {
				_ = writer.CloseWithError(errors.New("oversized test DERP frame"))
				return
			}
			if kind == derp.FrameSendPacket && size < 32 {
				_ = writer.CloseWithError(errors.New("short test DERP packet"))
				return
			}
			packet := scheduledPacket{kind: kind, payload: make([]byte, size), receivedAt: time.Now()}
			if _, err := io.ReadFull(input, packet.payload); err != nil {
				return
			}
			packet.deliverAt = packet.receivedAt
			if kind == derp.FrameSendPacket {
				var deliver bool
				packet.deliverAt, deliver = link.schedule(side, int(size)-32, packet.receivedAt)
				if !deliver {
					continue
				}
			}
			select {
			case queue <- packet:
				link.mu.Lock()
				link.directions[side].MaxQueue = max(link.directions[side].MaxQueue, len(queue))
				link.mu.Unlock()
			case <-ctx.Done():
				return
			default:
				_ = writer.CloseWithError(errors.New("test DERP impairment queue overflow"))
				return
			}
		}
	})
	workers.Go(func() {
		defer writer.Close()
		buffered := bufio.NewWriter(writer)
		for packet := range queue {
			wait := time.NewTimer(time.Until(packet.deliverAt))
			select {
			case <-wait.C:
			case <-ctx.Done():
				wait.Stop()
				return
			}
			if packet.kind == derp.FrameSendPacket {
				link.mu.Lock()
				outage := time.Now().Before(link.pauseUntil)
				if outage {
					link.directions[side].Dropped++
				}
				link.mu.Unlock()
				if outage {
					continue
				}
			}
			if err := derp.WriteFrame(buffered, packet.kind, packet.payload); err != nil {
				return
			}
			if packet.kind == derp.FrameSendPacket {
				link.mu.Lock()
				state := &link.directions[side]
				delay := float64(time.Since(packet.receivedAt)) / float64(time.Millisecond)
				if state.Delivered == 0 || delay < state.DelayMinMS {
					state.DelayMinMS = delay
				}
				state.DelayMaxMS = max(state.DelayMaxMS, delay)
				state.Delivered++
				link.mu.Unlock()
			}
		}
	})
	go func() {
		workers.Wait()
		link.mu.Lock()
		if link.connections[side] == shaped {
			link.connections[side] = nil
		}
		link.mu.Unlock()
		close(shaped.done)
	}()
	return shaped, bufio.NewReader(reader)
}
