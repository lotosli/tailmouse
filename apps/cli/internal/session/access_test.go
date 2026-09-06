package session

import (
	"bytes"
	"encoding/base64"
	"errors"
	"io"
	"testing"
)

func TestAccessCodeGenerationAndGrouping(t *testing.T) {
	generated, err := GenerateAccessCode()
	if err != nil {
		t.Fatal(err)
	}
	for _, symbol := range generated {
		if !validAccessSymbol(symbol) {
			t.Fatal("secure generator returned a symbol outside the alphabet")
		}
	}
	code, err := newAccessCode(bytes.NewReader([]byte{0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15}))
	if err != nil || code.Grouped() != "2345-6789-ABCD-EFGH" {
		t.Fatalf("deterministic access code: %q, %v", code.Grouped(), err)
	}
	var counts [32]int
	entropy := make([]byte, 256)
	for index := range entropy {
		entropy[index] = byte(index)
	}
	reader := bytes.NewReader(entropy)
	for range 16 {
		code, err := newAccessCode(reader)
		if err != nil {
			t.Fatal(err)
		}
		for _, symbol := range code {
			counts[bytes.IndexByte([]byte(accessAlphabet), symbol)]++
		}
	}
	for _, count := range counts {
		if count != 8 {
			t.Fatal("byte-to-symbol mapping is biased")
		}
	}
	if code, err := newAccessCode(errorReader{}); !errors.Is(err, ErrInvalidAccessCode) || code != (AccessCode{}) {
		t.Fatal("entropy failure returned a credential")
	}
	if code, err := newAccessCode(nil); !errors.Is(err, ErrInvalidAccessCode) || code != (AccessCode{}) {
		t.Fatal("nil entropy source returned a credential")
	}
	if challenge, err := newAccessChallenge(errorReader{}); !errors.Is(err, ErrInvalidAccessCode) || challenge != ([32]byte{}) {
		t.Fatal("challenge entropy failure returned authentication state")
	}
}

func TestAccessCodeCanonicalization(t *testing.T) {
	for _, input := range []string{
		"23456789ABCDEFGH",
		"2345-6789-ABCD-EFGH",
		" 2345 6789 abcd efgh ",
	} {
		code, err := CanonicalAccessCode(input)
		if err != nil || code.Grouped() != "2345-6789-ABCD-EFGH" {
			t.Fatalf("canonical access code rejected: %q", input)
		}
	}
	for _, input := range []string{
		"23456789ABCDEFG",
		"23456789ABCDEFGHH",
		"23456789ABCDEFIH",
		"23456789ABCDEF0H",
		"2345_6789_ABCD_EFGH",
		"2345\t6789 ABCD EFGH",
		"２３４５６７８９ＡＢＣＤＥＦＧＨ",
	} {
		if code, err := CanonicalAccessCode(input); !errors.Is(err, ErrInvalidAccessCode) || code != (AccessCode{}) {
			t.Fatalf("invalid access code accepted: %q", input)
		}
	}
}

func TestAccessProofVectorAndBinding(t *testing.T) {
	code, err := CanonicalAccessCode("2345-6789-ABCD-EFGH")
	if err != nil {
		t.Fatal(err)
	}
	var sessionID [16]byte
	var challenge [32]byte
	for index := range sessionID {
		sessionID[index] = byte(index)
	}
	for index := range challenge {
		challenge[index] = byte(index)
	}
	proof := AccessProof(code, sessionID, challenge)
	if base64.RawURLEncoding.EncodeToString(proof[:]) != "V0OMGOWhH9n8r-cwHjkH06dDCyNQrZQgrlxJXDmzl4s" {
		t.Fatal("access proof does not match the protocol vector")
	}
	if !VerifyAccessProof(code, sessionID, challenge, proof) {
		t.Fatal("complete valid proof was rejected")
	}
	for _, mutate := range []func(*[16]byte, *[32]byte, *[32]byte){
		func(identifier *[16]byte, _ *[32]byte, _ *[32]byte) { identifier[0] ^= 1 },
		func(_ *[16]byte, value *[32]byte, _ *[32]byte) { value[31] ^= 1 },
		func(_ *[16]byte, _ *[32]byte, value *[32]byte) { value[0] ^= 1 },
		func(_ *[16]byte, _ *[32]byte, value *[32]byte) { value[31] ^= 1 },
	} {
		otherSession, otherChallenge, otherProof := sessionID, challenge, proof
		mutate(&otherSession, &otherChallenge, &otherProof)
		if VerifyAccessProof(code, otherSession, otherChallenge, otherProof) {
			t.Fatal("replayed, cross-session, or incomplete proof was accepted")
		}
	}
}

type errorReader struct{}

func (errorReader) Read([]byte) (int, error) { return 0, io.ErrUnexpectedEOF }
