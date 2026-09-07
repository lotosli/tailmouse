package invitation

import (
	"bytes"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"net/url"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/fxamacker/cbor/v2"
)

const syntheticAddress = "tcSyntheticFullConnBlobCredential"

func TestEncodeMouseCardRoundTrip(t *testing.T) {
	card := validTestCard(t, ModeEscape)
	encoded, err := Encode(card)
	if err != nil {
		t.Fatal(err)
	}
	var decoded MouseCard
	if err := cbor.Unmarshal(encoded, &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded != card {
		t.Fatalf("decoded card = %#v, want %#v", decoded, card)
	}

	var fields map[string]cbor.RawMessage
	if err := cbor.Unmarshal(encoded, &fields); err != nil {
		t.Fatal(err)
	}
	wantKeys := []string{"a", "e", "m", "p", "s", "t", "v", "z"}
	gotKeys := make([]string, 0, len(fields))
	for key := range fields {
		gotKeys = append(gotKeys, key)
	}
	slices.Sort(gotKeys)
	if !slices.Equal(gotKeys, wantKeys) {
		t.Fatalf("CBOR keys = %v, want %v", gotKeys, wantKeys)
	}
	if len(fields["s"]) != 17 || fields["s"][0] != 0x50 {
		t.Fatalf("session ID is not a 16-byte CBOR byte string: %x", fields["s"])
	}
}

func TestNewSessionIDUses128Bits(t *testing.T) {
	seen := make(map[[16]byte]struct{})
	for range 32 {
		identifier, err := NewSessionID()
		if err != nil {
			t.Fatal(err)
		}
		if identifier == [16]byte{} {
			t.Fatal("generated the all-zero session identifier")
		}
		if _, duplicate := seen[identifier]; duplicate {
			t.Fatal("generated a duplicate session identifier")
		}
		seen[identifier] = struct{}{}
	}
}

func TestInvitationUsesFragmentAndContainsFullConnBlob(t *testing.T) {
	card := validTestCard(t, ModeEscape)
	invitation, err := New("https://mouse.example/app", card)
	if err != nil {
		t.Fatal(err)
	}
	defer invitation.Erase()

	invitationURL := string(invitation.url)
	if len(invitationURL) >= MaxInvitationBytes {
		t.Fatalf("invitation length = %d", len(invitationURL))
	}
	parsed, err := url.Parse(invitationURL)
	if err != nil {
		t.Fatal(err)
	}
	if parsed.RawQuery != "" || parsed.Path != "/app/" ||
		!strings.HasPrefix(parsed.Fragment, "/v1/") {
		t.Fatalf("invitation URL = %q", invitationURL)
	}
	payload, err := base64.RawURLEncoding.DecodeString(
		strings.TrimPrefix(parsed.Fragment, "/v1/"),
	)
	if err != nil {
		t.Fatal(err)
	}
	var decoded MouseCard
	if err := cbor.Unmarshal(payload, &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded.TailcatAddr != syntheticAddress || decoded != card {
		t.Fatal("fragment did not retain the complete MouseCard")
	}
}

func TestInvitationRejectsInvalidAndOversizedInputWithoutSecretErrors(t *testing.T) {
	card := validTestCard(t, ModeEscape)
	tests := []struct {
		name string
		base string
		card MouseCard
		want error
	}{
		{name: "relative base", base: "/mouse", card: card, want: ErrInvalidBaseURL},
		{name: "base query", base: "https://mouse.example/?token=secret", card: card, want: ErrInvalidBaseURL},
		{name: "base credential", base: "https://user@mouse.example/", card: card, want: ErrInvalidBaseURL},
		{name: "bad version", base: "https://mouse.example/", card: withCard(card, func(value *MouseCard) { value.Version = 2 }), want: ErrInvalidCard},
		{name: "bad mode", base: "https://mouse.example/", card: withCard(card, func(value *MouseCard) { value.Mode = "admin" }), want: ErrInvalidCard},
		{name: "bad port", base: "https://mouse.example/", card: withCard(card, func(value *MouseCard) { value.Port = 80 }), want: ErrInvalidCard},
		{name: "zero session", base: "https://mouse.example/", card: withCard(card, func(value *MouseCard) { value.SessionID = [16]byte{} }), want: ErrInvalidCard},
		{name: "bad expiry", base: "https://mouse.example/", card: withCard(card, func(value *MouseCard) { value.ExpiresAt = -1 }), want: ErrInvalidCard},
		{name: "wrong mode protocol", base: "https://mouse.example/", card: withCard(card, func(value *MouseCard) { value.ProtocolMin, value.ProtocolMax = 2, 2 }), want: ErrInvalidCard},
		{name: "wide protocol range", base: "https://mouse.example/", card: withCard(card, func(value *MouseCard) { value.ProtocolMax = 2 }), want: ErrInvalidCard},
		{name: "oversized", base: "https://mouse.example/", card: withCard(card, func(value *MouseCard) { value.TailcatAddr = syntheticAddress + strings.Repeat("x", 1400) }), want: ErrInvitationSize},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			invitation, err := New(test.base, test.card)
			if invitation != nil || !errors.Is(err, test.want) {
				t.Fatalf("New() = %v, %v; want nil, %v", invitation, err, test.want)
			}
			if strings.Contains(err.Error(), syntheticAddress) || strings.Contains(err.Error(), "secret") {
				t.Fatalf("error leaked invitation input: %v", err)
			}
		})
	}
}

func TestQRUsesLevelMMinimumDimensionAndQuietZone(t *testing.T) {
	invitation := testInvitation(t, ModeEscape)
	bitmap, err := qrBitmap(invitation.url)
	if err != nil {
		t.Fatal(err)
	}
	if len(bitmap) < 33 || len(bitmap[0]) != len(bitmap) {
		t.Fatalf("QR dimension = %dx%d, want at least 33x33", len(bitmap), len(bitmap[0]))
	}

	assertQRFormatM(t, bitmap)

	bordered := addQuietZone(bitmap)
	if len(bordered) != len(bitmap)+8 {
		t.Fatalf("bordered dimension = %d", len(bordered))
	}
	for row := range bordered {
		for column := range bordered[row] {
			inBorder := row < quietZoneModules || column < quietZoneModules ||
				row >= len(bordered)-quietZoneModules ||
				column >= len(bordered[row])-quietZoneModules
			if inBorder && bordered[row][column] {
				t.Fatalf("quiet zone has a dark module at %d,%d", column, row)
			}
		}
	}
}

// Read the format bits rather than comparing two calls to the same encoder.
// Level M has correction bits 00; the eight entries are its masked BCH words.
func assertQRFormatM(t *testing.T, bitmap [][]bool) {
	t.Helper()
	positions := [][2]int{{8, 0}, {8, 1}, {8, 2}, {8, 3}, {8, 4}, {8, 5}, {8, 7}, {8, 8}, {7, 8}, {5, 8}, {4, 8}, {3, 8}, {2, 8}, {1, 8}, {0, 8}}
	var format uint16
	for bit, position := range positions {
		if bitmap[position[1]][position[0]] {
			format |= 1 << bit
		}
	}
	if !slices.Contains([]uint16{0x5412, 0x5125, 0x5e7c, 0x5b4b, 0x45f9, 0x40ce, 0x4f97, 0x4aa0}, format) {
		t.Fatalf("invalid level-M QR format word: %04x", format)
	}
}

func TestQRPayloadBoundsAndMinimumVersion(t *testing.T) {
	for _, size := range []int{1, 32, 128, 512, MaxInvitationBytes - 1} {
		t.Run(fmt.Sprint(size), func(t *testing.T) {
			bitmap, err := qrBitmap(bytes.Repeat([]byte("a"), size))
			if err != nil || len(bitmap) < 21 || (len(bitmap)-17)%4 != 0 {
				t.Fatal("valid bounded content did not produce a valid QR version")
			}
			for _, row := range bitmap {
				if len(row) != len(bitmap) {
					t.Fatal("QR is not square")
				}
			}
			assertQRFormatM(t, bitmap)
		})
	}
	for _, size := range []int{0, MaxInvitationBytes, MaxInvitationBytes + 1} {
		bitmap, err := qrBitmap(bytes.Repeat([]byte("a"), size))
		if !errors.Is(err, ErrQR) || bitmap != nil {
			t.Fatal("out-of-budget content did not fail before QR output")
		}
	}
}

func TestRenderShowsOnlyDeliberateURLAndRedactsFormatting(t *testing.T) {
	for _, test := range []struct {
		name, accessMode, sensitivity string
		mode                          Mode
		readonly                      bool
		warning                       string
	}{
		{name: "escape", mode: ModeEscape, sensitivity: "Anyone with this link can access this session until it expires.\nTreat it like a password.\n"},
		{name: "protected leash control", mode: ModeLeash, accessMode: "code", sensitivity: "Keep this invitation private.\nThe separate access code is also required.\n", warning: "This browser can type into the selected terminal process.\nRunning a shell grants shell-level access.\n"},
		{name: "protected leash readonly", mode: ModeLeash, accessMode: "code", readonly: true, sensitivity: "Keep this invitation private.\nThe separate access code is also required.\n", warning: "Browser access is view-only.\n"},
		{name: "link-only leash", mode: ModeLeash, accessMode: "link", sensitivity: "Anyone with this link can access this session until it expires.\nTreat it like a password.\n", warning: "This browser can type into the selected terminal process.\nRunning a shell grants shell-level access.\n"},
	} {
		t.Run(test.name, func(t *testing.T) {
			invitation := testInvitation(t, test.mode)
			defer invitation.Erase()
			secretURL := string(invitation.url)
			var output bytes.Buffer
			err := invitation.Render(&output, time.Unix(1_700_000_000, 0), DisplayOptions{
				Relay:      "official",
				NoQR:       true,
				Readonly:   test.readonly,
				AccessMode: test.accessMode,
			})
			if err != nil {
				t.Fatal(err)
			}
			got := output.String()
			if strings.Count(got, secretURL) != 1 ||
				!strings.Contains(got, test.sensitivity) ||
				!strings.Contains(got, "Open: "+secretURL) ||
				(test.warning != "" && !strings.Contains(got, test.warning)) {
				t.Fatalf("unexpected invitation display: %q", got)
			}
			writable := test.mode == ModeLeash && !test.readonly
			if strings.Contains(got, "This browser can type") != writable ||
				strings.Contains(got, "Running a shell grants shell-level access.") != writable ||
				strings.Contains(got, "Browser access is view-only.") != (test.mode == ModeLeash && test.readonly) {
				t.Fatal("invitation warning does not match the selected mode and access policy")
			}
			for _, formatted := range []string{
				fmt.Sprintf("%v", invitation),
				fmt.Sprintf("%+v", invitation),
				fmt.Sprintf("%#v", invitation),
			} {
				if formatted != "[redacted invitation]" || strings.Contains(formatted, syntheticAddress) {
					t.Fatalf("formatted invitation = %q", formatted)
				}
			}
		})
	}
	leash := testInvitation(t, ModeLeash)
	defer leash.Erase()
	for _, accessMode := range []string{"", "password", "CODE"} {
		if err := leash.Render(io.Discard, time.Now(), DisplayOptions{Relay: "official", AccessMode: accessMode}); !errors.Is(err, ErrDisplay) {
			t.Fatalf("ambiguous Leash access mode %q was rendered", accessMode)
		}
	}
}

func TestRenderQRAndLifecycleFailuresAreSafe(t *testing.T) {
	invitation := testInvitation(t, ModeEscape)
	var output bytes.Buffer
	if err := invitation.Render(&output, time.Unix(1_700_000_000, 0), DisplayOptions{
		Relay: "relay.example.com",
	}); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(output.String(), "\x1b[30;47m") ||
		strings.Count(output.String(), string(invitation.url)) != 1 {
		t.Fatal("rendered output omitted QR modules or duplicated the URL")
	}

	err := invitation.Render(failingWriter{}, time.Now(), DisplayOptions{Relay: "official"})
	if !errors.Is(err, ErrDisplay) || strings.Contains(err.Error(), syntheticAddress) {
		t.Fatalf("write error = %v", err)
	}
	if err := invitation.Render(io.Discard, time.Now(), DisplayOptions{Relay: "https://secret"}); !errors.Is(err, ErrDisplay) {
		t.Fatalf("unsafe relay error = %v", err)
	}

	retained := invitation.url
	invitation.Erase()
	invitation.Erase()
	if !allZero(retained) {
		t.Fatal("Erase did not overwrite retained URL bytes")
	}
	if err := invitation.Render(io.Discard, time.Now(), DisplayOptions{Relay: "official"}); !errors.Is(err, ErrErased) {
		t.Fatalf("render after erase = %v", err)
	}
}

func validTestCard(t *testing.T, mode Mode) MouseCard {
	t.Helper()
	identifier, err := NewSessionID()
	if err != nil {
		t.Fatal(err)
	}
	protocolIdentifier := EscapeProtocol
	if mode == ModeLeash {
		protocolIdentifier = LeashProtocol
	}
	return MouseCard{
		Version:     CardVersion,
		Mode:        mode,
		TailcatAddr: syntheticAddress,
		Port:        VirtualPort,
		SessionID:   identifier,
		ExpiresAt:   1_700_000_600,
		ProtocolMin: protocolIdentifier,
		ProtocolMax: protocolIdentifier,
	}
}

func testInvitation(t *testing.T, mode Mode) *Invitation {
	t.Helper()
	created, err := New("https://mouse.example/", validTestCard(t, mode))
	if err != nil {
		t.Fatal(err)
	}
	return created
}

func withCard(card MouseCard, change func(*MouseCard)) MouseCard {
	change(&card)
	return card
}

func allZero(value []byte) bool {
	for _, element := range value {
		if element != 0 {
			return false
		}
	}
	return true
}

type failingWriter struct{}

func (failingWriter) Write([]byte) (int, error) {
	return 0, errors.New("writer exposed " + syntheticAddress)
}
