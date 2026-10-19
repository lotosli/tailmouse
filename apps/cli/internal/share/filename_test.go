package share

import (
	"strings"
	"testing"
)

func TestReceiveNamesAndNormalization(t *testing.T) {
	for _, name := range []string{"", "../file", ".hidden", "dir/file", "dir\\file", "NUL", "con.txt", "COM1.log", "LPT9", "x\x00y", "x\ny", "a%2fb", "a%5Cb", "a%00b", "a:b", "trailing.", " trailing", strings.Repeat("x", 181), string([]byte{0xff})} {
		if _, e := SafeName(name); e == nil {
			t.Errorf("accepted unsafe name %q", name)
		}
	}
	if got, e := SafeName("cafe\u0301.txt"); e != nil || got != "café.txt" {
		t.Fatal("NFC normalization", got, e)
	}
}
