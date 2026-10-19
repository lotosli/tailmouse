package share

import (
	"bytes"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"os"
	"testing"
)

func TestWireBoundsAndStrictJSON(t *testing.T) {
	var b bytes.Buffer
	if e := WriteJSON(&b, Message{Type: "pong", Seq: 1}); e != nil {
		t.Fatal(e)
	}
	f, e := ReadFrame(&b)
	if e != nil {
		t.Fatal(e)
	}
	var m Message
	if e = Decode(f, &m); e != nil || m.Type != "pong" || m.Seq != 1 {
		t.Fatal("roundtrip")
	}
	for _, raw := range []string{`{"type":"pong","type":"resize"}`, `{"type":"pong","unknown":1}`, `{"type":"pong"} {}`, `[]`, `{"type":"pong","seq":-1}`, `{"type":"pong","seq":1.5}`} {
		if Decode(Frame{JSONFrame, []byte(raw)}, &m) == nil {
			t.Fatal("invalid JSON accepted")
		}
	}
	for _, n := range []uint32{0, MaxFrame + 1, ^uint32(0)} {
		var v [4]byte
		binary.BigEndian.PutUint32(v[:], n)
		if _, e := ReadFrame(bytes.NewReader(v[:])); e == nil {
			t.Fatal("unbounded frame accepted")
		}
	}
	if WriteFrame(&b, DataFrame, make([]byte, ChunkSize+1)) == nil || WriteFrame(&b, EndFrame, []byte{1}) == nil {
		t.Fatal("invalid frame emitted")
	}
}
func FuzzFrame(f *testing.F) {
	f.Add([]byte{0, 0, 0, 1, 3})
	f.Fuzz(func(t *testing.T, b []byte) {
		if len(b) > MaxFrame+4 {
			return
		}
		value, e := ReadFrame(bytes.NewReader(b))
		if e == nil {
			var encoded bytes.Buffer
			if WriteFrame(&encoded, value.Kind, value.Data) != nil {
				t.Fatal("accepted unencodable frame")
			}
		}
	})
}

func TestSharedTMOUSE2Corpus(t *testing.T) {
	data, e := os.ReadFile("../../../../protocol/fixtures/tmouse-2.frames.json")
	if e != nil {
		t.Fatal(e)
	}
	var corpus struct {
		Version int `json:"version"`
		Cases   []struct {
			Name  string `json:"name"`
			Hex   string `json:"hex"`
			Valid bool   `json:"valid"`
		} `json:"cases"`
	}
	if json.Unmarshal(data, &corpus) != nil || corpus.Version != 2 {
		t.Fatal("invalid fixture corpus")
	}
	for _, entry := range corpus.Cases {
		t.Run(entry.Name, func(t *testing.T) {
			b, e := hex.DecodeString(entry.Hex)
			if e != nil {
				t.Fatal(e)
			}
			f, e := ReadFrame(bytes.NewReader(b))
			if e == nil && f.Kind == JSONFrame {
				var value map[string]any
				e = Decode(f, &value)
			}
			if (e == nil) != entry.Valid {
				t.Fatal("conformance mismatch")
			}
		})
	}
}
