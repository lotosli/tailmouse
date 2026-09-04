package protocol

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"math"
	"slices"
	"strconv"
)

type GamePoint struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
}

type GameMap struct {
	Name   string   `json:"name"`
	Width  float64  `json:"width"`
	Height float64  `json:"height"`
	Rows   []string `json:"rows"`
}

type GameConstants struct {
	MouseSpeed     float64 `json:"mouse_speed"`
	CatBaseSpeed   float64 `json:"cat_base_speed"`
	CatMaxSpeed    float64 `json:"cat_max_speed"`
	DashMultiplier float64 `json:"dash_multiplier"`
	DashDurationMS float64 `json:"dash_duration_ms"`
	DashCooldownMS float64 `json:"dash_cooldown_ms"`
}

type GamePresentation struct {
	Control     string `json:"control"`
	PhoneRender bool   `json:"phone_render"`
	ShowNet     bool   `json:"show_net"`
}

type GameInit struct {
	Seed            string           `json:"seed"`
	Map             GameMap          `json:"map"`
	Mouse           GamePoint        `json:"mouse"`
	Cat             GamePoint        `json:"cat"`
	Cheeses         []GamePoint      `json:"cheeses"`
	Exit            GamePoint        `json:"exit"`
	RoundDurationMS float64          `json:"round_duration_ms"`
	CountdownMS     float64          `json:"countdown_ms"`
	Constants       GameConstants    `json:"constants"`
	Presentation    GamePresentation `json:"presentation"`
}

func DecodeGameInit(frame Frame) (GameInit, error) {
	object, err := gameObject(frame, TypeGameInit, MaxControlPayload)
	var value GameInit
	if err != nil {
		return value, err
	}
	if !exactKeys(object, "seed", "map", "mouse", "cat", "cheeses", "exit", "round_duration_ms", "countdown_ms", "constants", "presentation") ||
		strictUnmarshal(frame.Payload, &value) != nil {
		return GameInit{}, &ProtocolError{Code: CodeBadFrame}
	}
	seed, err := strconv.ParseInt(value.Seed, 10, 64)
	if err != nil || strconv.FormatInt(seed, 10) != value.Seed || !integerBetween(value.RoundDurationMS, 30_000, 45_000) ||
		value.CountdownMS != 3000 || value.Constants != (GameConstants{6, 5.3, 6.2, 2.2, 350, 5000}) {
		return GameInit{}, &ProtocolError{Code: CodeBadFrame}
	}
	mapObject, mapErr := strictJSONObject(object["map"])
	constants, constantsErr := strictJSONObject(object["constants"])
	presentation, presentationErr := strictJSONObject(object["presentation"])
	if presentationErr != nil || !exactKeys(presentation, "control", "phone_render", "show_net") ||
		(value.Presentation.Control != "touch" && value.Presentation.Control != "tilt") ||
		!bytes.Equal(presentation["phone_render"], []byte("true")) && !bytes.Equal(presentation["phone_render"], []byte("false")) ||
		!bytes.Equal(presentation["show_net"], []byte("true")) && !bytes.Equal(presentation["show_net"], []byte("false")) {
		return GameInit{}, &ProtocolError{Code: CodeBadFrame}
	}
	if mapErr != nil || constantsErr != nil || !exactKeys(mapObject, "name", "width", "height", "rows") ||
		!exactKeys(constants, "mouse_speed", "cat_base_speed", "cat_max_speed", "dash_multiplier", "dash_duration_ms", "dash_cooldown_ms") ||
		!slices.Contains([]string{"courtyard", "pantry", "corridors", "switchbacks", "crossroads"}, value.Map.Name) ||
		value.Map.Width != 48 || value.Map.Height != 18 || len(value.Map.Rows) != 18 || len(value.Cheeses) != 2 {
		return GameInit{}, &ProtocolError{Code: CodeBadFrame}
	}
	for y, row := range value.Map.Rows {
		if len(row) != 48 {
			return GameInit{}, &ProtocolError{Code: CodeBadFrame}
		}
		for x, cell := range row {
			if cell != '#' && cell != '.' || (x == 0 || x == 47 || y == 0 || y == 17) && cell != '#' {
				return GameInit{}, &ProtocolError{Code: CodeBadFrame}
			}
		}
	}
	var cheeses []json.RawMessage
	_ = json.Unmarshal(object["cheeses"], &cheeses) // The exact two-element array is already validated.
	var occupied [18 * 48]bool
	for _, raw := range []json.RawMessage{object["mouse"], object["cat"], cheeses[0], cheeses[1], object["exit"]} {
		point, err := gamePoint(raw)
		if err != nil {
			return GameInit{}, err
		}
		x, y := int(point.X), int(point.Y)
		if occupied[y*48+x] || value.Map.Rows[y][x] != '.' {
			return GameInit{}, &ProtocolError{Code: CodeBadFrame}
		}
		occupied[y*48+x] = true
	}
	return value, nil
}

func GameInitFrame(value GameInit) (Frame, error) {
	return gameJSONFrame(TypeGameInit, value, PeerHost)
}

func gamePoint(payload []byte) (GamePoint, error) {
	object, err := strictJSONObject(payload)
	var point GamePoint
	if err != nil || !exactKeys(object, "x", "y") || !nonNullNumbers(object, "x", "y") ||
		strictUnmarshal(payload, &point) != nil || !validGamePoint(point) {
		return GamePoint{}, &ProtocolError{Code: CodeBadFrame}
	}
	return point, nil
}

func validGamePoint(point GamePoint) bool {
	return !math.IsNaN(point.X) && !math.IsNaN(point.Y) && point.X >= 0 && point.X < 48 && point.Y >= 0 && point.Y < 18
}

type GameInput struct {
	Sequence     uint32
	ClientTimeMS uint64
	VelocityX    float32
	VelocityY    float32
	Dash         bool
}

func DecodeGameInput(frame Frame) (GameInput, error) {
	payload := frame.Payload
	if frame.Type != TypeGameInput || len(payload) != 24 {
		return GameInput{}, &ProtocolError{Code: CodeBadFrame}
	}
	value := GameInput{
		Sequence: binary.BigEndian.Uint32(payload), ClientTimeMS: binary.BigEndian.Uint64(payload[4:]),
		VelocityX: math.Float32frombits(binary.BigEndian.Uint32(payload[12:])),
		VelocityY: math.Float32frombits(binary.BigEndian.Uint32(payload[16:])), Dash: payload[20]&1 != 0,
	}
	x, y := float64(value.VelocityX), float64(value.VelocityY)
	if value.Sequence == 0 || !finiteUnit(value.VelocityX) || !finiteUnit(value.VelocityY) || x*x+y*y > 1.000001 ||
		payload[20]&0xfe != 0 || payload[21] != 0 || payload[22] != 0 || payload[23] != 0 {
		return GameInput{}, &ProtocolError{Code: CodeBadFrame}
	}
	return value, nil
}

func GameInputFrame(value GameInput) (Frame, error) {
	payload := make([]byte, 24)
	binary.BigEndian.PutUint32(payload, value.Sequence)
	binary.BigEndian.PutUint64(payload[4:], value.ClientTimeMS)
	binary.BigEndian.PutUint32(payload[12:], math.Float32bits(value.VelocityX))
	binary.BigEndian.PutUint32(payload[16:], math.Float32bits(value.VelocityY))
	if value.Dash {
		payload[20] = 1
	}
	frame := Frame{Type: TypeGameInput, Payload: payload}
	if _, err := DecodeGameInput(frame); err != nil {
		return Frame{}, err
	}
	return frame, nil
}

type GameSnapshot struct {
	Sequence, AcceptedInputSequence uint32
	ElapsedMS                       uint64
	Mouse, Cat                      GamePoint
	RemainingMS, DashCooldownMS     uint32
	CollectedMask, Phase            uint8
	ExitOpen                        bool
}

func DecodeGameSnapshot(frame Frame) (GameSnapshot, error) {
	payload := frame.Payload
	if frame.Type != TypeGameSnapshot || len(payload) != 44 {
		return GameSnapshot{}, &ProtocolError{Code: CodeBadFrame}
	}
	coordinate := func(offset int) float64 {
		return float64(math.Float32frombits(binary.BigEndian.Uint32(payload[offset:])))
	}
	value := GameSnapshot{
		Sequence: binary.BigEndian.Uint32(payload), AcceptedInputSequence: binary.BigEndian.Uint32(payload[4:]),
		ElapsedMS: binary.BigEndian.Uint64(payload[8:]), Mouse: GamePoint{coordinate(16), coordinate(20)},
		Cat: GamePoint{coordinate(24), coordinate(28)}, RemainingMS: binary.BigEndian.Uint32(payload[32:]),
		DashCooldownMS: binary.BigEndian.Uint32(payload[36:]), CollectedMask: payload[40], Phase: payload[41], ExitOpen: payload[42]&1 != 0,
	}
	if value.Sequence == 0 || !validGamePoint(value.Mouse) || !validGamePoint(value.Cat) || value.RemainingMS > 45_000 ||
		value.DashCooldownMS > 5000 || value.CollectedMask > 3 || value.Phase > 2 ||
		payload[42]&0xfe != 0 || payload[43] != 0 || value.ExitOpen != (value.CollectedMask == 3) {
		return GameSnapshot{}, &ProtocolError{Code: CodeBadFrame}
	}
	return value, nil
}

func GameSnapshotFrame(value GameSnapshot) (Frame, error) {
	if !validGamePoint(value.Mouse) || !validGamePoint(value.Cat) {
		return Frame{}, &ProtocolError{Code: CodeBadFrame}
	}
	payload := make([]byte, 44)
	binary.BigEndian.PutUint32(payload, value.Sequence)
	binary.BigEndian.PutUint32(payload[4:], value.AcceptedInputSequence)
	binary.BigEndian.PutUint64(payload[8:], value.ElapsedMS)
	for index, coordinate := range []float64{value.Mouse.X, value.Mouse.Y, value.Cat.X, value.Cat.Y} {
		binary.BigEndian.PutUint32(payload[16+index*4:], math.Float32bits(float32(coordinate)))
	}
	binary.BigEndian.PutUint32(payload[32:], value.RemainingMS)
	binary.BigEndian.PutUint32(payload[36:], value.DashCooldownMS)
	payload[40], payload[41] = value.CollectedMask, value.Phase
	if value.ExitOpen {
		payload[42] = 1
	}
	frame := Frame{Type: TypeGameSnapshot, Payload: payload}
	if _, err := DecodeGameSnapshot(frame); err != nil {
		return Frame{}, err
	}
	return frame, nil
}

type GameEvent struct {
	Sequence float64  `json:"sequence"`
	Event    string   `json:"event"`
	Value    *float64 `json:"value"`
}

func DecodeGameEvent(frame Frame, sender Peer) (GameEvent, error) {
	object, err := gameObject(frame, TypeGameEvent, 1024)
	var value GameEvent
	if err != nil {
		return value, err
	}
	if !exactKeys(object, "sequence", "event", "value") || strictUnmarshal(frame.Payload, &value) != nil ||
		!integerBetween(value.Sequence, 1, math.MaxUint32) {
		return GameEvent{}, &ProtocolError{Code: CodeBadFrame}
	}
	valid := false
	if sender == PeerBrowser {
		valid = value.Event == "exit_requested" && value.Value == nil
	} else if sender == PeerHost {
		switch value.Event {
		case "countdown":
			valid = value.Value != nil && integerBetween(*value.Value, 0, 3)
		case "cheese_collected":
			valid = value.Value != nil && integerBetween(*value.Value, 0, 1)
		case "dash_rejected":
			valid = value.Value != nil && integerBetween(*value.Value, 0, 5000)
		case "exit_opened", "connection_paused", "connection_resumed":
			valid = value.Value == nil
		}
	}
	if !valid {
		return GameEvent{}, &ProtocolError{Code: CodeBadFrame}
	}
	return value, nil
}

func GameEventFrame(value GameEvent, sender Peer) (Frame, error) {
	return gameJSONFrame(TypeGameEvent, value, sender)
}

type GameResult struct {
	Outcome   string   `json:"outcome"`
	ElapsedMS float64  `json:"elapsed_ms"`
	Relay     string   `json:"relay"`
	RTTP50MS  float64  `json:"rtt_p50_ms"`
	RTTP95MS  float64  `json:"rtt_p95_ms"`
	JitterMS  *float64 `json:"jitter_ms"`
	Message   string   `json:"message"`
}

func DecodeGameResult(frame Frame) (GameResult, error) {
	object, err := gameObject(frame, TypeGameResult, 2048)
	var value GameResult
	if err != nil {
		return value, err
	}
	if !exactKeys(object, "outcome", "elapsed_ms", "relay", "rtt_p50_ms", "rtt_p95_ms", "jitter_ms", "message") ||
		!nonNullNumbers(object, "elapsed_ms", "rtt_p50_ms", "rtt_p95_ms") || strictUnmarshal(frame.Payload, &value) != nil ||
		!integerBetween(value.ElapsedMS, 0, 9_007_199_254_740_991) || !integerBetween(value.RTTP50MS, 0, 9_007_199_254_740_991) ||
		!integerBetween(value.RTTP95MS, value.RTTP50MS, 9_007_199_254_740_991) ||
		(value.JitterMS != nil && !integerBetween(*value.JitterMS, 0, 9_007_199_254_740_991)) || !validDiagnosticHost(value.Relay) ||
		value.Message == "" || value.Message != GameResultMessage(value.Outcome, value.RTTP50MS) {
		return GameResult{}, &ProtocolError{Code: CodeBadFrame}
	}
	return value, nil
}

// GameResultMessage is fixed local copy; callers never use peer-provided prose.
func GameResultMessage(outcome string, p50 float64) string {
	switch outcome {
	case "escaped":
		return "The cat was always " + strconv.FormatFloat(p50, 'f', 0, 64) + "ms too late."
	case "caught", "timeout":
		return "The connection was too good."
	case "connection_lost":
		return "Connection lost."
	default:
		return ""
	}
}

func GameResultFrame(value GameResult) (Frame, error) {
	return gameJSONFrame(TypeGameResult, value, PeerHost)
}

func gameObject(frame Frame, expected MessageType, limit int) (map[string]json.RawMessage, error) {
	if frame.Type != expected || len(frame.Payload) < 2 {
		return nil, &ProtocolError{Code: CodeBadFrame}
	}
	if len(frame.Payload) > limit {
		return nil, &ProtocolError{Code: CodeFrameTooLarge}
	}
	return strictJSONObject(frame.Payload)
}

func nonNullNumbers(object map[string]json.RawMessage, names ...string) bool {
	for _, name := range names {
		if bytes.Equal(bytes.TrimSpace(object[name]), []byte("null")) {
			return false
		}
	}
	return true
}

func gameJSONFrame(message MessageType, value any, sender Peer) (Frame, error) {
	payload, err := json.Marshal(value)
	if err != nil {
		return Frame{}, &ProtocolError{Code: CodeBadFrame}
	}
	if _, err := validatePayload(message, payload, sender); err != nil {
		return Frame{}, err
	}
	return Frame{Type: message, Payload: payload}, nil
}
