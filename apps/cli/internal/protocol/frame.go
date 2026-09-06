// Package protocol implements the bounded native TMOUSE/1 wire contract.
package protocol

import (
	"context"
	"encoding/binary"
	"errors"
	"io"
)

const (
	MaxFrameLength       = 1_048_576
	MaxControlPayload    = 16_384
	MaxTerminalPayload   = 32_766
	frameHeaderBytes     = 4
	frameMetadataBytes   = 2
	maxFramePayloadBytes = MaxFrameLength - frameMetadataBytes
)

var ErrStream = errors.New("TMOUSE/1 stream operation failed")

type ErrorCode string

const (
	CodeBadFrame          ErrorCode = "BAD_FRAME"
	CodeFrameTooLarge     ErrorCode = "FRAME_TOO_LARGE"
	CodeModeMismatch      ErrorCode = "MODE_MISMATCH"
	CodeProtocolMismatch  ErrorCode = "PROTOCOL_MISMATCH"
	CodeBadMouseCard      ErrorCode = "BAD_MOUSE_CARD"
	CodeExpired           ErrorCode = "EXPIRED"
	CodeSessionBusy       ErrorCode = "SESSION_BUSY"
	CodeAuthRequired      ErrorCode = "AUTH_REQUIRED"
	CodeAuthFailed        ErrorCode = "AUTH_FAILED"
	CodeAuthThrottled     ErrorCode = "AUTH_THROTTLED"
	CodeUnauthorized      ErrorCode = "UNAUTHORIZED_CAPABILITY"
	CodeReadonly          ErrorCode = "READONLY"
	CodeRestartDisabled   ErrorCode = "RESTART_DISABLED"
	CodeTerminateDisabled ErrorCode = "TERMINATE_DISABLED"
	CodeProcessNotRunning ErrorCode = "PROCESS_NOT_RUNNING"
	CodeBackpressure      ErrorCode = "BACKPRESSURE"
	CodeInternal          ErrorCode = "INTERNAL"
)

type ProtocolError struct {
	Code         ErrorCode
	RetryAfterMS uint32
	truncated    bool
}

func (err *ProtocolError) Error() string {
	return "TMOUSE/1 " + string(err.Code)
}

func ErrorCodeOf(err error) (ErrorCode, bool) {
	var protocolError *ProtocolError
	if !errors.As(err, &protocolError) {
		return "", false
	}
	return protocolError.Code, true
}

// IsTruncatedFrame identifies local read failure, never a peer error or hint.
// The codec still reports BAD_FRAME; only an established session may recover.
func IsTruncatedFrame(err error) bool {
	var failure *ProtocolError
	return errors.As(err, &failure) && failure.Code == CodeBadFrame && failure.truncated
}

type MessageType uint8

const (
	TypeClientHello   MessageType = 0x01
	TypeServerWelcome MessageType = 0x02
	TypeError         MessageType = 0x03
	TypePing          MessageType = 0x04
	TypePong          MessageType = 0x05
	TypeClose         MessageType = 0x06
	TypeAuthChallenge MessageType = 0x07
	TypeAuthProof     MessageType = 0x08

	TypeTermReset      MessageType = 0x10
	TypeTermOutput     MessageType = 0x11
	TypeTermInput      MessageType = 0x12
	TypeTermResize     MessageType = 0x13
	TypeProcessControl MessageType = 0x14
	TypeProcessState   MessageType = 0x15
	TypeOutputDropped  MessageType = 0x16

	TypeGameInit     MessageType = 0x20
	TypeGameInput    MessageType = 0x21
	TypeGameSnapshot MessageType = 0x22
	TypeGameEvent    MessageType = 0x23
	TypeGameResult   MessageType = 0x24
)

func (message MessageType) String() string {
	switch message {
	case TypeClientHello:
		return "CLIENT_HELLO"
	case TypeServerWelcome:
		return "SERVER_WELCOME"
	case TypeError:
		return "ERROR"
	case TypePing:
		return "PING"
	case TypePong:
		return "PONG"
	case TypeClose:
		return "CLOSE"
	case TypeAuthChallenge:
		return "AUTH_CHALLENGE"
	case TypeAuthProof:
		return "AUTH_PROOF"
	case TypeTermReset:
		return "TERM_RESET"
	case TypeTermOutput:
		return "TERM_OUTPUT"
	case TypeTermInput:
		return "TERM_INPUT"
	case TypeTermResize:
		return "TERM_RESIZE"
	case TypeProcessControl:
		return "PROCESS_CONTROL"
	case TypeProcessState:
		return "PROCESS_STATE"
	case TypeOutputDropped:
		return "OUTPUT_DROPPED"
	case TypeGameInit:
		return "GAME_INIT"
	case TypeGameInput:
		return "GAME_INPUT"
	case TypeGameSnapshot:
		return "GAME_SNAPSHOT"
	case TypeGameEvent:
		return "GAME_EVENT"
	case TypeGameResult:
		return "GAME_RESULT"
	default:
		return "UNKNOWN"
	}
}

type Peer uint8

const (
	PeerHost Peer = iota + 1
	PeerBrowser
)

func (peer Peer) other() Peer {
	if peer == PeerHost {
		return PeerBrowser
	}
	if peer == PeerBrowser {
		return PeerHost
	}
	return 0
}

type State uint8

const (
	StateAwaitClientHello State = iota + 1
	StateAwaitServerWelcome
	StateAwaitAuthProof
	StateActiveEscape
	StateActiveLeash
	StateClosing
)

type Frame struct {
	Type             MessageType
	Payload          []byte
	SelectedProtocol uint16
}

// ReadFrame reads one complete frame. Cancellation closes the supplied stream
// so a blocked read terminates without a helper goroutine.
func ReadFrame(ctx context.Context, stream io.ReadCloser, receiver Peer, state State) (Frame, error) {
	if ctx == nil || stream == nil || receiver.other() == 0 {
		return Frame{}, &ProtocolError{Code: CodeBadFrame}
	}
	if err := ctx.Err(); err != nil {
		return Frame{}, err
	}
	stopClose := context.AfterFunc(ctx, func() { _ = stream.Close() })
	defer stopClose()

	var lengthBytes [frameHeaderBytes]byte
	read, err := io.ReadFull(stream, lengthBytes[:])
	if err != nil {
		if ctx.Err() != nil {
			return Frame{}, ctx.Err()
		}
		if read == 0 && errors.Is(err, io.EOF) {
			return Frame{}, io.EOF
		}
		return Frame{}, &ProtocolError{Code: CodeBadFrame, truncated: true}
	}
	declaredLength := binary.BigEndian.Uint32(lengthBytes[:])
	if declaredLength < frameMetadataBytes {
		return Frame{}, &ProtocolError{Code: CodeBadFrame}
	}
	if declaredLength > MaxFrameLength {
		return Frame{}, &ProtocolError{Code: CodeFrameTooLarge}
	}

	var metadata [frameMetadataBytes]byte
	if _, err := io.ReadFull(stream, metadata[:]); err != nil {
		if ctx.Err() != nil {
			return Frame{}, ctx.Err()
		}
		return Frame{}, &ProtocolError{Code: CodeBadFrame, truncated: true}
	}
	message := MessageType(metadata[0])
	if metadata[1] != 0 {
		return Frame{}, &ProtocolError{Code: CodeBadFrame}
	}
	rule, ok := ruleFor(message)
	if !ok {
		return Frame{}, &ProtocolError{Code: CodeBadFrame}
	}
	if code := validateRoute(message, receiver.other(), state); code != "" {
		return Frame{}, &ProtocolError{Code: code}
	}
	payloadLength := int(declaredLength) - frameMetadataBytes
	if payloadLength < rule.minimum || payloadLength > rule.maximum ||
		(rule.exact >= 0 && payloadLength != rule.exact) {
		code := CodeBadFrame
		if rule.exact < 0 && payloadLength > rule.maximum {
			code = CodeFrameTooLarge
		}
		return Frame{}, &ProtocolError{Code: code}
	}

	payload := make([]byte, payloadLength)
	if _, err := io.ReadFull(stream, payload); err != nil {
		erase(payload)
		if ctx.Err() != nil {
			return Frame{}, ctx.Err()
		}
		return Frame{}, &ProtocolError{Code: CodeBadFrame, truncated: true}
	}
	selected, err := validatePayload(message, payload, receiver.other())
	if err != nil {
		erase(payload)
		return Frame{}, err
	}
	return Frame{Type: message, Payload: payload, SelectedProtocol: selected}, nil
}

// WriteFrame validates and writes one frame. Cancellation closes the supplied
// stream so a blocked write terminates without a helper goroutine.
func WriteFrame(ctx context.Context, stream io.WriteCloser, sender Peer, state State, frame Frame) error {
	if ctx == nil || stream == nil || sender.other() == 0 {
		return &ProtocolError{Code: CodeBadFrame}
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	rule, ok := ruleFor(frame.Type)
	if !ok {
		return &ProtocolError{Code: CodeBadFrame}
	}
	if code := validateRoute(frame.Type, sender, state); code != "" {
		return &ProtocolError{Code: code}
	}
	if len(frame.Payload) < rule.minimum || len(frame.Payload) > rule.maximum ||
		(rule.exact >= 0 && len(frame.Payload) != rule.exact) {
		code := CodeBadFrame
		if rule.exact < 0 && len(frame.Payload) > rule.maximum {
			code = CodeFrameTooLarge
		}
		return &ProtocolError{Code: code}
	}
	if _, err := validatePayload(frame.Type, frame.Payload, sender); err != nil {
		return err
	}

	var header [frameHeaderBytes + frameMetadataBytes]byte
	binary.BigEndian.PutUint32(header[:frameHeaderBytes], uint32(len(frame.Payload)+frameMetadataBytes))
	header[4] = byte(frame.Type)
	stopClose := context.AfterFunc(ctx, func() { _ = stream.Close() })
	defer stopClose()
	if err := writeAll(stream, header[:]); err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return ErrStream
	}
	if err := writeAll(stream, frame.Payload); err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return ErrStream
	}
	return nil
}

func writeAll(writer io.Writer, value []byte) error {
	for len(value) > 0 {
		written, err := writer.Write(value)
		if err != nil {
			return err
		}
		if written <= 0 || written > len(value) {
			return io.ErrShortWrite
		}
		value = value[written:]
	}
	return nil
}

func erase(value []byte) {
	for index := range value {
		value[index] = 0
	}
}
