package share

import (
	"bytes"
	"fmt"
	"strings"
	"testing"
)

func TestMaximumPlainTextAndFileMetadataFitFrames(t *testing.T) {
	text := strings.Repeat("<&>", MaxText/3)
	if !ValidText(text) {
		t.Fatal("valid maximum text rejected")
	}
	var encoded bytes.Buffer
	if err := WriteJSON(&encoded, TextMessage{Type: "text.value", Text: text}); err != nil {
		t.Fatal("valid HTML text exceeded its frame", err)
	}
	frame, err := ReadFrame(&encoded)
	var value TextMessage
	if err != nil || Decode(frame, &value) != nil || value.Text != text {
		t.Fatal("maximum text did not round trip")
	}
	listing := FileList{Type: "files.list", Entries: []FileEntry{}}
	for i := 0; i < 40; i++ {
		name := strings.Repeat(`"`, 177) + fmt.Sprintf("%03d", i)
		path := strings.Repeat(`"`, 165) + "/" + strings.Repeat(`"`, 165) + "/" + name
		if !safeOfferPath(path, false) {
			t.Fatal("valid bounded path rejected")
		}
		listing.Entries = append(listing.Entries, FileEntry{Name: name, Path: path, Size: 123})
	}
	if err := WriteJSON(&encoded, listing); err != nil {
		t.Fatal("valid page exceeded its frame", err)
	}
	if encoded.Len() > MaxFrame+4 {
		t.Fatal("page exceeded framing bound")
	}
	if safeOfferPath(strings.Repeat("a", 180)+"/"+strings.Repeat("b", 180)+"/"+strings.Repeat("c", 151), false) {
		t.Fatal("oversized path accepted")
	}
}
