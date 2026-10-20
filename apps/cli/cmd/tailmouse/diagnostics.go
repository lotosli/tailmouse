package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"sync"
	"time"

	"tailmouse/apps/cli/internal/config"
	"tailmouse/apps/cli/internal/protocol"
	"tailmouse/apps/cli/internal/session"
	tailcattransport "tailmouse/apps/cli/internal/transport/tailcat"
)

// Only composition-root classifications and redacted session events enter this
// record. It has no arbitrary error, URL, argv, environment or payload field.
type diagnosticRecord struct {
	TS                  string                   `json:"ts"`
	Event               string                   `json:"event"`
	Session             string                   `json:"session,omitempty"`
	Mode                string                   `json:"mode,omitempty"`
	Host                string                   `json:"host,omitempty"`
	Expires             string                   `json:"expires,omitempty"`
	State               string                   `json:"state,omitempty"`
	AccessMode          string                   `json:"access_mode,omitempty"`
	Authentication      string                   `json:"authentication,omitempty"`
	AccessCodePresented *bool                    `json:"access_code_presented,omitempty"`
	Reason              string                   `json:"reason,omitempty"`
	Message             string                   `json:"message,omitempty"`
	Code                int                      `json:"code,omitempty"`
	Version             string                   `json:"version,omitempty"`
	Tailcat             string                   `json:"tailcat_revision,omitempty"`
	Sources             map[string]config.Source `json:"sources,omitempty"`
	Generation          uint32                   `json:"generation,omitempty"`
	PID                 *uint64                  `json:"pid,omitempty"`
	ExitCode            *int                     `json:"exit_code,omitempty"`
	Signal              *string                  `json:"signal,omitempty"`
	DroppedBytes        *uint64                  `json:"bytes,omitempty"`
	*session.LatencySnapshot
	Metrics *session.Metrics `json:"metrics,omitempty"`
}

type diagnostics struct {
	mu                     sync.Mutex
	writer                 io.Writer
	json                   bool
	quiet                  bool
	verbose                bool
	rawTerminal, spectator bool
	session, mode          string
	err                    error // First sink failure; never formatted into a diagnostic.
}

func (log *diagnostics) terminal(raw, spectator bool) {
	log.mu.Lock()
	defer log.mu.Unlock()
	log.rawTerminal, log.spectator = raw, spectator
}

func newDiagnostics(options config.Options, writer io.Writer) *diagnostics {
	return &diagnostics{writer: writer, json: options.JSON, quiet: options.Quiet, verbose: options.Verbose}
}

func (log *diagnostics) processState(state protocol.ProcessState) error {
	frame, err := protocol.ProcessStateFrame(state)
	if err != nil {
		return err
	}
	clear(frame.Payload)
	// Project fields explicitly: the display-only title may contain private
	// command information and never belongs in diagnostics.
	return log.write(diagnosticRecord{Event: "process_state", State: state.State,
		Generation: state.Generation, PID: state.PID, ExitCode: state.ExitCode, Signal: state.Signal}, false, false)
}

func (log *diagnostics) begin(options config.Options, identifier [16]byte, expires time.Time) error {
	hash := sha256.Sum256(identifier[:])
	log.session = hex.EncodeToString(hash[:4])
	log.mode = options.Command
	expiry := "none"
	if !expires.IsZero() {
		expiry = expires.UTC().Format(time.RFC3339)
	}
	if err := log.write(diagnosticRecord{Event: "session_created", Mode: options.Command, Expires: expiry}, false, false); err != nil {
		return err
	}
	sources := make(map[string]config.Source)
	for _, field := range []string{"config", "web-base-url", "derp-host", "derp-map-url", "ttl", "logging", "readonly", "reconnect-grace"} {
		sources[field] = options.SourceOf(field)
	}
	return log.write(diagnosticRecord{Event: "diagnostic_details", Version: buildVersion, Tailcat: tailcatRevision, Sources: sources}, false, true)
}

func (log *diagnostics) accessState(accessMode string, presented, readonly bool) error {
	if accessMode != "code" && accessMode != "link" || accessMode == "code" && !presented || accessMode == "link" && presented {
		return errors.New("invalid access diagnostic state")
	}
	if accessMode == "link" {
		message := "Password protection is disabled. Anyone with the full invitation can control the selected terminal process; running a shell grants shell-level access."
		if readonly {
			message = "Password protection is disabled. Anyone with the full invitation has view-only access until the share ends."
		}
		if err := log.write(diagnosticRecord{Event: "warning", Reason: "link_only_access", Message: message, AccessMode: accessMode}, true, false); err != nil {
			return err
		}
	}
	return log.write(diagnosticRecord{Event: "access_state", State: "waiting", AccessMode: accessMode,
		Authentication: "waiting", AccessCodePresented: &presented}, false, false)
}

func (log *diagnostics) invitationPresented() error {
	return log.write(diagnosticRecord{Event: "invitation_presented", State: "ready"}, false, false)
}

// Relay fields have passed Host.Listen's strict WELCOME metadata validation.
func (log *diagnostics) listening(relay tailcattransport.Relay, noTTL bool) error {
	if err := log.write(diagnosticRecord{Event: "relay_selected", Mode: string(relay.Mode), Host: relay.Host}, false, false); err != nil {
		return err
	}
	if err := log.write(diagnosticRecord{Event: "browser_waiting", State: "waiting"}, false, false); err != nil {
		return err
	}
	if log.mode == "escape" {
		if err := log.write(diagnosticRecord{Event: "warning", Reason: "bearer_link", Message: "Treat the invitation link like a password. Browser traffic is DERP-only."}, true, false); err != nil {
			return err
		}
	}
	if noTTL {
		return log.write(diagnosticRecord{Event: "warning", Reason: "no_ttl", Message: "No TTL; keep the invitation private until the Host share ends."}, true, false)
	}
	return nil
}

func (log *diagnostics) observe(event session.Event) error {
	record := diagnosticRecord{}
	switch event.Kind {
	case session.BrowserConnected:
		record.Event, record.State = "browser_connected", "active"
	case session.BrowserDisconnected:
		record.Event, record.State = "browser_disconnected", "disconnected"
	case session.RTTMeasured:
		record.Event = "rtt"
		record.LatencySnapshot = &event.Metrics.LatencySnapshot
	case session.TerminalOutputDropped:
		frame, err := protocol.OutputDroppedFrame(event.Dropped)
		if err != nil {
			return err
		}
		clear(frame.Payload)
		record.Event, record.Generation, record.DroppedBytes = "output_dropped", event.Dropped.Generation, &event.Dropped.Bytes
	default:
		return errors.New("invalid diagnostic event")
	}
	if log.verbose {
		record.Metrics = &event.Metrics
	}
	return log.write(record, false, false)
}

func (log *diagnostics) configurationFailure(err error) error {
	// Resolve owns these fixed field/source labels; arbitrary causes are never printed.
	message := "Invalid configuration; see tailmouse --help."
	var invalid *config.Error
	if errors.As(err, &invalid) {
		message = invalid.Error()
	}
	return log.write(diagnosticRecord{Event: "terminal_failure", Code: exitConfig, Reason: "configuration", Message: message}, true, false)
}

func (log *diagnostics) closed(code int, reason string) error {
	event := "session_closed"
	if code != exitOK && code != exitExpired {
		event = "terminal_failure"
	}
	return log.write(diagnosticRecord{Event: event, Code: code, Reason: reason}, code != exitOK, false)
}

func (log *diagnostics) cleanupFailure(reason string) error {
	return log.write(diagnosticRecord{Event: "cleanup_failure", Reason: reason}, true, false)
}

func (log *diagnostics) drainTimeout() error {
	return log.write(diagnosticRecord{Event: "warning", Reason: "transport_drain_timeout",
		Message: "TCP drain reached its deadline; transport was force-closed. The original session or child result is preserved."}, true, false)
}

func (log *diagnostics) write(record diagnosticRecord, essential, debug bool) error {
	log.mu.Lock()
	defer log.mu.Unlock()
	if log.err != nil {
		return log.err
	}
	if (log.quiet && !essential) || (debug && !log.verbose) {
		return nil
	}
	if log.spectator && !log.json && !log.verbose && (record.Event == "rtt" || record.Event == "browser_connected" || record.Event == "browser_disconnected") {
		return nil
	}
	record.TS, record.Session = time.Now().UTC().Format(time.RFC3339Nano), log.session
	var output []byte
	if log.json {
		output, log.err = json.Marshal(record)
		if log.err != nil {
			return log.err
		}
	} else {
		output = []byte(humanDiagnostic(record))
		if record.Metrics != nil {
			metrics := record.Metrics
			output = append(output, fmt.Sprintf("\nnetwork    bytes tx/rx %d/%d; frames tx/rx %d/%d; reconnects %d; protocol errors %d",
				metrics.BytesTX, metrics.BytesRX, metrics.FramesTX, metrics.FramesRX, metrics.ReconnectCount, metrics.ProtocolErrors)...)
			output = append(output, fmt.Sprintf("\nmode       ring %d bytes; dropped %d bytes; generation %d",
				metrics.OutputRingUsed, metrics.OutputDroppedBytes, metrics.ProcessGeneration)...)
		}
	}
	output = append(output, '\n')
	if log.rawTerminal {
		output = []byte(strings.ReplaceAll(string(output), "\n", "\r\n"))
	}
	count, err := log.writer.Write(output)
	if err == nil && count != len(output) {
		err = io.ErrShortWrite
	}
	log.err = err
	return err
}

func humanDiagnostic(record diagnosticRecord) string {
	switch record.Event {
	case "session_created":
		return fmt.Sprintf("mode       %s\nexpires    %s", record.Mode, record.Expires)
	case "relay_selected":
		return fmt.Sprintf("relay      %s / %s", record.Mode, record.Host)
	case "browser_waiting", "browser_connected", "browser_disconnected":
		return "browser    " + record.State
	case "access_state":
		if record.AccessMode == "code" {
			return "access     protected; authentication waiting; code presented on controlling terminal"
		}
		return "access     link-only; authentication not required"
	case "invitation_presented":
		return "invitation ready"
	case "rtt":
		return fmt.Sprintf("RTT        %.1f ms; jitter %.1f ms; p50 %.1f ms; p95 %.1f ms", record.RTTMS, record.JitterMS, record.P50MS, record.P95MS)
	case "process_state":
		text := fmt.Sprintf("process    %s; generation %d", record.State, record.Generation)
		if record.PID != nil {
			text += fmt.Sprintf("; pid %d", *record.PID)
		}
		if record.ExitCode != nil {
			text += fmt.Sprintf("; exit %d", *record.ExitCode)
		}
		if record.Signal != nil {
			text += "; signal " + *record.Signal
		}
		return text
	case "output_dropped":
		return fmt.Sprintf("output     %d bytes dropped in generation %d (cumulative)", *record.DroppedBytes, record.Generation)
	case "diagnostic_details":
		sources, _ := json.Marshal(record.Sources) // A fixed string-to-enum map cannot fail.
		return fmt.Sprintf("build      %s; TMOUSE 1..1; Tailcat %s\nsources    %s", record.Version, record.Tailcat, sources)
	case "warning":
		return "Warning: " + record.Message
	default:
		if record.Message != "" {
			return record.Message
		}
		return fmt.Sprintf("%s: %s (exit %d)", record.Event, record.Reason, record.Code)
	}
}
