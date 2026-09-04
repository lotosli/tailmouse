package invitation

import (
	"bytes"
	"encoding/base64"
	"strings"
	"time"

	"github.com/fxamacker/cbor/v2"
)

var cardDecoder, cardDecoderErr = (cbor.DecOptions{
	DupMapKey:         cbor.DupMapKeyEnforcedAPF,
	MaxNestedLevels:   4,
	MaxArrayElements:  16,
	MaxMapPairs:       16,
	IndefLength:       cbor.IndefLengthForbidden,
	TagsMd:            cbor.TagsForbidden,
	ExtraReturnErrors: cbor.ExtraDecErrorUnknownField,
}).DecMode()

// Decode accepts exactly the canonical MouseCard v1 representation. It returns
// no partial card or original decoder text on malformed or expired input.
func Decode(payload []byte, now time.Time) (MouseCard, error) {
	if len(payload) == 0 || len(payload) > MaxCardBytes || payload[0] != 0xa8 || cardDecoderErr != nil {
		return MouseCard{}, ErrInvalidCard
	}
	var fields map[string]cbor.RawMessage
	if err := cardDecoder.Unmarshal(payload, &fields); err != nil || len(fields) != 8 {
		return MouseCard{}, ErrInvalidCard
	}
	majorTypes := map[string]byte{"a": 0, "e": 0, "m": 3, "p": 0, "s": 2, "t": 3, "v": 0, "z": 0}
	for key, majorType := range majorTypes {
		value, exists := fields[key]
		if !exists || len(value) == 0 || value[0]>>5 != majorType {
			return MouseCard{}, ErrInvalidCard
		}
	}
	var card MouseCard
	if err := cardDecoder.Unmarshal(payload, &card); err != nil || !validCard(card) {
		return MouseCard{}, ErrInvalidCard
	}
	canonical, err := Encode(card)
	if err != nil {
		return MouseCard{}, ErrInvalidCard
	}
	defer erase(canonical)
	if !bytes.Equal(payload, canonical) {
		return MouseCard{}, ErrInvalidCard
	}
	if card.ExpiresAt != 0 && now.Unix() >= card.ExpiresAt {
		return MouseCard{}, ErrExpired
	}
	return card, nil
}

// ParseFragment decodes a fragment without accepting padding, ignored newline
// characters, or non-canonical trailing base64 bits.
func ParseFragment(fragment string, now time.Time) (MouseCard, error) {
	const prefix = "#/v1/"
	if len(fragment) >= MaxInvitationBytes || !strings.HasPrefix(fragment, prefix) {
		return MouseCard{}, ErrInvalidCard
	}
	encoded := strings.TrimPrefix(fragment, prefix)
	if encoded == "" || base64.RawURLEncoding.DecodedLen(len(encoded)) > MaxCardBytes {
		return MouseCard{}, ErrInvalidCard
	}
	for _, character := range encoded {
		if !(character >= 'A' && character <= 'Z' || character >= 'a' && character <= 'z' ||
			character >= '0' && character <= '9' || character == '-' || character == '_') {
			return MouseCard{}, ErrInvalidCard
		}
	}
	payload, err := base64.RawURLEncoding.Strict().DecodeString(encoded)
	defer erase(payload)
	if err != nil {
		return MouseCard{}, ErrInvalidCard
	}
	return Decode(payload, now)
}
