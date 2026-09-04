package protocol

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"io"
	"math"
	"net"
	"strings"
	"testing"
	"time"
)

func TestReadFrameConsumesSharedFixtures(t *testing.T) {
	_, corpus := loadFixtureCorpus(t)
	for _, fixture := range corpus.Cases {
		t.Run(fixture.ID, func(t *testing.T) {
			wire := materializeFixture(t, fixture.Wire)
			stream := newChunkReadCloser(wire, fixture.Fragments)
			frame, err := ReadFrame(context.Background(), stream, fixturePeer(t, fixture.Receiver), fixtureState(t, fixture.State))
			if fixture.Expect.Accepted {
				if err != nil {
					t.Fatalf("ReadFrame() error = %v", err)
				}
				defer erase(frame.Payload)
				if frame.Type.String() != fixture.Expect.Message || int(frame.SelectedProtocol) != fixture.Expect.SelectedProtocol {
					t.Fatalf("frame = %s protocol %d", frame.Type, frame.SelectedProtocol)
				}
				if stream.offset != len(wire) {
					t.Fatalf("read %d of %d fixture bytes", stream.offset, len(wire))
				}
				encoded := &shortWriteCloser{maximum: 7}
				if err := WriteFrame(context.Background(), encoded, fixturePeer(t, fixture.Receiver).other(), fixtureState(t, fixture.State), frame); err != nil {
					t.Fatalf("re-encode shared fixture: %v", err)
				}
				if !bytes.Equal(encoded.Bytes(), wire) {
					t.Fatal("Go encoding differs from the shared golden bytes")
				}
				return
			}
			code, ok := ErrorCodeOf(err)
			if !ok || string(code) != fixture.Expect.Error {
				t.Fatalf("ReadFrame() error = %v, want %s", err, fixture.Expect.Error)
			}
			if strings.Contains(err.Error(), "synthetic-test-agent") {
				t.Fatal("protocol error included input data")
			}
		})
	}
}

func TestMessageRegistryNamesRulesAndRoutes(t *testing.T) {
	tests := []struct {
		message MessageType
		name    string
		sender  Peer
		state   State
		payload []byte
	}{
		{TypeClientHello, "CLIENT_HELLO", PeerBrowser, StateAwaitClientHello, fixturePayload(t, "valid-client-hello-v1")},
		{TypeServerWelcome, "SERVER_WELCOME", PeerHost, StateAwaitServerWelcome, fixturePayload(t, "valid-server-welcome-v1")},
		{TypeError, "ERROR", PeerHost, StateAwaitServerWelcome, fixturePayload(t, "valid-error-session-busy")},
		{TypePing, "PING", PeerHost, StateActiveEscape, make([]byte, 16)},
		{TypePong, "PONG", PeerBrowser, StateActiveLeash, make([]byte, 16)},
		{TypeClose, "CLOSE", PeerHost, StateClosing, fixturePayload(t, "valid-close-normal")},
		{TypeTermReset, "TERM_RESET", PeerHost, StateActiveLeash, []byte(`{"generation":1,"cols":80,"rows":24}`)},
		{TypeTermOutput, "TERM_OUTPUT", PeerHost, StateActiveLeash, []byte("a")},
		{TypeTermInput, "TERM_INPUT", PeerBrowser, StateActiveLeash, []byte("a")},
		{TypeTermResize, "TERM_RESIZE", PeerBrowser, StateActiveLeash, []byte{0, 80, 0, 24}},
		{TypeProcessControl, "PROCESS_CONTROL", PeerBrowser, StateActiveLeash, []byte(`{"action":"interrupt","generation":1}`)},
		{TypeProcessState, "PROCESS_STATE", PeerHost, StateActiveLeash, []byte(`{"generation":1,"state":"waiting","pid":null,"started_at":null,"exit_code":null,"signal":null}`)},
		{TypeOutputDropped, "OUTPUT_DROPPED", PeerHost, StateActiveLeash, []byte(`{"generation":1,"dropped_bytes":0}`)},
		{TypeGameInit, "GAME_INIT", PeerHost, StateActiveEscape, fixturePayload(t, "game-init-canonical")},
		{TypeGameInput, "GAME_INPUT", PeerBrowser, StateActiveEscape, validGameInput()},
		{TypeGameSnapshot, "GAME_SNAPSHOT", PeerHost, StateActiveEscape, validGameSnapshot()},
		{TypeGameEvent, "GAME_EVENT", PeerBrowser, StateActiveEscape, fixturePayload(t, "game-event-exit-requested")},
		{TypeGameResult, "GAME_RESULT", PeerHost, StateActiveEscape, fixturePayload(t, "game-result-escaped")},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			rule, ok := ruleFor(test.message)
			if !ok || test.message.String() != test.name || validateRoute(test.message, test.sender, test.state) != "" {
				t.Fatalf("registry mismatch for %s", test.name)
			}
			if len(test.payload) < rule.minimum || len(test.payload) > rule.maximum {
				t.Fatalf("invalid test payload for %s", test.name)
			}
			if _, err := validatePayload(test.message, test.payload, test.sender); err != nil {
				t.Fatalf("valid payload for %s: %v", test.name, err)
			}
		})
	}
	if _, ok := ruleFor(0xff); ok || MessageType(0xff).String() != "UNKNOWN" {
		t.Fatal("unknown registry type was accepted")
	}
	if Peer(0).other() != 0 || PeerHost.other() != PeerBrowser || PeerBrowser.other() != PeerHost {
		t.Fatal("peer direction mapping is invalid")
	}
}

func TestWriteFrameHandlesShortWritesAndRoundTrips(t *testing.T) {
	payload := make([]byte, 16)
	binary.BigEndian.PutUint64(payload[0:8], 7)
	binary.BigEndian.PutUint64(payload[8:16], 99)
	written := &shortWriteCloser{maximum: 3}
	if err := WriteFrame(context.Background(), written, PeerHost, StateActiveEscape, Frame{Type: TypePing, Payload: payload}); err != nil {
		t.Fatal(err)
	}
	if written.closed {
		t.Fatal("successful write closed the stream")
	}
	frame, err := ReadFrame(context.Background(), io.NopCloser(bytes.NewReader(written.Bytes())), PeerBrowser, StateActiveEscape)
	if err != nil {
		t.Fatal(err)
	}
	defer erase(frame.Payload)
	if frame.Type != TypePing || !bytes.Equal(frame.Payload, payload) {
		t.Fatal("frame did not round trip")
	}
}

func TestReadFrameRejectsBeforePayloadAllocation(t *testing.T) {
	tests := []struct {
		name     string
		wire     []byte
		wantRead int
		code     ErrorCode
		state    State
	}{
		{name: "global", wire: []byte{0, 0x10, 0, 1}, wantRead: 4, code: CodeFrameTooLarge, state: StateActiveEscape},
		{name: "terminal", wire: []byte{0, 0, 0x80, 1, byte(TypeTermInput), 0}, wantRead: 6, code: CodeFrameTooLarge, state: StateActiveLeash},
		{name: "unknown", wire: []byte{0, 0, 0, 10, 0xff, 0}, wantRead: 6, code: CodeBadFrame, state: StateActiveEscape},
		{name: "wrong mode", wire: []byte{0, 0, 0, 10, byte(TypeTermInput), 0}, wantRead: 6, code: CodeModeMismatch, state: StateActiveEscape},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			stream := newChunkReadCloser(test.wire, nil)
			_, err := ReadFrame(context.Background(), stream, PeerHost, test.state)
			code, ok := ErrorCodeOf(err)
			if !ok || code != test.code || stream.offset != test.wantRead {
				t.Fatalf("error = %v, bytes read = %d", err, stream.offset)
			}
		})
	}
}

func TestReadAndWriteHonorCancellation(t *testing.T) {
	t.Run("read", func(t *testing.T) {
		reader, peer := net.Pipe()
		defer peer.Close()
		ctx, cancel := context.WithCancel(context.Background())
		result := make(chan error, 1)
		go func() {
			_, err := ReadFrame(ctx, reader, PeerHost, StateAwaitClientHello)
			result <- err
		}()
		cancel()
		select {
		case err := <-result:
			if !errors.Is(err, context.Canceled) {
				t.Fatalf("read error = %v", err)
			}
		case <-time.After(time.Second):
			t.Fatal("canceled frame read remained blocked")
		}
	})

	t.Run("write", func(t *testing.T) {
		writer, peer := net.Pipe()
		defer peer.Close()
		ctx, cancel := context.WithCancel(context.Background())
		result := make(chan error, 1)
		go func() {
			result <- WriteFrame(ctx, writer, PeerHost, StateActiveEscape, Frame{Type: TypePing, Payload: make([]byte, 16)})
		}()
		cancel()
		select {
		case err := <-result:
			if !errors.Is(err, context.Canceled) {
				t.Fatalf("write error = %v", err)
			}
		case <-time.After(time.Second):
			t.Fatal("canceled frame write remained blocked")
		}
	})
}

func TestFrameBoundaryAndPayloadFailuresAreClassified(t *testing.T) {
	badWriter := &failingWriteCloser{}
	if err := WriteFrame(context.Background(), badWriter, PeerHost, StateActiveEscape, Frame{Type: TypePing, Payload: make([]byte, 16)}); !errors.Is(err, ErrStream) || strings.Contains(err.Error(), "credential") {
		t.Fatalf("write error = %v", err)
	}
	if err := WriteFrame(context.Background(), &shortWriteCloser{maximum: -1}, PeerHost, StateActiveEscape, Frame{Type: TypePing, Payload: make([]byte, 16)}); !errors.Is(err, ErrStream) {
		t.Fatalf("zero write error = %v", err)
	}

	tests := []struct {
		name    string
		message MessageType
		payload []byte
	}{
		{name: "empty terminal", message: TypeTermInput},
		{name: "long terminal", message: TypeTermOutput, payload: make([]byte, MaxTerminalPayload+1)},
		{name: "short resize", message: TypeTermResize, payload: []byte{0}},
		{name: "invalid resize", message: TypeTermResize, payload: []byte{0, 19, 0, 4}},
		{name: "zero game sequence", message: TypeGameInput, payload: make([]byte, 24)},
		{name: "nan game vector", message: TypeGameInput, payload: gameInputWith(1, math.Float32frombits(0x7fc00000), 0, 0)},
		{name: "long game vector", message: TypeGameInput, payload: gameInputWith(1, 1, 1, 0)},
		{name: "game flags", message: TypeGameInput, payload: gameInputWith(1, 0, 0, 2)},
		{name: "snapshot sequence", message: TypeGameSnapshot, payload: make([]byte, 44)},
		{name: "snapshot remaining", message: TypeGameSnapshot, payload: snapshotWith(func(value []byte) { binary.BigEndian.PutUint32(value[32:36], 45_001) })},
		{name: "snapshot cooldown", message: TypeGameSnapshot, payload: snapshotWith(func(value []byte) { binary.BigEndian.PutUint32(value[36:40], 5_001) })},
		{name: "snapshot mask", message: TypeGameSnapshot, payload: snapshotWith(func(value []byte) { value[40] = 4 })},
		{name: "snapshot phase", message: TypeGameSnapshot, payload: snapshotWith(func(value []byte) { value[41] = 3 })},
		{name: "snapshot exit", message: TypeGameSnapshot, payload: snapshotWith(func(value []byte) { value[42] = 1 })},
		{name: "snapshot reserved", message: TypeGameSnapshot, payload: snapshotWith(func(value []byte) { value[43] = 1 })},
		{name: "snapshot coordinate", message: TypeGameSnapshot, payload: snapshotWith(func(value []byte) { binary.BigEndian.PutUint32(value[16:20], math.Float32bits(48)) })},
		{name: "json scalar", message: TypeError, payload: []byte(`1`)},
		{name: "json trailing", message: TypeClose, payload: []byte(`{} {}`)},
		{name: "json duplicate nested", message: TypeGameInit, payload: []byte(`{"x":{"a":1,"a":2}}`)},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if err := WriteFrame(context.Background(), &shortWriteCloser{maximum: 64}, senderFor(test.message), stateFor(test.message), Frame{Type: test.message, Payload: test.payload}); err == nil {
				t.Fatal("invalid payload was accepted")
			}
		})
	}
}

func TestHandshakeValidationRejectsInvalidFields(t *testing.T) {
	validHello := `{"protocol_min":1,"protocol_max":1,"session_id":"000102030405060708090a0b0c0d0e0f","mode":"escape","client":{"name":"tailmouse-web","version":"0.1.0","platform":"test","user_agent":""}}`
	helloCases := []string{
		`{}`,
		strings.Replace(validHello, `"protocol_min":1`, `"protocol_min":0`, 1),
		strings.Replace(validHello, `"protocol_max":1`, `"protocol_max":0`, 1),
		strings.Replace(validHello, `"mode":"escape"`, `"mode":"admin"`, 1),
		strings.Replace(validHello, `000102030405060708090a0b0c0d0e0f`, `000102030405060708090A0B0C0D0E0F`, 1),
		strings.Replace(validHello, `"name":"tailmouse-web"`, `"name":""`, 1),
		strings.Replace(validHello, `"platform":"test"`, `"platform":""`, 1),
		strings.TrimSuffix(validHello, "}") + `,"terminal":{"cols":19,"rows":4}}`,
		strings.Replace(validHello, `"user_agent":""`, `"user_agent":"x","extra":1`, 1),
	}
	for index, payload := range helloCases {
		if _, err := validateClientHello([]byte(payload)); err == nil {
			t.Fatalf("invalid hello %d was accepted", index)
		}
	}

	validWelcome := `{"protocol":1,"mode":"leash","session_state":"active","expires_at":1,"relay":{"mode":"official","host":"tc301a.ipn.dev","browser_path":"derp"},"capabilities":["terminal_output"]}`
	welcomeCases := []string{
		`{}`,
		strings.Replace(validWelcome, `"protocol":1`, `"protocol":2`, 1),
		strings.Replace(validWelcome, `"mode":"leash"`, `"mode":"admin"`, 1),
		strings.Replace(validWelcome, `"session_state":"active"`, `"session_state":"closed"`, 1),
		strings.Replace(validWelcome, `"browser_path":"derp"`, `"browser_path":"udp"`, 1),
		strings.Replace(validWelcome, `tc301a.ipn.dev`, `https://invalid`, 1),
		strings.Replace(validWelcome, `tc301a.ipn.dev`, `mouse_1.invalid`, 1),
		strings.Replace(validWelcome, `["terminal_output"]`, `["terminate","resize"]`, 1),
		strings.Replace(validWelcome, `["terminal_output"]`, `["terminal_output","terminal_output"]`, 1),
		strings.Replace(validWelcome, `"browser_path":"derp"`, `"browser_path":"derp","extra":1`, 1),
	}
	for index, payload := range welcomeCases {
		if _, err := validateServerWelcome([]byte(payload)); err == nil {
			t.Fatalf("invalid welcome %d was accepted", index)
		}
	}
}

func TestJSONNumberNullAndNestingInteroperability(t *testing.T) {
	hello := string(fixturePayload(t, "valid-client-hello-v1"))
	numericHello := strings.ReplaceAll(strings.ReplaceAll(hello, `"protocol_min":1`, `"protocol_min":1e0`), `"protocol_max":1`, `"protocol_max":1.0`)
	if selected, err := validateClientHello([]byte(numericHello)); err != nil || selected != 1 {
		t.Fatalf("integral JSON number spelling: selected %d, error %v", selected, err)
	}
	nullTerminal := strings.TrimSuffix(hello, "}") + `,"terminal":null}`
	if _, err := validateClientHello([]byte(nullTerminal)); err == nil {
		t.Fatal("null terminal was accepted")
	}
	nullUserAgent := strings.Replace(hello, `"user_agent":"synthetic-test-agent"`, `"user_agent":null`, 1)
	if _, err := validateClientHello([]byte(nullUserAgent)); err == nil {
		t.Fatal("null user agent was accepted")
	}
	welcome := string(fixturePayload(t, "valid-server-welcome-v1"))
	nullExpiry := strings.Replace(welcome, `"expires_at":1788252800`, `"expires_at":null`, 1)
	if _, err := validateServerWelcome([]byte(nullExpiry)); err == nil {
		t.Fatal("null expiration was accepted")
	}
	unsafeInteger := strings.Replace(welcome, `"expires_at":1788252800`, `"expires_at":9007199254740992`, 1)
	if _, err := validateServerWelcome([]byte(unsafeInteger)); err == nil {
		t.Fatal("unsafe JSON integer was accepted")
	}
	deep := `{"x":` + strings.Repeat("[", 32) + "0" + strings.Repeat("]", 32) + "}"
	if _, err := strictJSONObject([]byte(deep)); err == nil {
		t.Fatal("over-depth JSON was accepted")
	}
}

func TestGameVectorFloat32RoundingInteroperability(t *testing.T) {
	if _, err := validatePayload(TypeGameInput, gameInputWith(1, 0.6, 0.8, 0), PeerBrowser); err != nil {
		t.Fatalf("normalized f32 vector was rejected: %v", err)
	}
}

type chunkReadCloser struct {
	data      []byte
	fragments []int
	offset    int
	fragment  int
	remaining int
	closed    bool
}

func newChunkReadCloser(data []byte, fragments []int) *chunkReadCloser {
	return &chunkReadCloser{data: data, fragments: fragments}
}

func (reader *chunkReadCloser) Read(output []byte) (int, error) {
	if reader.closed || reader.offset == len(reader.data) {
		return 0, io.EOF
	}
	limit := len(output)
	if len(reader.fragments) > 0 {
		if reader.remaining == 0 {
			reader.remaining = reader.fragments[reader.fragment]
			reader.fragment++
		}
		limit = min(limit, reader.remaining)
	}
	limit = min(limit, len(reader.data)-reader.offset)
	copy(output, reader.data[reader.offset:reader.offset+limit])
	reader.offset += limit
	reader.remaining -= limit
	return limit, nil
}

func (reader *chunkReadCloser) Close() error {
	reader.closed = true
	return nil
}

type shortWriteCloser struct {
	bytes.Buffer
	maximum int
	closed  bool
}

func (writer *shortWriteCloser) Write(value []byte) (int, error) {
	if writer.maximum < 0 {
		return 0, nil
	}
	if writer.maximum > 0 && len(value) > writer.maximum {
		value = value[:writer.maximum]
	}
	return writer.Buffer.Write(value)
}

func (writer *shortWriteCloser) Close() error {
	writer.closed = true
	return nil
}

type failingWriteCloser struct{}

func (*failingWriteCloser) Write([]byte) (int, error) {
	return 0, errors.New("credential-shaped upstream failure")
}
func (*failingWriteCloser) Close() error { return nil }

func fixturePeer(t *testing.T, value string) Peer {
	t.Helper()
	if value == "host" {
		return PeerHost
	}
	if value == "browser" {
		return PeerBrowser
	}
	t.Fatalf("unknown fixture peer %q", value)
	return 0
}

func fixtureState(t *testing.T, value string) State {
	t.Helper()
	states := map[string]State{
		"await-client-hello":   StateAwaitClientHello,
		"await-server-welcome": StateAwaitServerWelcome,
		"active-escape":        StateActiveEscape,
		"active-leash":         StateActiveLeash,
	}
	state, ok := states[value]
	if !ok {
		t.Fatalf("unknown fixture state %q", value)
	}
	return state
}

func fixturePayload(t *testing.T, identifier string) []byte {
	t.Helper()
	_, corpus := loadFixtureCorpus(t)
	for _, fixture := range corpus.Cases {
		if fixture.ID == identifier {
			wire := materializeFixture(t, fixture.Wire)
			return wire[6:]
		}
	}
	t.Fatalf("fixture %q is missing", identifier)
	return nil
}

func validGameInput() []byte {
	return gameInputWith(1, 0.75, -0.25, 1)
}

func gameInputWith(sequence uint32, velocityX, velocityY float32, flags byte) []byte {
	payload := make([]byte, 24)
	binary.BigEndian.PutUint32(payload[0:4], sequence)
	binary.BigEndian.PutUint32(payload[12:16], math.Float32bits(velocityX))
	binary.BigEndian.PutUint32(payload[16:20], math.Float32bits(velocityY))
	payload[20] = flags
	return payload
}

func validGameSnapshot() []byte {
	payload := make([]byte, 44)
	binary.BigEndian.PutUint32(payload[0:4], 1)
	for offset, coordinate := range map[int]float32{16: 4.5, 20: 3.5, 24: 10.5, 28: 7.5} {
		binary.BigEndian.PutUint32(payload[offset:offset+4], math.Float32bits(coordinate))
	}
	payload[41] = 1
	return payload
}

func snapshotWith(change func([]byte)) []byte {
	payload := validGameSnapshot()
	change(payload)
	return payload
}

func senderFor(message MessageType) Peer {
	if message == TypeTermInput || message == TypeTermResize || message == TypeProcessControl || message == TypeGameInput || message == TypeGameEvent {
		return PeerBrowser
	}
	return PeerHost
}

func stateFor(message MessageType) State {
	if isTerminalMessage(message) {
		return StateActiveLeash
	}
	if isEscapeMessageType(message) {
		return StateActiveEscape
	}
	return StateActiveEscape
}
