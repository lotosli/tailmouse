package invitation

import (
	"bytes"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/fxamacker/cbor/v2"
)

func TestMouseCardModeProtocolCorpus(t *testing.T) {
	_, source, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("cannot locate shared MouseCard corpus")
	}
	data, err := os.ReadFile(filepath.Join(filepath.Dir(source), "..", "..", "..", "..", "protocol", "fixtures", "v1", "mousecards.json"))
	if err != nil {
		t.Fatal(err)
	}
	var corpus struct {
		Cases []struct {
			ID          string `json:"id"`
			Accept      bool   `json:"accept"`
			Mode        Mode   `json:"mode"`
			ProtocolMin uint16 `json:"protocolMin"`
			ProtocolMax uint16 `json:"protocolMax"`
			Hex         string `json:"hex"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(data, &corpus); err != nil || len(corpus.Cases) != 6 {
		t.Fatal("invalid shared MouseCard corpus")
	}
	for _, fixture := range corpus.Cases {
		t.Run(fixture.ID, func(t *testing.T) {
			payload, err := hex.DecodeString(fixture.Hex)
			if err != nil {
				t.Fatal(err)
			}
			card, err := Decode(payload, time.Unix(1700000000, 0))
			if !fixture.Accept {
				if !errors.Is(err, ErrInvalidCard) || card != (MouseCard{}) {
					t.Fatal("invalid range returned a card")
				}
				return
			}
			if err != nil || card.Mode != fixture.Mode || card.ProtocolMin != fixture.ProtocolMin || card.ProtocolMax != fixture.ProtocolMax {
				t.Fatal("exact mode-specific protocol identifier was not preserved")
			}
			if !bytes.Equal(mustEncodeCard(t, card), payload) {
				t.Fatal("compatible card did not round-trip canonically")
			}
		})
	}
}

func TestDecodeCanonicalMouseCardAndFragment(t *testing.T) {
	card := validTestCard(t, ModeLeash)
	payload, err := Encode(card)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Unix(1_700_000_000, 0)
	decoded, err := Decode(payload, now)
	if err != nil || decoded != card {
		t.Fatalf("canonical decode failed: %v", err)
	}
	fragment := "#/v1/" + base64.RawURLEncoding.EncodeToString(payload)
	decoded, err = ParseFragment(fragment, now)
	if err != nil || decoded != card {
		t.Fatalf("fragment decode failed: %v", err)
	}
	if !bytes.Equal(payload, mustEncodeCard(t, decoded)) {
		t.Fatal("decoding changed canonical input bytes")
	}
}

func TestDecodeRejectsMalformedAndNonCanonicalCards(t *testing.T) {
	card := validTestCard(t, ModeLeash)
	canonical := mustEncodeCard(t, card)
	nonMinimalInteger := append([]byte{}, canonical[:3]...)
	nonMinimalInteger = append(nonMinimalInteger, 0x18, 0x01)
	nonMinimalInteger = append(nonMinimalInteger, canonical[4:]...)

	cases := [][]byte{
		nil,
		make([]byte, MaxCardBytes+1),
		append(bytes.Clone(canonical), 0),
		append([]byte{0xd9, 0xd9, 0xf7}, canonical...),
		nonMinimalInteger,
		encodeCardFields(t, card, func(fields map[string]any) { delete(fields, "e") }),
		encodeCardFields(t, card, func(fields map[string]any) { fields["extra"] = true }),
		encodeCardFields(t, card, func(fields map[string]any) {
			fields["s"] = []int{1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16}
		}),
		encodeCardFields(t, card, func(fields map[string]any) { fields["e"] = -1 }),
		encodeCardFields(t, card, func(fields map[string]any) { fields["e"] = 1.5 }),
		encodeCardFields(t, card, func(fields map[string]any) { fields["e"] = uint64(MaxExpiryUnixSeconds + 1) }),
		encodeCardFields(t, card, func(fields map[string]any) { fields["p"] = 80 }),
		encodeCardFields(t, card, func(fields map[string]any) { fields["a"] = 1 }),
		encodeCardFields(t, card, func(fields map[string]any) { fields["m"] = "admin" }),
		encodeCardFields(t, card, func(fields map[string]any) { fields["s"] = make([]byte, 16) }),
	}
	for index, payload := range cases {
		decoded, err := Decode(payload, time.Unix(1_700_000_000, 0))
		if !errors.Is(err, ErrInvalidCard) || decoded != (MouseCard{}) {
			t.Fatalf("case %d returned a card or wrong error: %v", index, err)
		}
		if strings.Contains(err.Error(), syntheticAddress) {
			t.Fatalf("case %d disclosed invitation input", index)
		}
	}
}

func TestDecodeExpirationAndUnlimitedHostLifetime(t *testing.T) {
	card := validTestCard(t, ModeLeash)
	if _, err := Decode(mustEncodeCard(t, card), time.Unix(card.ExpiresAt, 0)); !errors.Is(err, ErrExpired) {
		t.Fatalf("expiration boundary error = %v", err)
	}
	card.ExpiresAt = 0
	if decoded, err := Decode(mustEncodeCard(t, card), time.Unix(2_000_000_000, 0)); err != nil || decoded.ExpiresAt != 0 {
		t.Fatalf("unlimited host lifetime: %v", err)
	}
}

func TestParseFragmentRejectsUnboundedOrNonCanonicalInput(t *testing.T) {
	cases := []string{
		"", "#/v2/a", "#/v1/", "#/v1/A", "#/v1/AB", "#/v1/AA=", "#/v1/AA\n", "#/v1/AA+", "#/v1/" + strings.Repeat("a", 1400),
	}
	for index, fragment := range cases {
		if _, err := ParseFragment(fragment, time.Unix(1_700_000_000, 0)); !errors.Is(err, ErrInvalidCard) {
			t.Fatalf("fragment %d error = %v", index, err)
		}
	}
}

func FuzzDecodeMouseCard(f *testing.F) {
	f.Add([]byte{0xa8})
	f.Add([]byte{0xa1, 0x61, 0x76, 0x01})
	canonical, err := Encode(MouseCard{
		Version: CardVersion, Mode: ModeLeash, TailcatAddr: syntheticAddress,
		Port: VirtualPort, SessionID: [16]byte{1}, ExpiresAt: 1_700_000_600,
		ProtocolMin: ProtocolVersion, ProtocolMax: ProtocolVersion,
	})
	if err != nil {
		f.Fatal(err)
	}
	f.Add(canonical)
	f.Fuzz(func(t *testing.T, payload []byte) {
		card, err := Decode(payload, time.Unix(1_700_000_000, 0))
		if err == nil && !validCard(card) {
			t.Fatal("decoder returned an invalid card")
		}
	})
}

func FuzzParseFragment(f *testing.F) {
	f.Add("#/v1/")
	f.Add("#/v1/AB")
	f.Add("#/v1/not+base64")
	f.Fuzz(func(t *testing.T, fragment string) {
		card, err := ParseFragment(fragment, time.Unix(1_700_000_000, 0))
		if err == nil && !validCard(card) {
			t.Fatal("fragment parser returned an invalid card")
		}
		if err != nil && !errors.Is(err, ErrInvalidCard) && !errors.Is(err, ErrExpired) {
			t.Fatal("fragment parser returned an unsafe error")
		}
	})
}

func mustEncodeCard(t *testing.T, card MouseCard) []byte {
	t.Helper()
	payload, err := Encode(card)
	if err != nil {
		t.Fatal(err)
	}
	return payload
}

func encodeCardFields(t *testing.T, card MouseCard, change func(map[string]any)) []byte {
	t.Helper()
	fields := map[string]any{
		"a": card.ProtocolMin, "e": card.ExpiresAt, "m": card.Mode, "p": card.Port,
		"s": card.SessionID[:], "t": card.TailcatAddr, "v": card.Version, "z": card.ProtocolMax,
	}
	change(fields)
	encoder, err := cbor.CanonicalEncOptions().EncMode()
	if err != nil {
		t.Fatal(err)
	}
	payload, err := encoder.Marshal(fields)
	if err != nil {
		t.Fatal(err)
	}
	return payload
}
