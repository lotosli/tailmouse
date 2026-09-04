package protocol

import (
	"fmt"
	"reflect"
	"strings"
	"testing"
)

func TestProcessExitCodePreservesNativeWidth(t *testing.T) {
	for _, code := range []int{0, 255, 256, 259, 65535, 0xC000013A, 0xFFFFFFFF} {
		t.Run(fmt.Sprint(code), func(t *testing.T) {
			value := ProcessState{Generation: 1, State: "exited", ExitCode: &code}
			frame, err := ProcessStateFrame(value)
			if err != nil {
				t.Fatal(err)
			}
			got, err := DecodeProcessState(frame)
			if err != nil || got.ExitCode == nil || *got.ExitCode != code {
				t.Fatalf("native exit status was changed: %+v, %v", got, err)
			}
		})
	}
	for _, code := range []string{"-1", "1.5", "4294967296", "9007199254740991", `"37"`} {
		payload := fmt.Sprintf(`{"generation":1,"state":"exited","pid":null,"started_at":null,"exit_code":%s,"signal":null}`, code)
		_, err := DecodeProcessState(Frame{Type: TypeProcessState, Payload: []byte(payload)})
		if got, ok := ErrorCodeOf(err); !ok || got != CodeBadFrame {
			t.Fatal("invalid native exit status was accepted")
		}
	}
}

func TestTerminalPayloadRoundTrips(t *testing.T) {
	pid, started, code, signal := uint64(42), int64(123), 130, "SIGINT"
	reset := TermReset{Generation: 1, Columns: 80, Rows: 24}
	control := ProcessControl{Action: "interrupt", Generation: 1}
	state := ProcessState{Generation: 2, State: "exited", PID: &pid, StartedAt: &started, ExitCode: &code, Signal: &signal, Title: "<terminal> 🐈"}
	dropped := OutputDropped{Generation: 2, Bytes: 9007199254740991}
	for _, test := range []struct {
		name   string
		encode func() (Frame, error)
		decode func(Frame) (any, error)
		want   any
	}{
		{"reset", func() (Frame, error) { return TermResetFrame(reset) }, func(f Frame) (any, error) { return DecodeTermReset(f) }, reset},
		{"control", func() (Frame, error) { return ProcessControlFrame(control) }, func(f Frame) (any, error) { return DecodeProcessControl(f) }, control},
		{"state", func() (Frame, error) { return ProcessStateFrame(state) }, func(f Frame) (any, error) { return DecodeProcessState(f) }, state},
		{"dropped", func() (Frame, error) { return OutputDroppedFrame(dropped) }, func(f Frame) (any, error) { return DecodeOutputDropped(f) }, dropped},
	} {
		t.Run(test.name, func(t *testing.T) {
			frame, err := test.encode()
			if err != nil {
				t.Fatal(err)
			}
			got, err := test.decode(frame)
			if err != nil || !reflect.DeepEqual(got, test.want) {
				t.Fatalf("round trip = %#v, %v; want %#v", got, err, test.want)
			}
			for _, bad := range []Frame{
				{Type: TypePing, Payload: frame.Payload},
				{Type: frame.Type},
				{Type: frame.Type, Payload: []byte(strings.Repeat(" ", 1025))},
				{Type: frame.Type, Payload: []byte(`{"generation":1,"secret":"not retained"}`)},
			} {
				if _, err := test.decode(bad); err == nil {
					t.Fatal("invalid terminal frame accepted")
				}
			}
		})
	}
}

func TestTerminalEncoderRejectsInvalidValues(t *testing.T) {
	for _, encode := range []func() (Frame, error){
		func() (Frame, error) { return TermResetFrame(TermReset{Generation: 1, Columns: 501, Rows: 24}) },
		func() (Frame, error) { return ProcessControlFrame(ProcessControl{Generation: 1, Action: "exec"}) },
		func() (Frame, error) { return ProcessStateFrame(ProcessState{Generation: 1, State: "unknown"}) },
		func() (Frame, error) { return OutputDroppedFrame(OutputDropped{Generation: 1, Bytes: 1 << 53}) },
		func() (Frame, error) { return terminalFrame(TypeTermReset, func() {}) },
	} {
		frame, err := encode()
		if code, ok := ErrorCodeOf(err); !ok || code != CodeBadFrame || len(frame.Payload) != 0 {
			t.Fatalf("invalid encode = %#v, %v", frame, err)
		}
	}
	for _, name := range []string{"SIGINT", "CTRL_C_EVENT", "SIGNAL_9"} {
		if !safeSignal(name) {
			t.Fatalf("safe signal %q rejected", name)
		}
	}
}

func TestTerminalTitleByteBoundsAndNormalization(t *testing.T) {
	for _, title := range []string{"", "terminal", "<terminal> 🐈", strings.Repeat("x", 256), strings.Repeat("🐈", 64), strings.Repeat("<>&", 85) + "<", strings.Repeat(`\"`, 128)} {
		state := ProcessState{Generation: 1, State: "waiting", Title: title}
		frame, err := ProcessStateFrame(state)
		if err != nil {
			t.Fatal(err)
		}
		got, err := DecodeProcessState(frame)
		if err != nil || got.Title != title || (title == "" && strings.Contains(string(frame.Payload), `"title"`)) {
			t.Fatal("title did not round trip or absent title was emitted")
		}
	}
	for _, title := range []string{strings.Repeat("x", 257), strings.Repeat("🐈", 65), "bad\x1b[2J", "bad\u009b2J", "bad\xff"} {
		frame, err := ProcessStateFrame(ProcessState{Generation: 1, State: "waiting", Title: title})
		if code, ok := ErrorCodeOf(err); !ok || code != CodeBadFrame || len(frame.Payload) != 0 {
			t.Fatal("invalid title encoded")
		}
	}
	frame := Frame{Type: TypeProcessState, Payload: []byte(`{"generation":1,"state":"waiting","pid":null,"started_at":null,"exit_code":null,"signal":null,"title":"\ud800"}`)}
	got, err := DecodeProcessState(frame)
	if err != nil || got.Title != "\ufffd" {
		t.Fatal("unpaired surrogate was not normalized consistently")
	}
}
