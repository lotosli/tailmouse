package protocol

import (
	"bytes"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"slices"
	"strings"
	"testing"
)

const fixtureSchema = "tailmouse.tmouse-fixtures/v1"

var credentialPatterns = []*regexp.Regexp{
	regexp.MustCompile(`\btc[A-Za-z0-9_-]{40,}\b`),
	regexp.MustCompile(`(?i)nodekey:|discokey:|private key|#/v1/`),
}

type fixtureCorpus struct {
	Schema string        `json:"schema"`
	Cases  []fixtureCase `json:"cases"`
}

type fixtureCase struct {
	ID          string        `json:"id"`
	Category    string        `json:"category"`
	Description string        `json:"description"`
	Receiver    string        `json:"receiver"`
	State       string        `json:"state"`
	Wire        fixtureWire   `json:"wire"`
	Fragments   []int         `json:"fragments,omitempty"`
	Expect      fixtureExpect `json:"expect"`
}

type fixtureWire struct {
	Hex         string `json:"hex,omitempty"`
	PrefixHex   string `json:"prefix_hex,omitempty"`
	RepeatHex   string `json:"repeat_hex,omitempty"`
	RepeatCount int    `json:"repeat_count,omitempty"`
}

type fixtureExpect struct {
	Accepted         bool   `json:"accepted"`
	Message          string `json:"message,omitempty"`
	Error            string `json:"error,omitempty"`
	SelectedProtocol int    `json:"selected_protocol,omitempty"`
}

func TestSharedFrameFixtureSchemaAndSecretBoundary(t *testing.T) {
	raw, corpus := loadFixtureCorpus(t)
	if len(raw) > 256*1024 {
		t.Fatal("frame fixture corpus exceeds its review bound")
	}
	if corpus.Schema != fixtureSchema || len(corpus.Cases) == 0 {
		t.Fatalf("fixture schema = %q, cases = %d", corpus.Schema, len(corpus.Cases))
	}

	categories := map[string]bool{}
	identifiers := map[string]bool{}
	for _, fixture := range corpus.Cases {
		if identifiers[fixture.ID] || !regexp.MustCompile(`^[a-z0-9-]+$`).MatchString(fixture.ID) {
			t.Fatalf("invalid or duplicate fixture id %q", fixture.ID)
		}
		identifiers[fixture.ID] = true
		categories[fixture.Category] = true
		validateFixtureMetadata(t, fixture)

		wire := materializeFixture(t, fixture.Wire)
		if len(wire) > 32772 {
			t.Fatalf("fixture %q materialized beyond the corpus bound", fixture.ID)
		}
		if fixture.Expect.Accepted {
			if len(wire) < 6 || int(binary.BigEndian.Uint32(wire[:4])) != len(wire)-4 {
				t.Fatalf("accepted fixture %q has inconsistent framing", fixture.ID)
			}
		}
		if len(fixture.Fragments) > 0 {
			total := 0
			for _, size := range fixture.Fragments {
				if size <= 0 {
					t.Fatalf("fixture %q has a non-positive fragment", fixture.ID)
				}
				total += size
			}
			if total != len(wire) {
				t.Fatalf("fixture %q fragment total = %d, bytes = %d", fixture.ID, total, len(wire))
			}
		}
		assertNoCredential(t, fixture.ID, wire)
	}

	wantCategories := []string{"boundary", "compatibility", "fragmented", "illegal-state", "malformed", "oversized", "valid"}
	for _, category := range wantCategories {
		if !categories[category] {
			t.Fatalf("fixture category %q is missing", category)
		}
	}
	assertNoCredential(t, "raw corpus", raw)
}

func loadFixtureCorpus(t testing.TB) ([]byte, fixtureCorpus) {
	t.Helper()
	raw, err := os.ReadFile(frameFixturePath(t))
	if err != nil {
		t.Fatal(err)
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	var corpus fixtureCorpus
	if err := decoder.Decode(&corpus); err != nil {
		t.Fatalf("decode shared frame fixtures: %v", err)
	}
	if decoder.Decode(&struct{}{}) == nil {
		t.Fatal("shared frame fixtures contain trailing JSON")
	}
	return raw, corpus
}

func validateFixtureMetadata(t *testing.T, fixture fixtureCase) {
	t.Helper()
	validCategories := []string{"boundary", "compatibility", "fragmented", "illegal-state", "malformed", "oversized", "valid"}
	validReceivers := []string{"browser", "host"}
	validStates := []string{"active-escape", "active-leash", "await-auth-proof", "await-client-hello", "await-server-welcome"}
	validMessages := []string{"AUTH_CHALLENGE", "AUTH_PROOF", "CLIENT_HELLO", "ERROR", "CLOSE", "GAME_INIT", "GAME_INPUT", "GAME_SNAPSHOT", "GAME_EVENT", "GAME_RESULT", "PING", "SERVER_WELCOME", "TERM_INPUT", "TERM_OUTPUT", "TERM_RESIZE", "TERM_RESET", "PROCESS_CONTROL", "PROCESS_STATE", "OUTPUT_DROPPED"}
	validErrors := []string{"AUTH_REQUIRED", "BAD_FRAME", "FRAME_TOO_LARGE", "MODE_MISMATCH", "PROTOCOL_MISMATCH"}
	if fixture.Description == "" || !slices.Contains(validCategories, fixture.Category) ||
		!slices.Contains(validReceivers, fixture.Receiver) || !slices.Contains(validStates, fixture.State) {
		t.Fatalf("fixture %q has invalid metadata", fixture.ID)
	}
	if fixture.Expect.Accepted == (fixture.Expect.Error != "") || fixture.Expect.Accepted == (fixture.Expect.Message == "") {
		t.Fatalf("fixture %q has an inconsistent expectation", fixture.ID)
	}
	if fixture.Expect.Accepted && !slices.Contains(validMessages, fixture.Expect.Message) {
		t.Fatalf("fixture %q names an unknown accepted message", fixture.ID)
	}
	if !fixture.Expect.Accepted && !slices.Contains(validErrors, fixture.Expect.Error) {
		t.Fatalf("fixture %q names an unknown expected error", fixture.ID)
	}
	if fixture.Expect.SelectedProtocol != 0 && fixture.Expect.SelectedProtocol != 1 && fixture.Expect.SelectedProtocol != 2 {
		t.Fatalf("fixture %q selects an unsupported protocol", fixture.ID)
	}
}

func materializeFixture(t testing.TB, wire fixtureWire) []byte {
	t.Helper()
	if wire.Hex != "" {
		if wire.PrefixHex != "" || wire.RepeatHex != "" || wire.RepeatCount != 0 {
			t.Fatal("literal fixture cannot also use a repeat template")
		}
		decoded, err := hex.DecodeString(wire.Hex)
		if err != nil {
			t.Fatalf("decode fixture hex: %v", err)
		}
		return decoded
	}
	if wire.PrefixHex == "" || len(wire.RepeatHex) != 2 || wire.RepeatCount <= 0 || wire.RepeatCount > 32766 {
		t.Fatal("invalid fixture repeat template")
	}
	prefix, err := hex.DecodeString(wire.PrefixHex)
	if err != nil {
		t.Fatalf("decode fixture prefix: %v", err)
	}
	repeated, err := hex.DecodeString(strings.Repeat(wire.RepeatHex, wire.RepeatCount))
	if err != nil {
		t.Fatalf("decode fixture repeat byte: %v", err)
	}
	return append(prefix, repeated...)
}

func assertNoCredential(t *testing.T, fixture string, value []byte) {
	t.Helper()
	for _, pattern := range credentialPatterns {
		if pattern.Find(value) != nil {
			t.Fatalf("fixture %q contains credential-shaped data", fixture)
		}
	}
}

func frameFixturePath(t testing.TB) string {
	t.Helper()
	_, source, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("cannot locate fixture test source")
	}
	return filepath.Clean(filepath.Join(filepath.Dir(source), "..", "..", "..", "..", "protocol", "fixtures", "v1", "frames.json"))
}
