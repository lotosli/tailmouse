package share

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"unicode/utf8"
)

const Preface = "TMOUSE/2\n"
const MaxFrame = 65536
const ChunkSize = 32768
const (
	JSONFrame byte = 1
	DataFrame byte = 2
	EndFrame  byte = 3
)

var ErrFrame = errors.New("BAD_FRAME")

type Frame struct {
	Kind byte
	Data []byte
}

func ReadFrame(r io.Reader) (Frame, error) {
	var h [4]byte
	if _, e := io.ReadFull(r, h[:]); e != nil {
		return Frame{}, e
	}
	n := binary.BigEndian.Uint32(h[:])
	if n < 1 || n > MaxFrame {
		return Frame{}, ErrFrame
	}
	var kind [1]byte
	if _, e := io.ReadFull(r, kind[:]); e != nil {
		return Frame{}, e
	}
	if kind[0] < JSONFrame || kind[0] > EndFrame || kind[0] == DataFrame && n > ChunkSize+1 || kind[0] == EndFrame && n != 1 {
		return Frame{}, ErrFrame
	}
	b := make([]byte, n-1)
	if _, e := io.ReadFull(r, b); e != nil {
		return Frame{}, e
	}
	return Frame{kind[0], b}, nil
}
func WriteFrame(w io.Writer, kind byte, data []byte) error {
	if len(data)+1 > MaxFrame || kind < 1 || kind > 3 || kind == DataFrame && len(data) > ChunkSize || kind == EndFrame && len(data) != 0 {
		return ErrFrame
	}
	var header [5]byte
	binary.BigEndian.PutUint32(header[:4], uint32(len(data)+1))
	header[4] = kind
	if e := writeFull(w, header[:]); e != nil {
		return e
	}
	return writeFull(w, data)
}
func writeFull(w io.Writer, data []byte) error {
	for len(data) > 0 {
		n, e := w.Write(data)
		if e != nil {
			return e
		}
		if n <= 0 || n > len(data) {
			return io.ErrShortWrite
		}
		data = data[n:]
	}
	return nil
}
func WriteJSON(w io.Writer, value any) error {
	b, e := json.Marshal(value)
	if e != nil {
		return ErrFrame
	}
	return WriteFrame(w, JSONFrame, b)
}
func Decode(f Frame, out any) error {
	if f.Kind != JSONFrame || !utf8.Valid(f.Data) || len(f.Data) == 0 || f.Data[0] != '{' {
		return ErrFrame
	}
	d := json.NewDecoder(bytes.NewReader(f.Data))
	if e := uniqueJSON(d, 0); e != nil {
		return ErrFrame
	}
	if _, e := d.Token(); e != io.EOF {
		return ErrFrame
	}
	d = json.NewDecoder(bytes.NewReader(f.Data))
	d.DisallowUnknownFields()
	if d.Decode(out) != nil {
		return ErrFrame
	}
	return nil
}
func uniqueJSON(d *json.Decoder, depth int) error {
	if depth > 12 {
		return ErrFrame
	}
	t, e := d.Token()
	if e != nil {
		return e
	}
	delim, ok := t.(json.Delim)
	if !ok {
		return nil
	}
	switch delim {
	case '{':
		seen := map[string]bool{}
		for d.More() {
			key, e := d.Token()
			s, ok := key.(string)
			if e != nil || !ok || seen[s] {
				return ErrFrame
			}
			seen[s] = true
			if e = uniqueJSON(d, depth+1); e != nil {
				return e
			}
		}
	case '[':
		for d.More() {
			if e = uniqueJSON(d, depth+1); e != nil {
				return e
			}
		}
	default:
		return ErrFrame
	}
	_, e = d.Token()
	return e
}

type Hello struct {
	Type     string `json:"type"`
	Version  int    `json:"version"`
	Session  string `json:"session"`
	Channel  string `json:"channel"`
	Token    string `json:"token,omitempty"`
	Member   string `json:"member,omitempty"`
	Grant    string `json:"grant,omitempty"`
	Resource string `json:"resource,omitempty"`
}
type Message struct {
	Type   string `json:"type"`
	Seq    uint64 `json:"seq,omitempty"`
	Cols   int    `json:"cols,omitempty"`
	Rows   int    `json:"rows,omitempty"`
	Name   string `json:"name,omitempty"`
	Size   int64  `json:"size,omitempty"`
	SHA256 string `json:"sha256,omitempty"`
	Upload string `json:"upload,omitempty"`
}
type WireError struct {
	Type string `json:"type"`
	Code string `json:"code"`
}

func sendError(w io.Writer, code string) error { return WriteJSON(w, WireError{"error", code}) }
