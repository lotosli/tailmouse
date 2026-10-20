package share

import (
	"unicode"
	"unicode/utf8"
)

const MaxText = 16384

func ValidText(value string) bool {
	return len(value) <= MaxText && utf8.ValidString(value) && !containsTextControl(value)
}
func containsTextControl(value string) bool {
	for _, c := range value {
		if unicode.IsControl(c) && c != '\n' && c != '\r' && c != '\t' {
			return true
		}
	}
	return false
}

type TextMessage struct {
	Type string `json:"type"`
	Text string `json:"text,omitempty"`
}

func (h *Host) TextValue() string { h.mu.Lock(); defer h.mu.Unlock(); return h.text }
func (h *Host) serveText(stream Stream) {
	f, err := ReadFrame(stream)
	if err != nil {
		return
	}
	var message TextMessage
	if Decode(f, &message) != nil || message.Type != "text.get" && message.Type != "text.set" || !ValidText(message.Text) || message.Type == "text.get" && message.Text != "" {
		_ = sendError(stream, "BAD_FRAME")
		return
	}
	h.mu.Lock()
	if !h.liveLocked() {
		h.mu.Unlock()
		_ = sendError(stream, "EXPIRED")
		return
	}
	if message.Type == "text.set" {
		h.text = message.Text
	}
	value := h.text
	h.mu.Unlock()
	if message.Type == "text.set" {
		h.emit(Event{Event: "text.received", Resource: "text", Bytes: int64(len(value))})
	}
	_ = WriteJSON(stream, TextMessage{"text.value", value})
}
