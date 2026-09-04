package protocol

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"math"
	"strings"
	"testing"
)

func TestTypedGameCodecsConsumeTheSharedGoldenCorpus(t *testing.T) {
	_, corpus := loadFixtureCorpus(t)
	seen := map[MessageType]bool{}
	for _, fixture := range corpus.Cases {
		wire := materializeFixture(t, fixture.Wire)
		if len(wire) < 6 || wire[4] < byte(TypeGameInit) || wire[4] > byte(TypeGameResult) || fixture.State != "active-escape" {
			continue
		}
		frame := Frame{Type: MessageType(wire[4]), Payload: wire[6:]}
		sender := PeerHost
		if fixture.Receiver == "host" {
			sender = PeerBrowser
		}
		t.Run(fixture.ID, func(t *testing.T) {
			encoded, err := typedGameRoundTrip(frame, sender)
			if !fixture.Expect.Accepted {
				if code, ok := ErrorCodeOf(err); !ok || code != ErrorCode(fixture.Expect.Error) {
					t.Fatalf("invalid payload classification: %v", err)
				}
				if encoded.Type != 0 || len(encoded.Payload) != 0 {
					t.Fatal("rejected payload returned partial state")
				}
				return
			}
			if err != nil || encoded.Type != frame.Type || !bytes.Equal(encoded.Payload, frame.Payload) {
				t.Fatalf("typed golden round trip differs: %v", err)
			}
			seen[frame.Type] = true
		})
	}
	if len(seen) != 5 {
		t.Fatal("shared corpus did not exercise all five typed game codecs")
	}
}

func typedGameRoundTrip(frame Frame, sender Peer) (Frame, error) {
	switch frame.Type {
	case TypeGameInit:
		value, err := DecodeGameInit(frame)
		if err != nil {
			return Frame{}, err
		}
		return GameInitFrame(value)
	case TypeGameInput:
		value, err := DecodeGameInput(frame)
		if err != nil {
			return Frame{}, err
		}
		return GameInputFrame(value)
	case TypeGameSnapshot:
		value, err := DecodeGameSnapshot(frame)
		if err != nil {
			return Frame{}, err
		}
		return GameSnapshotFrame(value)
	case TypeGameEvent:
		value, err := DecodeGameEvent(frame, sender)
		if err != nil {
			return Frame{}, err
		}
		return GameEventFrame(value, sender)
	default:
		value, err := DecodeGameResult(frame)
		if err != nil {
			return Frame{}, err
		}
		return GameResultFrame(value)
	}
}

func TestGameDecodersRejectWrongTypesLengthsAndPartialValues(t *testing.T) {
	for _, message := range []MessageType{TypeGameInit, TypeGameInput, TypeGameSnapshot, TypeGameEvent, TypeGameResult} {
		for _, size := range []int{0, 1, 2, 23, 25, 43, 45, 16385} {
			payload := bytes.Repeat([]byte{' '}, size)
			_, err := typedGameRoundTrip(Frame{Type: message, Payload: payload}, PeerHost)
			if err == nil {
				t.Fatalf("accepted blank/truncated game payload %s/%d", message, size)
			}
		}
	}
	wrong := Frame{Type: TypePing, Payload: []byte(`{}`)}
	if _, err := DecodeGameInit(wrong); err == nil {
		t.Fatal("init type unchecked")
	}
	if _, err := DecodeGameInput(wrong); err == nil {
		t.Fatal("input type unchecked")
	}
	if _, err := DecodeGameSnapshot(wrong); err == nil {
		t.Fatal("snapshot type unchecked")
	}
	if _, err := DecodeGameEvent(wrong, PeerHost); err == nil {
		t.Fatal("event type unchecked")
	}
	if _, err := DecodeGameResult(wrong); err == nil {
		t.Fatal("result type unchecked")
	}
	event := Frame{Type: TypeGameEvent, Payload: fixturePayload(t, "game-event-countdown")}
	if _, err := DecodeGameEvent(event, Peer(0)); err == nil {
		t.Fatal("event accepted an unknown sender")
	}
}

func TestGameJSONIntegralSpellingsAndRequiredNulls(t *testing.T) {
	initial := fixturePayload(t, "game-init-canonical")
	spelled := bytes.ReplaceAll(initial, []byte(`"width":48`), []byte(`"width":4.8e1`))
	spelled = bytes.ReplaceAll(spelled, []byte(`"round_duration_ms":45000`), []byte(`"round_duration_ms":45000.0`))
	if _, err := DecodeGameInit(Frame{Type: TypeGameInit, Payload: spelled}); err != nil {
		t.Fatal(err)
	}
	for _, replacement := range []string{`"mouse":null`, `"mouse":{"x":3.5}`, `"mouse":{"x":3.5,"y":null}`, `"mouse":{"x":48,"y":3.5}`, `"mouse":{"x":-1,"y":3.5}`} {
		payload := bytes.Replace(initial, []byte(`"mouse":{"x":3.5,"y":3.5}`), []byte(replacement), 1)
		if _, err := DecodeGameInit(Frame{Type: TypeGameInit, Payload: payload}); err == nil {
			t.Fatalf("accepted %s", replacement)
		}
	}
	result := fixturePayload(t, "game-result-escaped")
	for _, field := range []string{"elapsed_ms", "rtt_p50_ms", "rtt_p95_ms"} {
		var object map[string]any
		if err := json.Unmarshal(result, &object); err != nil {
			t.Fatal(err)
		}
		object[field] = "0"
		payload, err := json.Marshal(object)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := DecodeGameResult(Frame{Type: TypeGameResult, Payload: payload}); err == nil {
			t.Fatal("accepted a numeric string")
		}
	}
}

func TestGameEncodersFailClosedAndDoNotLeakValues(t *testing.T) {
	initial, err := DecodeGameInit(Frame{Type: TypeGameInit, Payload: fixturePayload(t, "game-init-canonical")})
	if err != nil {
		t.Fatal(err)
	}
	initial.Seed = "untrusted-peer-text"
	if frame, err := GameInitFrame(initial); err == nil || frame.Type != 0 || strings.Contains(err.Error(), initial.Seed) {
		t.Fatal("invalid init leaked")
	}
	initial.Mouse.X = math.NaN()
	if _, err := GameInitFrame(initial); err == nil {
		t.Fatal("encoded NaN")
	}
	for _, value := range []GameInput{{}, {Sequence: 1, VelocityX: float32(math.Inf(1))}, {Sequence: 1, VelocityX: 1, VelocityY: 1}} {
		if _, err := GameInputFrame(value); err == nil {
			t.Fatal("invalid input encoded")
		}
	}
	for _, value := range []GameSnapshot{{}, {Sequence: 1, Mouse: GamePoint{X: -1}}, {Sequence: 1, Cat: GamePoint{Y: math.Inf(1)}}, {Sequence: 1, Mouse: GamePoint{X: 47.999999999}}} {
		if _, err := GameSnapshotFrame(value); err == nil {
			t.Fatal("invalid or rounded-out-of-bounds snapshot encoded")
		}
	}
	if _, err := GameEventFrame(GameEvent{Sequence: 1, Event: "exit_requested"}, PeerHost); err == nil {
		t.Fatal("event direction unchecked")
	}
	result, err := DecodeGameResult(Frame{Type: TypeGameResult, Payload: fixturePayload(t, "game-result-escaped")})
	if err != nil {
		t.Fatal(err)
	}
	result.Message = "untrusted-peer-text"
	if _, err := GameResultFrame(result); err == nil || strings.Contains(err.Error(), result.Message) {
		t.Fatal("result prose leaked")
	}
	result.Message = GameResultMessage("escaped", math.MaxInt64)
	result.ElapsedMS = math.NaN()
	if _, err := GameResultFrame(result); err == nil {
		t.Fatal("result NaN encoded")
	}
}

func TestGameBinaryValuesKeepAllBitsAndDoNotAliasInput(t *testing.T) {
	for _, timestamp := range []uint64{0, 1, 1<<53 + 1, math.MaxUint64} {
		for _, sequence := range []uint32{1, 300, math.MaxUint32} {
			for _, dash := range []bool{false, true} {
				value := GameInput{sequence, timestamp, 0.6, -0.8, dash}
				frame, err := GameInputFrame(value)
				if err != nil {
					t.Fatal(err)
				}
				decoded, err := DecodeGameInput(frame)
				if err != nil || decoded != value {
					t.Fatal("input value lost bits")
				}
				clear(frame.Payload)
				if decoded != value {
					t.Fatal("input retained mutable bytes")
				}
			}
			for mask := uint8(0); mask < 4; mask++ {
				for phase := uint8(0); phase < 3; phase++ {
					value := GameSnapshot{Sequence: sequence, ElapsedMS: timestamp, Mouse: GamePoint{3.5, 3.5}, Cat: GamePoint{40.5, 14.5}, CollectedMask: mask, Phase: phase, ExitOpen: mask == 3}
					frame, err := GameSnapshotFrame(value)
					if err != nil {
						t.Fatal(err)
					}
					decoded, err := DecodeGameSnapshot(frame)
					if err != nil || decoded != value {
						t.Fatal("snapshot value lost bits")
					}
				}
			}
		}
	}
}

func FuzzGamePayloads(f *testing.F) {
	_, corpus := loadFixtureCorpus(f)
	for _, fixture := range corpus.Cases {
		wire := materializeFixture(f, fixture.Wire)
		if len(wire) >= 6 && wire[4] >= 0x20 && wire[4] <= 0x24 {
			f.Add(wire[4], fixture.Receiver == "host", wire[6:])
		}
	}
	f.Fuzz(func(t *testing.T, message byte, fromBrowser bool, payload []byte) {
		if len(payload) > MaxControlPayload || message < 0x20 || message > 0x24 {
			return
		}
		sender := PeerHost
		if fromBrowser {
			sender = PeerBrowser
		}
		frame, err := typedGameRoundTrip(Frame{Type: MessageType(message), Payload: payload}, sender)
		if err != nil {
			if _, ok := ErrorCodeOf(err); !ok {
				t.Fatalf("unclassified game failure: %T", err)
			}
			return
		}
		if len(frame.Payload) > MaxControlPayload {
			t.Fatal("encoding exceeded bound")
		}
		second, err := typedGameRoundTrip(frame, sender)
		if err != nil || !bytes.Equal(frame.Payload, second.Payload) {
			t.Fatal("canonical round trip is not stable")
		}
		if message == byte(TypeGameInput) && binary.BigEndian.Uint64(frame.Payload[4:]) != binary.BigEndian.Uint64(payload[4:]) {
			t.Fatal("lost u64 bits")
		}
	})
}
