package protocol

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"testing"
)

func TestDecodeHelloRetainsOnlyAuthoritativeHandshakeInputs(t *testing.T) {
	payload := fixturePayload(t, "valid-client-hello-v1")
	hello, err := DecodeHello(Frame{Type: TypeClientHello, Payload: payload})
	if err != nil || hello.Protocol != 1 || hello.Mode != "escape" || hello.Columns != 0 || hello.Rows != 0 {
		t.Fatal("escape hello did not decode")
	}
	for index, value := range hello.SessionID {
		if value != byte(index) {
			t.Fatal("hello session identity changed")
		}
	}
	var value map[string]any
	if err := json.Unmarshal(payload, &value); err != nil {
		t.Fatal(err)
	}
	value["mode"], value["protocol_min"], value["protocol_max"], value["terminal"] = "leash", 2, 2, map[string]int{"cols": 120, "rows": 40}
	payload, _ = json.Marshal(value)
	hello, err = DecodeHello(Frame{Type: TypeClientHello, Payload: payload})
	if err != nil || hello.Mode != "leash" || hello.Columns != 120 || hello.Rows != 40 {
		t.Fatal("terminal dimensions were not retained")
	}
	for _, frame := range []Frame{{Type: TypePing}, {Type: TypeClientHello, Payload: make([]byte, 4097)}, {Type: TypeClientHello, Payload: []byte(`{}`)}} {
		if _, err := DecodeHello(frame); err == nil {
			t.Fatal("invalid hello accepted")
		}
	}
}

func TestWelcomeFactoryValidatesAndCopiesAuthority(t *testing.T) {
	welcome := Welcome{Mode: "leash", ExpiresAt: 0, RelayMode: "custom-host", RelayHost: "relay.example.com", Capabilities: []string{"terminal_output"}, AccessMode: "code"}
	frame, err := WelcomeFrame(welcome)
	if err != nil || frame.SelectedProtocol != 2 || frame.Type != TypeServerWelcome {
		t.Fatal("welcome construction failed")
	}
	welcome.Capabilities[0] = "terminal_input"
	var value serverWelcome
	if err := json.Unmarshal(frame.Payload, &value); err != nil {
		t.Fatal(err)
	}
	if value.Capabilities[0] != "terminal_output" || value.ExpiresAt == nil || *value.ExpiresAt != 0 || value.Relay.BrowserPath != "derp" || value.AccessMode == nil || *value.AccessMode != "code" {
		t.Fatal("welcome shared mutable authority or lost lifetime/relay fields")
	}
	welcome.ExpiresAt = -1
	if _, err := WelcomeFrame(welcome); err == nil {
		t.Fatal("invalid welcome was accepted")
	}
}

func TestSafeErrorVocabularyAndPeerTextRedaction(t *testing.T) {
	codes := []ErrorCode{CodeBadMouseCard, CodeExpired, CodeModeMismatch, CodeProtocolMismatch, CodeSessionBusy,
		CodeAuthRequired, CodeAuthFailed,
		CodeUnauthorized, CodeFrameTooLarge, CodeBadFrame, CodeProcessNotRunning, CodeRestartDisabled,
		CodeTerminateDisabled, CodeReadonly, CodeBackpressure, CodeInternal}
	for _, code := range codes {
		frame := ErrorFrame(&ProtocolError{Code: code})
		var wire bytes.Buffer
		if err := WriteFrame(context.Background(), nopWriteCloser{&wire}, PeerHost, StateAwaitServerWelcome, frame); err != nil {
			t.Fatal(err)
		}
		decoded, err := ReadFrame(context.Background(), io.NopCloser(&wire), PeerBrowser, StateAwaitServerWelcome)
		if err != nil {
			t.Fatal(err)
		}
		if got, ok := ErrorCodeOf(DecodeError(decoded)); !ok || got != code {
			t.Fatal("stable error code changed on wire")
		}
		var value errorPayload
		if err := json.Unmarshal(decoded.Payload, &value); err != nil {
			t.Fatal(err)
		}
		wantRetry := code == CodeSessionBusy || code == CodeAuthFailed || code == CodeProcessNotRunning || code == CodeBackpressure
		if value.Retryable == nil || *value.Retryable != wantRetry {
			t.Fatal("stable retry policy changed")
		}
		value.Message = "tcSyntheticPeerSecret"
		decoded.Payload, _ = json.Marshal(value)
		if strings.Contains(DecodeError(decoded).Error(), value.Message) {
			t.Fatal("peer text reached diagnostics")
		}
	}
	throttled := ErrorFrame(&ProtocolError{Code: CodeAuthThrottled, RetryAfterMS: 30_000})
	decodedThrottle := DecodeError(throttled)
	var throttleError *ProtocolError
	if !errors.As(decodedThrottle, &throttleError) || throttleError.Code != CodeAuthThrottled || throttleError.RetryAfterMS != 30_000 {
		t.Fatal("authentication cooldown detail did not round-trip")
	}
	for _, failure := range []error{nil, errors.New("tcSyntheticUpstreamSecret"), &ProtocolError{Code: "tcSyntheticUnknownCode"}} {
		frame := ErrorFrame(failure)
		if bytes.Contains(frame.Payload, []byte("tcSynthetic")) {
			t.Fatal("factory serialized untrusted error text")
		}
		if code, _ := ErrorCodeOf(DecodeError(frame)); code != CodeInternal {
			t.Fatal("unknown failure did not become INTERNAL")
		}
	}
}

func TestAuthenticationPayloadFactoriesAndStrictDecoders(t *testing.T) {
	var challenge [32]byte
	for index := range challenge {
		challenge[index] = byte(index)
	}
	challengeFrame, err := AuthChallengeFrame(challenge)
	if err != nil || challengeFrame.Type != TypeAuthChallenge || string(challengeFrame.Payload) != `{"scheme":"hmac-sha256-v1","challenge":"AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"}` {
		t.Fatal("challenge factory changed the golden payload")
	}
	decodedChallenge, err := DecodeAuthChallenge(challengeFrame)
	if err != nil || decodedChallenge != challenge {
		t.Fatal("challenge did not round-trip")
	}
	proofFrame, err := AuthProofFrame(challenge)
	if err != nil {
		t.Fatal(err)
	}
	decodedProof, err := DecodeAuthProof(proofFrame)
	if err != nil || decodedProof != challenge {
		t.Fatal("proof did not round-trip")
	}
	for _, frame := range []Frame{
		{Type: TypeAuthChallenge, Payload: make([]byte, 513)},
		{Type: TypeAuthProof, Payload: make([]byte, 513)},
		{Type: TypeAuthChallenge, Payload: []byte(`{"scheme":"hmac-sha256-v1","challenge":"AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8="}`)},
		{Type: TypeAuthProof, Payload: []byte(`{"scheme":"hmac-sha256-v1","proof":"V0OMGOWhH9n8r+cwHjkH06dDCyNQrZQgrlxJXDmzl4s"}`)},
		{Type: TypeAuthProof, Payload: []byte(`{"scheme":"hmac-sha256-v1","proof":"V0OMGOWhH9n8r-cwHjkH06dDCyNQrZQgrlxJXDmzl4s","proof":"V0OMGOWhH9n8r-cwHjkH06dDCyNQrZQgrlxJXDmzl4s"}`)},
	} {
		if frame.Type == TypeAuthChallenge {
			if _, err := DecodeAuthChallenge(frame); err == nil {
				t.Fatal("invalid challenge accepted")
			}
		} else if _, err := DecodeAuthProof(frame); err == nil {
			t.Fatal("invalid proof accepted")
		}
	}
}

func TestControlDecodersRejectInvalidFieldsAndBounds(t *testing.T) {
	for _, payload := range []string{
		`{}`, `{"code":"INTERNAL","message":"safe","retryable":null}`,
		`{"code":"INTERNAL","message":"safe","retryable":false,"extra":1}`,
		`{"code":"UNKNOWN","message":"safe","retryable":false}`,
		`{"code":"INTERNAL","message":"` + strings.Repeat("x", 257) + `","retryable":false}`,
	} {
		if code, _ := ErrorCodeOf(DecodeError(Frame{Type: TypeError, Payload: []byte(payload)})); code != CodeBadFrame {
			t.Fatal("invalid error payload accepted")
		}
	}
	for _, frame := range []Frame{{Type: TypeClose}, {Type: TypeError, Payload: make([]byte, 1025)}} {
		if code, _ := ErrorCodeOf(DecodeError(frame)); code != CodeBadFrame {
			t.Fatal("invalid error frame accepted")
		}
	}
	for _, reason := range []string{"normal", "mode_complete", "local_revoke", "expired", "protocol_error", "transport_error"} {
		frame, err := CloseFrame(reason)
		if err != nil {
			t.Fatal(err)
		}
		decoded, err := DecodeClose(frame)
		if err != nil || decoded != reason {
			t.Fatal("close reason did not round-trip")
		}
	}
	if _, err := CloseFrame("tcSyntheticSecret"); err == nil {
		t.Fatal("invalid close reason accepted")
	}
	for _, frame := range []Frame{
		{Type: TypePing}, {Type: TypeClose, Payload: make([]byte, 513)},
		{Type: TypeClose, Payload: []byte(`{}`)},
		{Type: TypeClose, Payload: []byte(`{"reason":"normal","message":""}`)},
		{Type: TypeClose, Payload: []byte(`{"reason":"normal","message":"safe","extra":0}`)},
	} {
		if _, err := DecodeClose(frame); err == nil {
			t.Fatal("invalid close accepted")
		}
	}
}

type nopWriteCloser struct{ io.Writer }

func (nopWriteCloser) Close() error { return nil }
