package protocol

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"math"
	"slices"
	"strings"
	"unicode/utf8"
)

type messageRule struct {
	minimum int
	maximum int
	exact   int
}

func ruleFor(message MessageType) (messageRule, bool) {
	switch message {
	case TypeClientHello, TypeServerWelcome:
		return messageRule{minimum: 2, maximum: 4096, exact: -1}, true
	case TypeError:
		return messageRule{minimum: 2, maximum: 1024, exact: -1}, true
	case TypePing, TypePong:
		return messageRule{minimum: 16, maximum: 16, exact: 16}, true
	case TypeClose, TypeProcessControl, TypeOutputDropped:
		return messageRule{minimum: 2, maximum: 512, exact: -1}, true
	case TypeTermReset, TypeProcessState, TypeGameEvent:
		return messageRule{minimum: 2, maximum: 1024, exact: -1}, true
	case TypeTermOutput, TypeTermInput:
		return messageRule{minimum: 1, maximum: MaxTerminalPayload, exact: -1}, true
	case TypeTermResize:
		return messageRule{minimum: 4, maximum: 4, exact: 4}, true
	case TypeGameInit:
		return messageRule{minimum: 2, maximum: MaxControlPayload, exact: -1}, true
	case TypeGameInput:
		return messageRule{minimum: 24, maximum: 24, exact: 24}, true
	case TypeGameSnapshot:
		return messageRule{minimum: 44, maximum: 44, exact: 44}, true
	case TypeGameResult:
		return messageRule{minimum: 2, maximum: 2048, exact: -1}, true
	default:
		return messageRule{}, false
	}
}

func validateRoute(message MessageType, sender Peer, state State) ErrorCode {
	if sender != PeerHost && sender != PeerBrowser {
		return CodeBadFrame
	}
	switch state {
	case StateAwaitClientHello:
		if sender == PeerBrowser && message == TypeClientHello {
			return ""
		}
	case StateAwaitServerWelcome:
		if sender == PeerHost && (message == TypeServerWelcome || message == TypeError) {
			return ""
		}
	case StateActiveEscape:
		if isCommonActive(message) || isEscapeMessage(message, sender) {
			return ""
		}
		if isTerminalMessage(message) {
			return CodeModeMismatch
		}
	case StateActiveLeash:
		if isCommonActive(message) || isTerminalMessageForSender(message, sender) {
			return ""
		}
		if isEscapeMessageType(message) {
			return CodeModeMismatch
		}
	case StateClosing:
		if message == TypeClose || message == TypeError {
			return ""
		}
	}
	return CodeBadFrame
}

func isCommonActive(message MessageType) bool {
	return message == TypeError || message == TypePing || message == TypePong || message == TypeClose
}

func isTerminalMessage(message MessageType) bool {
	return message >= TypeTermReset && message <= TypeOutputDropped
}

func isTerminalMessageForSender(message MessageType, sender Peer) bool {
	switch message {
	case TypeTermReset, TypeTermOutput, TypeProcessState, TypeOutputDropped:
		return sender == PeerHost
	case TypeTermInput, TypeTermResize, TypeProcessControl:
		return sender == PeerBrowser
	default:
		return false
	}
}

func isEscapeMessageType(message MessageType) bool {
	return message >= TypeGameInit && message <= TypeGameResult
}

func isEscapeMessage(message MessageType, sender Peer) bool {
	switch message {
	case TypeGameInit, TypeGameSnapshot, TypeGameResult:
		return sender == PeerHost
	case TypeGameInput:
		return sender == PeerBrowser
	case TypeGameEvent:
		return true
	default:
		return false
	}
}

func validatePayload(message MessageType, payload []byte, sender Peer) (uint16, error) {
	switch message {
	case TypeClientHello:
		return validateClientHello(payload)
	case TypeServerWelcome:
		return validateServerWelcome(payload)
	case TypeError:
		return 0, validateError(payload)
	case TypeClose:
		return 0, validateClose(payload)
	case TypeTermReset:
		_, err := DecodeTermReset(Frame{Type: message, Payload: payload})
		return 0, err
	case TypeProcessControl:
		_, err := DecodeProcessControl(Frame{Type: message, Payload: payload})
		return 0, err
	case TypeProcessState:
		_, err := DecodeProcessState(Frame{Type: message, Payload: payload})
		return 0, err
	case TypeOutputDropped:
		_, err := DecodeOutputDropped(Frame{Type: message, Payload: payload})
		return 0, err
	case TypeGameInit:
		_, err := DecodeGameInit(Frame{Type: message, Payload: payload})
		return 0, err
	case TypeGameEvent:
		_, err := DecodeGameEvent(Frame{Type: message, Payload: payload}, sender)
		return 0, err
	case TypeGameResult:
		_, err := DecodeGameResult(Frame{Type: message, Payload: payload})
		return 0, err
	case TypeTermResize:
		columns := binary.BigEndian.Uint16(payload[0:2])
		rows := binary.BigEndian.Uint16(payload[2:4])
		if columns < 20 || columns > 500 || rows < 5 || rows > 200 {
			return 0, &ProtocolError{Code: CodeBadFrame}
		}
	case TypeGameInput:
		_, err := DecodeGameInput(Frame{Type: message, Payload: payload})
		return 0, err
	case TypeGameSnapshot:
		_, err := DecodeGameSnapshot(Frame{Type: message, Payload: payload})
		return 0, err
	}
	return 0, nil
}

func finiteUnit(value float32) bool {
	return !math.IsNaN(float64(value)) && !math.IsInf(float64(value), 0) && value >= -1 && value <= 1
}

type clientHello struct {
	ProtocolMin float64        `json:"protocol_min"`
	ProtocolMax float64        `json:"protocol_max"`
	SessionID   string         `json:"session_id"`
	Mode        string         `json:"mode"`
	Client      helloClient    `json:"client"`
	Terminal    *helloTerminal `json:"terminal,omitempty"`
}

type helloClient struct {
	Name      string  `json:"name"`
	Version   string  `json:"version"`
	Platform  string  `json:"platform"`
	UserAgent *string `json:"user_agent"`
}

type helloTerminal struct {
	Columns float64 `json:"cols"`
	Rows    float64 `json:"rows"`
}

func validateClientHello(payload []byte) (uint16, error) {
	object, err := strictJSONObject(payload)
	if err != nil || !exactKeys(object, "client", "mode", "protocol_max", "protocol_min", "session_id") &&
		!exactKeys(object, "client", "mode", "protocol_max", "protocol_min", "session_id", "terminal") {
		return 0, &ProtocolError{Code: CodeBadFrame}
	}
	var value clientHello
	if strictUnmarshal(payload, &value) != nil || !integerBetween(value.ProtocolMin, 1, 65_535) ||
		!integerBetween(value.ProtocolMax, 1, 65_535) || value.ProtocolMin > value.ProtocolMax ||
		(value.Mode != "escape" && value.Mode != "leash") || !validSessionID(value.SessionID) ||
		!boundedText(value.Client.Name, 1, 64) || !boundedText(value.Client.Version, 1, 32) ||
		!boundedText(value.Client.Platform, 1, 32) || value.Client.UserAgent == nil ||
		!boundedText(*value.Client.UserAgent, 0, 512) {
		return 0, &ProtocolError{Code: CodeBadFrame}
	}
	clientObject, err := strictJSONObject(object["client"])
	if err != nil || !exactKeys(clientObject, "name", "platform", "user_agent", "version") {
		return 0, &ProtocolError{Code: CodeBadFrame}
	}
	if _, present := object["terminal"]; present {
		if value.Terminal == nil {
			return 0, &ProtocolError{Code: CodeBadFrame}
		}
		terminalObject, err := strictJSONObject(object["terminal"])
		if err != nil || !exactKeys(terminalObject, "cols", "rows") ||
			!integerBetween(value.Terminal.Columns, 20, 500) ||
			!integerBetween(value.Terminal.Rows, 5, 200) {
			return 0, &ProtocolError{Code: CodeBadFrame}
		}
	}
	if value.ProtocolMin > 1 || value.ProtocolMax < 1 {
		return 0, &ProtocolError{Code: CodeProtocolMismatch}
	}
	return 1, nil
}

type serverWelcome struct {
	Protocol     float64      `json:"protocol"`
	Mode         string       `json:"mode"`
	SessionState string       `json:"session_state"`
	ExpiresAt    *float64     `json:"expires_at"`
	Relay        welcomeRelay `json:"relay"`
	Capabilities []string     `json:"capabilities"`
}

type welcomeRelay struct {
	Mode        string `json:"mode"`
	Host        string `json:"host"`
	BrowserPath string `json:"browser_path"`
}

func validateServerWelcome(payload []byte) (uint16, error) {
	object, err := strictJSONObject(payload)
	if err != nil || !exactKeys(object, "capabilities", "expires_at", "mode", "protocol", "relay", "session_state") {
		return 0, &ProtocolError{Code: CodeBadFrame}
	}
	var value serverWelcome
	if strictUnmarshal(payload, &value) != nil || value.Protocol != 1 || value.SessionState != "active" ||
		value.ExpiresAt == nil || !integerBetween(*value.ExpiresAt, 0, 9_007_199_254_740_991) ||
		(value.Mode != "escape" && value.Mode != "leash") || !validRelay(value.Relay) ||
		!validCapabilities(value.Mode, value.Capabilities) {
		return 0, &ProtocolError{Code: CodeBadFrame}
	}
	relayObject, err := strictJSONObject(object["relay"])
	if err != nil || !exactKeys(relayObject, "browser_path", "host", "mode") {
		return 0, &ProtocolError{Code: CodeBadFrame}
	}
	return 1, nil
}

func strictJSONObject(payload []byte) (map[string]json.RawMessage, error) {
	if !utf8.Valid(payload) || bytes.HasPrefix(payload, []byte{0xef, 0xbb, 0xbf}) {
		return nil, &ProtocolError{Code: CodeBadFrame}
	}
	decoder := json.NewDecoder(bytes.NewReader(payload))
	if err := rejectDuplicateJSONValue(decoder, true, 1); err != nil {
		return nil, err
	}
	if decoder.Decode(&struct{}{}) == nil {
		return nil, &ProtocolError{Code: CodeBadFrame}
	}
	var object map[string]json.RawMessage
	if err := json.Unmarshal(payload, &object); err != nil || object == nil {
		return nil, &ProtocolError{Code: CodeBadFrame}
	}
	return object, nil
}

func rejectDuplicateJSONValue(decoder *json.Decoder, requireObject bool, depth int) error {
	if depth > 32 {
		return &ProtocolError{Code: CodeBadFrame}
	}
	token, err := decoder.Token()
	if err != nil {
		return &ProtocolError{Code: CodeBadFrame}
	}
	delimiter, isDelimiter := token.(json.Delim)
	if !isDelimiter {
		if requireObject {
			return &ProtocolError{Code: CodeBadFrame}
		}
		return nil
	}
	switch delimiter {
	case '{':
		seen := map[string]struct{}{}
		for decoder.More() {
			key, err := decoder.Token()
			name, ok := key.(string)
			if err != nil || !ok {
				return &ProtocolError{Code: CodeBadFrame}
			}
			if _, duplicate := seen[name]; duplicate {
				return &ProtocolError{Code: CodeBadFrame}
			}
			seen[name] = struct{}{}
			if err := rejectDuplicateJSONValue(decoder, false, depth+1); err != nil {
				return err
			}
		}
	case '[':
		if requireObject {
			return &ProtocolError{Code: CodeBadFrame}
		}
		for decoder.More() {
			if err := rejectDuplicateJSONValue(decoder, false, depth+1); err != nil {
				return err
			}
		}
	default:
		return &ProtocolError{Code: CodeBadFrame}
	}
	if _, err := decoder.Token(); err != nil {
		return &ProtocolError{Code: CodeBadFrame}
	}
	return nil
}

func strictUnmarshal(payload []byte, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	if decoder.Decode(&struct{}{}) == nil {
		return &ProtocolError{Code: CodeBadFrame}
	}
	return nil
}

func exactKeys(object map[string]json.RawMessage, expected ...string) bool {
	actual := make([]string, 0, len(object))
	for key := range object {
		actual = append(actual, key)
	}
	slices.Sort(actual)
	slices.Sort(expected)
	return slices.Equal(actual, expected)
}

func validSessionID(value string) bool {
	if len(value) != 32 {
		return false
	}
	for _, character := range value {
		if !(character >= '0' && character <= '9' || character >= 'a' && character <= 'f') {
			return false
		}
	}
	return true
}

func boundedText(value string, minimum, maximum int) bool {
	return utf8.ValidString(value) && len([]byte(value)) >= minimum && len([]byte(value)) <= maximum
}

func integerBetween(value, minimum, maximum float64) bool {
	return !math.IsNaN(value) && !math.IsInf(value, 0) && math.Trunc(value) == value && value >= minimum && value <= maximum
}

func validRelay(relay welcomeRelay) bool {
	if relay.Mode != "official" && relay.Mode != "custom-host" && relay.Mode != "custom-map" {
		return false
	}
	return relay.BrowserPath == "derp" && validDiagnosticHost(relay.Host)
}

func validDiagnosticHost(host string) bool {
	if host == "" || len(host) > 253 || strings.HasSuffix(host, ".") {
		return false
	}
	for _, label := range strings.Split(host, ".") {
		if label == "" || len(label) > 63 || label[0] == '-' || label[len(label)-1] == '-' {
			return false
		}
		for _, character := range label {
			if !(character == '-' || character >= '0' && character <= '9' || character >= 'a' && character <= 'z') {
				return false
			}
		}
	}
	return true
}

func validCapabilities(mode string, capabilities []string) bool {
	allowed := []string{"dash", "game_input", "game_view"}
	if mode == "leash" {
		allowed = []string{"interrupt", "resize", "restart", "terminal_input", "terminal_output", "terminate"}
	}
	if len(capabilities) == 0 || !slices.IsSorted(capabilities) {
		return false
	}
	for index, capability := range capabilities {
		if !slices.Contains(allowed, capability) || index > 0 && capabilities[index-1] == capability {
			return false
		}
	}
	return true
}
