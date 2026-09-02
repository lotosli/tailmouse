// Package invitation constructs the secret-bearing MouseCard and its terminal
// presentation. It intentionally exposes no method that returns an invitation
// URL as a string.
package invitation

import (
	"bytes"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"net/url"
	"strings"
	"time"

	"github.com/fxamacker/cbor/v2"
	qrcode "github.com/yeqown/go-qrcode/v2"
)

const (
	CardVersion        uint8  = 1
	ProtocolVersion    uint16 = 1
	VirtualPort        uint16 = 44321
	MaxInvitationBytes        = 1400
	quietZoneModules          = 4
	minimumQRVersion          = 4 // QR version 4 is 33 by 33 modules.
)

var (
	ErrInvalidCard    = errors.New("invalid MouseCard")
	ErrInvalidBaseURL = errors.New("invalid Web base URL")
	ErrInvitationSize = errors.New("invitation exceeds the QR size limit")
	ErrEncode         = errors.New("MouseCard encoding failed")
	ErrQR             = errors.New("invitation QR generation failed")
	ErrDisplay        = errors.New("invitation display failed")
	ErrErased         = errors.New("invitation has been erased")

	cardEncoder, cardEncoderErr = cbor.CanonicalEncOptions().EncMode()
)

type Mode string

const (
	ModeEscape Mode = "escape"
	ModeLeash  Mode = "leash"
)

// MouseCard is the complete v1 invitation payload. Its mode is only an initial
// browser UI hint; the host handshake remains authoritative.
type MouseCard struct {
	Version     uint8    `cbor:"v"`
	Mode        Mode     `cbor:"m"`
	TailcatAddr string   `cbor:"t"`
	Port        uint16   `cbor:"p"`
	SessionID   [16]byte `cbor:"s"`
	ExpiresAt   int64    `cbor:"e"`
	ProtocolMin uint16   `cbor:"a"`
	ProtocolMax uint16   `cbor:"z"`
}

// NewSessionID returns a 128-bit identifier directly from the operating
// system's cryptographically secure random source.
func NewSessionID() ([16]byte, error) {
	var identifier [16]byte
	if _, err := rand.Read(identifier[:]); err != nil {
		return [16]byte{}, ErrEncode
	}
	return identifier, nil
}

// Encode serializes a complete, valid MouseCard using canonical CBOR.
func Encode(card MouseCard) ([]byte, error) {
	if !validCard(card) || cardEncoderErr != nil {
		return nil, ErrInvalidCard
	}
	encoded, err := cardEncoder.Marshal(card)
	if err != nil {
		return nil, ErrEncode
	}
	return encoded, nil
}

// Invitation retains the full bearer URL only in erasable private memory.
// Format always redacts it so accidental diagnostic formatting is safe.
type Invitation struct {
	url       []byte
	mode      Mode
	expiresAt int64
}

// New creates the exact fragment-only URL after validating its final byte
// length. It never returns a partial invitation on failure.
func New(webBaseURL string, card MouseCard) (*Invitation, error) {
	base, err := normalizedBaseURL(webBaseURL)
	if err != nil {
		return nil, err
	}
	encoded, err := Encode(card)
	if err != nil {
		return nil, err
	}
	defer erase(encoded)

	prefix := []byte(base + "#/v1/")
	encodedLength := base64.RawURLEncoding.EncodedLen(len(encoded))
	if len(prefix)+encodedLength >= MaxInvitationBytes {
		return nil, ErrInvitationSize
	}
	invitationURL := make([]byte, len(prefix)+encodedLength)
	copy(invitationURL, prefix)
	base64.RawURLEncoding.Encode(invitationURL[len(prefix):], encoded)
	return &Invitation{
		url:       invitationURL,
		mode:      card.Mode,
		expiresAt: card.ExpiresAt,
	}, nil
}

// DisplayOptions contains only non-secret presentation inputs.
type DisplayOptions struct {
	Relay    string
	NoQR     bool
	Readonly bool
}

// Render writes the deliberate invitation surface. The URL appears literally
// only on the Open line; the QR area contains only its encoded matrix.
func (invitation *Invitation) Render(
	output io.Writer,
	now time.Time,
	options DisplayOptions,
) error {
	if len(invitation.url) == 0 {
		return ErrErased
	}
	if output == nil || !validRelayLabel(options.Relay) {
		return ErrDisplay
	}

	var rendered bytes.Buffer
	title := "TAILMOUSE " + strings.ToUpper(string(invitation.mode))
	if _, err := fmt.Fprintf(&rendered, "%s\n\nScan the mouse hole\n\n", title); err != nil {
		return ErrDisplay
	}
	if !options.NoQR {
		bitmap, err := qrBitmap(invitation.url)
		if err != nil {
			return err
		}
		writeTerminalQR(&rendered, addQuietZone(bitmap))
		rendered.WriteByte('\n')
	}
	if _, err := fmt.Fprintf(
		&rendered,
		"Mode       %s\nRelay      %s\nExpires    %s\n\n",
		invitation.mode,
		options.Relay,
		expiryLabel(invitation.expiresAt, now),
	); err != nil {
		return ErrDisplay
	}
	rendered.WriteString("Treat this link like a password. Anyone with it can access this session until expiry.\n")
	if invitation.mode == ModeLeash {
		if options.Readonly {
			rendered.WriteString("Browser access is view-only.\n")
		} else {
			rendered.WriteString("Browser input has the authority of this terminal process.\n")
		}
	}
	rendered.WriteString("Open: ")
	rendered.Write(invitation.url)
	rendered.WriteByte('\n')

	bytesToWrite := rendered.Bytes()
	defer erase(bytesToWrite)
	written, err := output.Write(bytesToWrite)
	if err != nil || written != len(bytesToWrite) {
		return ErrDisplay
	}
	return nil
}

// Erase releases and overwrites retained invitation bytes. It is idempotent.
func (invitation *Invitation) Erase() {
	erase(invitation.url)
	invitation.url = nil
	invitation.mode = ""
	invitation.expiresAt = 0
}

// Format prevents every fmt verb, including %#v, from revealing the private
// URL through logs or diagnostics.
func (*Invitation) Format(state fmt.State, _ rune) {
	_, _ = io.WriteString(state, "[redacted invitation]")
}

func validCard(card MouseCard) bool {
	if card.Version != CardVersion ||
		(card.Mode != ModeEscape && card.Mode != ModeLeash) ||
		card.TailcatAddr == "" ||
		card.Port != VirtualPort ||
		card.ExpiresAt < 0 ||
		card.ProtocolMin != ProtocolVersion ||
		card.ProtocolMax != ProtocolVersion {
		return false
	}
	return card.SessionID != [16]byte{}
}

func normalizedBaseURL(raw string) (string, error) {
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Host == "" ||
		(parsed.Scheme != "http" && parsed.Scheme != "https") ||
		parsed.User != nil || parsed.RawQuery != "" || parsed.ForceQuery || parsed.Fragment != "" {
		return "", ErrInvalidBaseURL
	}
	if !strings.HasSuffix(parsed.Path, "/") {
		parsed.Path += "/"
	}
	return parsed.String(), nil
}

func qrBitmap(source []byte) ([][]bool, error) {
	code, err := qrcode.NewWith(
		string(source),
		qrcode.WithErrorCorrectionLevel(qrcode.ErrorCorrectionMedium),
		qrcode.WithMinimumVersion(minimumQRVersion),
	)
	if err != nil {
		return nil, ErrQR
	}
	capture := &matrixWriter{}
	if err := code.Save(capture); err != nil {
		return nil, ErrQR
	}
	return capture.bitmap, nil
}

type matrixWriter struct {
	bitmap [][]bool
}

func (writer *matrixWriter) Write(matrix qrcode.Matrix) error {
	writer.bitmap = matrix.Bitmap()
	return nil
}

func (*matrixWriter) Close() error { return nil }

func addQuietZone(bitmap [][]bool) [][]bool {
	dimension := len(bitmap)
	withBorder := make([][]bool, dimension+2*quietZoneModules)
	for row := range withBorder {
		withBorder[row] = make([]bool, dimension+2*quietZoneModules)
	}
	for row := range bitmap {
		copy(withBorder[row+quietZoneModules][quietZoneModules:], bitmap[row])
	}
	return withBorder
}

func writeTerminalQR(output *bytes.Buffer, bitmap [][]bool) {
	for _, row := range bitmap {
		for _, dark := range row {
			if dark {
				output.WriteString("\x1b[40m  ")
			} else {
				output.WriteString("\x1b[47m  ")
			}
		}
		output.WriteString("\x1b[0m\n")
	}
}

func expiryLabel(expiresAt int64, now time.Time) string {
	if expiresAt == 0 {
		return "host lifetime"
	}
	remaining := time.Unix(expiresAt, 0).Sub(now)
	if remaining <= 0 {
		return "expired"
	}
	return remaining.Round(time.Second).String()
}

func validRelayLabel(label string) bool {
	if label == "official" {
		return true
	}
	return label != "" && len(label) <= 253 &&
		!strings.ContainsAny(label, "/:@?#\\\t\r\n ")
}

func erase(value []byte) {
	for index := range value {
		value[index] = 0
	}
}
