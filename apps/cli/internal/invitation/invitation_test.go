package invitation

import (
	"bytes"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"net/url"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/fxamacker/cbor/v2"
	qrcode "github.com/yeqown/go-qrcode/v2"
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
		{name: "bad protocol", base: "https://mouse.example/", card: withCard(card, func(value *MouseCard) { value.ProtocolMax = 2 }), want: ErrInvalidCard},
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

	expectedCode, err := qrcode.NewWith(
		string(invitation.url),
		qrcode.WithErrorCorrectionLevel(qrcode.ErrorCorrectionMedium),
		qrcode.WithMinimumVersion(minimumQRVersion),
	)
	if err != nil {
		t.Fatal(err)
	}
	expected := &matrixWriter{}
	if err := expectedCode.Save(expected); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(bitmap, expected.bitmap) {
		t.Fatal("QR matrix does not match error correction level M")
	}

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

func TestRenderShowsOnlyDeliberateURLAndRedactsFormatting(t *testing.T) {
	for _, test := range []struct {
		name     string
		mode     Mode
		readonly bool
		warning  string
	}{
		{name: "escape", mode: ModeEscape},
		{name: "leash control", mode: ModeLeash, warning: "authority of this terminal process"},
		{name: "leash readonly", mode: ModeLeash, readonly: true, warning: "view-only"},
	} {
		t.Run(test.name, func(t *testing.T) {
			invitation := testInvitation(t, test.mode)
			defer invitation.Erase()
			secretURL := string(invitation.url)
			var output bytes.Buffer
			err := invitation.Render(&output, time.Unix(1_700_000_000, 0), DisplayOptions{
				Relay:    "official",
				NoQR:     true,
				Readonly: test.readonly,
			})
			if err != nil {
				t.Fatal(err)
			}
			got := output.String()
			if strings.Count(got, secretURL) != 1 ||
				!strings.Contains(got, "Treat this link like a password") ||
				!strings.Contains(got, "Open: "+secretURL) ||
				(test.warning != "" && !strings.Contains(got, test.warning)) {
				t.Fatalf("unexpected invitation display: %q", got)
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
}

func TestRenderQRAndLifecycleFailuresAreSafe(t *testing.T) {
	invitation := testInvitation(t, ModeEscape)
	var output bytes.Buffer
	if err := invitation.Render(&output, time.Unix(1_700_000_000, 0), DisplayOptions{
		Relay: "relay.example.com",
	}); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(output.String(), "\x1b[40m") ||
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
	return MouseCard{
		Version:     CardVersion,
		Mode:        mode,
		TailcatAddr: syntheticAddress,
		Port:        VirtualPort,
		SessionID:   identifier,
		ExpiresAt:   1_700_000_600,
		ProtocolMin: ProtocolVersion,
		ProtocolMax: ProtocolVersion,
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
