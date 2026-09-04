package protocol

import (
	"encoding/hex"
	"encoding/json"
	"slices"
)

// Hello retains only fields used by host policy. Client diagnostics and the
// raw handshake must not become session credentials in logs or memory caches.
type Hello struct {
	SessionID     [16]byte
	Mode          string
	Protocol      uint16
	Columns, Rows uint16
}

func DecodeHello(frame Frame) (Hello, error) {
	if frame.Type != TypeClientHello || len(frame.Payload) > 4096 {
		return Hello{}, &ProtocolError{Code: CodeBadFrame}
	}
	selected, err := validateClientHello(frame.Payload)
	if err != nil {
		return Hello{}, err
	}
	var value clientHello
	_ = json.Unmarshal(frame.Payload, &value) // Already strictly validated above.
	hello := Hello{Mode: value.Mode, Protocol: selected}
	_, _ = hex.Decode(hello.SessionID[:], []byte(value.SessionID))
	if value.Terminal != nil {
		hello.Columns, hello.Rows = uint16(value.Terminal.Columns), uint16(value.Terminal.Rows)
	}
	return hello, nil
}

type Welcome struct {
	Mode                 string
	ExpiresAt            int64
	RelayMode, RelayHost string
	Capabilities         []string
}

func WelcomeFrame(welcome Welcome) (Frame, error) {
	expires := float64(welcome.ExpiresAt)
	value := serverWelcome{
		Protocol: 1, Mode: welcome.Mode, SessionState: "active", ExpiresAt: &expires,
		Relay:        welcomeRelay{Mode: welcome.RelayMode, Host: welcome.RelayHost, BrowserPath: "derp"},
		Capabilities: welcome.Capabilities,
	}
	payload, _ := json.Marshal(value)
	if _, err := validateServerWelcome(payload); err != nil {
		return Frame{}, err
	}
	return Frame{Type: TypeServerWelcome, Payload: payload, SelectedProtocol: 1}, nil
}

type errorPayload struct {
	Code      ErrorCode `json:"code"`
	Message   string    `json:"message"`
	Retryable *bool     `json:"retryable"`
}

type safeFailure struct {
	message   string
	retryable bool
}

func failureFor(code ErrorCode) (safeFailure, bool) {
	switch code {
	case CodeBadMouseCard:
		return safeFailure{"Invitation is invalid or unsupported.", false}, true
	case CodeExpired:
		return safeFailure{"Session has expired.", false}, true
	case CodeModeMismatch:
		return safeFailure{"Invitation mode does not match the host session.", false}, true
	case CodeProtocolMismatch:
		return safeFailure{"No supported protocol version overlaps.", false}, true
	case CodeSessionBusy:
		return safeFailure{"Another browser is controlling this session.", true}, true
	case CodeUnauthorized:
		return safeFailure{"This session does not grant that action.", false}, true
	case CodeFrameTooLarge:
		return safeFailure{"Frame exceeds the supported limit.", false}, true
	case CodeBadFrame:
		return safeFailure{"Frame is malformed or invalid in this state.", false}, true
	case CodeProcessNotRunning:
		return safeFailure{"No process is available for that action.", true}, true
	case CodeRestartDisabled:
		return safeFailure{"Restart is disabled for this session.", false}, true
	case CodeTerminateDisabled:
		return safeFailure{"Terminate is disabled for this session.", false}, true
	case CodeReadonly:
		return safeFailure{"Browser control is disabled for this session.", false}, true
	case CodeBackpressure:
		return safeFailure{"Input is paused until bounded capacity is available.", true}, true
	case CodeInternal:
		return safeFailure{"Session failed safely.", false}, true
	default:
		return safeFailure{}, false
	}
}

// ErrorFrame never serializes an error's original text, including unknown
// ProtocolError codes. Only the fixed v1 vocabulary crosses this boundary.
func ErrorFrame(err error) Frame {
	code, _ := ErrorCodeOf(err)
	failure, ok := failureFor(code)
	if !ok {
		code = CodeInternal
		failure, _ = failureFor(code)
	}
	payload, _ := json.Marshal(errorPayload{code, failure.message, &failure.retryable})
	return Frame{Type: TypeError, Payload: payload}
}

func validateError(payload []byte) error {
	object, err := strictJSONObject(payload)
	var value errorPayload
	if err != nil || !exactKeys(object, "code", "message", "retryable") || strictUnmarshal(payload, &value) != nil ||
		!boundedText(value.Message, 1, 256) || value.Retryable == nil {
		return &ProtocolError{Code: CodeBadFrame}
	}
	if _, ok := failureFor(value.Code); !ok {
		return &ProtocolError{Code: CodeBadFrame}
	}
	return nil
}

// DecodeError ignores a peer's free-form message. Callers can classify the code
// but must not display or log untrusted peer text.
func DecodeError(frame Frame) error {
	if frame.Type != TypeError || len(frame.Payload) > 1024 {
		return &ProtocolError{Code: CodeBadFrame}
	}
	if err := validateError(frame.Payload); err != nil {
		return err
	}
	var value errorPayload
	_ = json.Unmarshal(frame.Payload, &value)
	return &ProtocolError{Code: value.Code}
}

type closePayload struct {
	Reason  string `json:"reason"`
	Message string `json:"message"`
}

func validCloseReason(reason string) bool {
	return slices.Contains([]string{"normal", "mode_complete", "local_revoke", "expired", "protocol_error", "transport_error"}, reason)
}

func CloseFrame(reason string) (Frame, error) {
	if !validCloseReason(reason) {
		return Frame{}, &ProtocolError{Code: CodeBadFrame}
	}
	payload, _ := json.Marshal(closePayload{reason, "Session closed."})
	return Frame{Type: TypeClose, Payload: payload}, nil
}

func validateClose(payload []byte) error {
	object, err := strictJSONObject(payload)
	var value closePayload
	if err != nil || !exactKeys(object, "message", "reason") || strictUnmarshal(payload, &value) != nil ||
		!validCloseReason(value.Reason) || !boundedText(value.Message, 1, 256) {
		return &ProtocolError{Code: CodeBadFrame}
	}
	return nil
}

func DecodeClose(frame Frame) (string, error) {
	if frame.Type != TypeClose || len(frame.Payload) > 512 {
		return "", &ProtocolError{Code: CodeBadFrame}
	}
	if err := validateClose(frame.Payload); err != nil {
		return "", err
	}
	var value closePayload
	_ = json.Unmarshal(frame.Payload, &value)
	return value.Reason, nil
}
