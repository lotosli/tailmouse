package protocol

import (
	"bytes"
	"encoding/json"
	"slices"
	"strings"
	"unicode"
)

type TermReset struct {
	Generation uint32 `json:"generation"`
	Columns    uint16 `json:"cols"`
	Rows       uint16 `json:"rows"`
}

type ProcessControl struct {
	Action     string `json:"action"`
	Generation uint32 `json:"generation"`
}

type ProcessState struct {
	Generation uint32  `json:"generation"`
	State      string  `json:"state"`
	PID        *uint64 `json:"pid"`
	StartedAt  *int64  `json:"started_at"`
	ExitCode   *int    `json:"exit_code"`
	Signal     *string `json:"signal"`
	Title      string  `json:"title,omitempty"`
}

type OutputDropped struct {
	Generation uint32 `json:"generation"`
	Bytes      uint64 `json:"dropped_bytes"`
}

func terminalObject(frame Frame, expected MessageType, target any, keys ...string) error {
	rule, _ := ruleFor(expected)
	if frame.Type != expected || len(frame.Payload) < rule.minimum || len(frame.Payload) > rule.maximum {
		return &ProtocolError{Code: CodeBadFrame}
	}
	object, err := strictJSONObject(frame.Payload)
	if expected == TypeProcessState && object["title"] != nil {
		keys = append(keys, "title")
	}
	if err != nil || !exactKeys(object, keys...) || strictUnmarshal(frame.Payload, target) != nil {
		return &ProtocolError{Code: CodeBadFrame}
	}
	return nil
}

func DecodeTermReset(frame Frame) (TermReset, error) {
	var value struct {
		Generation float64 `json:"generation"`
		Columns    float64 `json:"cols"`
		Rows       float64 `json:"rows"`
	}
	err := terminalObject(frame, TypeTermReset, &value, "generation", "cols", "rows")
	if err != nil || !integerBetween(value.Generation, 1, 1<<32-1) || !integerBetween(value.Columns, 20, 500) || !integerBetween(value.Rows, 5, 200) {
		return TermReset{}, &ProtocolError{Code: CodeBadFrame}
	}
	return TermReset{Generation: uint32(value.Generation), Columns: uint16(value.Columns), Rows: uint16(value.Rows)}, nil
}

func DecodeProcessControl(frame Frame) (ProcessControl, error) {
	var value struct {
		Action     string  `json:"action"`
		Generation float64 `json:"generation"`
	}
	err := terminalObject(frame, TypeProcessControl, &value, "action", "generation")
	if err != nil || !integerBetween(value.Generation, 1, 1<<32-1) || !slices.Contains([]string{"interrupt", "restart", "terminate"}, value.Action) {
		return ProcessControl{}, &ProtocolError{Code: CodeBadFrame}
	}
	return ProcessControl{Action: value.Action, Generation: uint32(value.Generation)}, nil
}

func DecodeProcessState(frame Frame) (ProcessState, error) {
	var value struct {
		Generation float64         `json:"generation"`
		State      string          `json:"state"`
		PID        *float64        `json:"pid"`
		StartedAt  *float64        `json:"started_at"`
		ExitCode   *float64        `json:"exit_code"`
		Signal     *string         `json:"signal"`
		Title      json.RawMessage `json:"title"`
	}
	err := terminalObject(frame, TypeProcessState, &value, "generation", "state", "pid", "started_at", "exit_code", "signal")
	if err != nil || !integerBetween(value.Generation, 1, 1<<32-1) || !slices.Contains([]string{"waiting", "starting", "running", "interrupting", "terminating", "exited", "restarting", "failed", "closing"}, value.State) ||
		value.PID != nil && !integerBetween(*value.PID, 1, 1<<53-1) ||
		value.StartedAt != nil && !integerBetween(*value.StartedAt, 0, 1<<53-1) ||
		value.ExitCode != nil && !integerBetween(*value.ExitCode, 0, 1<<32-1) ||
		value.Signal != nil && !safeSignal(*value.Signal) {
		return ProcessState{}, &ProtocolError{Code: CodeBadFrame}
	}
	result := ProcessState{Generation: uint32(value.Generation), State: value.State, Signal: value.Signal}
	if len(value.Title) > 0 {
		if json.Unmarshal(value.Title, &result.Title) != nil || !validTerminalTitle(result.Title) {
			return ProcessState{}, &ProtocolError{Code: CodeBadFrame}
		}
	}
	if value.PID != nil {
		pid := uint64(*value.PID)
		result.PID = &pid
	}
	if value.StartedAt != nil {
		started := int64(*value.StartedAt)
		result.StartedAt = &started
	}
	if value.ExitCode != nil {
		code := int(*value.ExitCode)
		result.ExitCode = &code
	}
	return result, nil
}

func safeSignal(value string) bool {
	if len(value) == 0 || len(value) > 32 {
		return false
	}
	for _, character := range value {
		if character != '_' && (character < 'A' || character > 'Z') && (character < '0' || character > '9') {
			return false
		}
	}
	return true
}

func validTerminalTitle(value string) bool {
	return boundedText(value, 1, 256) && !strings.ContainsFunc(value, unicode.IsControl)
}

func DecodeOutputDropped(frame Frame) (OutputDropped, error) {
	var value struct {
		Generation float64  `json:"generation"`
		Bytes      *float64 `json:"dropped_bytes"`
	}
	err := terminalObject(frame, TypeOutputDropped, &value, "generation", "dropped_bytes")
	if err != nil || !integerBetween(value.Generation, 1, 1<<32-1) || value.Bytes == nil || !integerBetween(*value.Bytes, 0, 1<<53-1) {
		return OutputDropped{}, &ProtocolError{Code: CodeBadFrame}
	}
	return OutputDropped{Generation: uint32(value.Generation), Bytes: uint64(*value.Bytes)}, nil
}

func terminalFrame(kind MessageType, value any) (Frame, error) {
	var output bytes.Buffer
	encoder := json.NewEncoder(&output)
	// This is framed JSON, never inline HTML. HTML escaping can expand a
	// valid 256-byte title beyond the fixed frame bound; the UI uses text.
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		return Frame{}, &ProtocolError{Code: CodeBadFrame}
	}
	payload := bytes.TrimSuffix(output.Bytes(), []byte{'\n'})
	if _, err := validatePayload(kind, payload, PeerHost); err != nil {
		return Frame{}, err
	}
	return Frame{Type: kind, Payload: payload}, nil
}

func TermResetFrame(value TermReset) (Frame, error) {
	return terminalFrame(TypeTermReset, value)
}

func ProcessControlFrame(value ProcessControl) (Frame, error) {
	return terminalFrame(TypeProcessControl, value)
}

func ProcessStateFrame(value ProcessState) (Frame, error) {
	if value.Title != "" && !validTerminalTitle(value.Title) {
		return Frame{}, &ProtocolError{Code: CodeBadFrame}
	}
	return terminalFrame(TypeProcessState, value)
}

func OutputDroppedFrame(value OutputDropped) (Frame, error) {
	return terminalFrame(TypeOutputDropped, value)
}
