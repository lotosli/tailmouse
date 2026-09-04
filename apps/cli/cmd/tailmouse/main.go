package main

import (
	"context"
	"crypto/rand"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"os"
	"os/signal"
	"path/filepath"
	"sync"
	"time"

	"tailmouse/apps/cli/internal/config"
	"tailmouse/apps/cli/internal/invitation"
	"tailmouse/apps/cli/internal/leash"
	"tailmouse/apps/cli/internal/protocol"
	"tailmouse/apps/cli/internal/session"
	tailcattransport "tailmouse/apps/cli/internal/transport/tailcat"
)

const (
	exitOK         = config.ExitOK
	exitConfig     = config.ExitConfig
	exitInvitation = config.ExitInvitation
	exitTransport  = config.ExitTransport
	exitProtocol   = config.ExitProtocol
	exitExpired    = config.ExitExpired
	exitInternal   = config.ExitInternal
)

// Release builds stamp these with -ldflags; ordinary builds claim no release identity.
var buildVersion = "development"
var tailcatRevision = "unrecorded"

type transportServer interface {
	Relay() tailcattransport.Relay
	CopyAddress() ([]byte, error)
	Close(context.Context) error
}
type transportStarter func(context.Context, tailcattransport.Config) (transportServer, error)

func main() {
	interrupts := make(chan os.Signal, 8)
	signal.Notify(interrupts, processSignals()...)
	configDir, _ := os.UserConfigDir() // An explicit config path can still work.
	code := runWithSignals(context.Background(), os.Stdin, os.Args[1:], os.Environ(), configDir, os.Stdout, os.Stderr, startTailcat, interrupts)
	signal.Stop(interrupts)
	os.Exit(code)
}

func startTailcat(ctx context.Context, config tailcattransport.Config) (transportServer, error) {
	return tailcattransport.Start(ctx, config)
}

func run(ctx context.Context, stdin *os.File, args, environ []string, configDir string, stdout, stderr io.Writer, start transportStarter) int {
	return runWithSignals(ctx, stdin, args, environ, configDir, stdout, stderr, start, nil)
}

func runWithSignals(ctx context.Context, stdin *os.File, args, environ []string, configDir string, stdout, stderr io.Writer, start transportStarter, interrupts <-chan os.Signal) int {
	if ctx == nil || stdout == nil || stderr == nil || start == nil {
		return exitInternal
	}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	stopStartup := startupSignals(ctx, cancel, interrupts)
	defer stopStartup()
	options, help, err := config.Resolve(args, environ, configDir)
	if help {
		if err := config.WriteHelp(stdout, options.Command); err != nil {
			return exitInternal
		}
		return exitOK
	}
	if err != nil {
		log := newDiagnostics(options, stderr)
		if log.configurationFailure(err) != nil {
			return exitConfig // Preserve the earlier configuration failure.
		}
		if !options.JSON && !options.Quiet {
			if config.WriteHelp(stderr, options.Command) != nil {
				return exitConfig
			}
		}
		return exitConfig
	}
	switch options.Command {
	case "version":
		if _, err := fmt.Fprintf(stdout, "TailMouse %s\nTMOUSE protocol 1..1\nTailcat revision %s\n", buildVersion, tailcatRevision); err != nil {
			return exitInternal
		}
		return exitOK
	case "config path":
		if _, err := fmt.Fprintln(stdout, options.ConfigPath); err != nil {
			return exitInternal
		}
		return exitOK
	}
	if ctx.Err() != nil {
		_ = newDiagnostics(options, stderr).closed(exitExpired, "local_revoke")
		return exitExpired
	}
	var command *leash.Command
	if options.Command == "leash" {
		cwd, err := filepath.Abs(options.Leash.Cwd)
		if err == nil {
			command, err = leash.NewCommand(options.Leash.Argv, cwd, options.Leash.Title, environ, options.Leash.Env)
		}
		if err != nil {
			_ = newDiagnostics(options, stderr).configurationFailure(&config.Error{Field: "leash command", Source: config.Flag})
			return exitConfig
		}
	}
	return runSession(ctx, stdin, options, command, stdout, stderr, start, interrupts, stopStartup)
}

// Startup has one signal consumer. Joining it before Leash takes ownership
// prevents the first child interrupt racing with initialization cancellation.
func startupSignals(ctx context.Context, cancel context.CancelFunc, interrupts <-chan os.Signal) func() {
	done, stopped := make(chan struct{}), make(chan struct{})
	go func() {
		defer close(stopped)
		for {
			select {
			case <-ctx.Done():
				return
			case <-done:
				return
			case value, ok := <-interrupts:
				if !ok {
					return
				}
				if value == os.Interrupt || shutdownSignal(value) {
					cancel()
					return
				}
			}
		}
	}()
	var once sync.Once
	return func() { once.Do(func() { close(done); <-stopped }) }
}

func runSession(ctx context.Context, stdin *os.File, options config.Options, command *leash.Command, stdout, stderr io.Writer, start transportStarter, interrupts <-chan os.Signal, stopStartup func()) (code int) {
	log := newDiagnostics(options, stderr)
	reason := "internal_error"
	var childResult bool
	defer func() {
		if log.closed(code, reason) != nil && (code == exitOK || childResult) {
			code = exitInternal
		}
	}()
	identifier, err := invitation.NewSessionID()
	if err != nil {
		reason = "invitation_creation"
		return exitInvitation
	}
	defer clear(identifier[:])
	host, err := session.NewHost(ctx, session.Config{
		Mode: options.Command, SessionID: identifier, TTL: options.TTL,
		ReconnectGrace: options.Leash.ReconnectGrace, Readonly: options.Leash.Readonly,
		NoRestart: options.Leash.NoRestart, NoTerminate: options.Leash.NoTerminate,
	}, time.Now(), log.observe)
	if err != nil {
		reason = "session_configuration"
		return exitConfig
	}
	closeReason := "local_revoke"
	var server transportServer
	var cardInvitation *invitation.Invitation
	var applicationOnce, transportOnce sync.Once
	var accessFailure string
	// Keep an earlier access failure even if a later mode/console cleanup fails.
	var accessRoot bool
	closeApplication := func() {
		applicationOnce.Do(func() {
			if err := host.Close(closeReason); err != nil {
				accessFailure = "session_stream_shutdown"
				_ = log.cleanupFailure("session_stream_shutdown")
			}
		})
	}
	closeTransport := func() {
		transportOnce.Do(func() {
			if server != nil {
				closeContext, cancel := context.WithTimeout(context.Background(), 3*time.Second)
				defer cancel()
				if err := server.Close(closeContext); errors.Is(err, tailcattransport.ErrDrain) &&
					errors.Is(err, context.DeadlineExceeded) && !errors.Is(err, tailcattransport.ErrClose) {
					// Bounded drain followed by successful force-close is an
					// explicit shutdown outcome, not a new root failure.
					_ = log.drainTimeout()
				} else if err != nil {
					if accessFailure == "" {
						accessFailure = "transport_shutdown"
					}
					_ = log.cleanupFailure("transport_shutdown")
				}
			}
		})
	}
	// Both mode loops keep their console until application, mode and transport
	// cleanup finishes. A nil cleanup closes access only (or the startup path).
	shutdown := func(outcome session.Outcome, cleanup func() session.Outcome) {
		switch outcome {
		case session.ModeComplete:
			closeReason = "mode_complete"
		case session.TTLExpired, session.GraceExpired:
			closeReason = "expired"
		case session.ProtocolFailure:
			closeReason = "protocol_error"
		case session.TransportFailure:
			closeReason = "transport_error"
		}
		if outcome != "" {
			_, _ = host.Authority.Finish(outcome)
		}
		mayReplace := func(value session.Outcome) bool {
			return value == session.ModeComplete || options.Command == "leash" && childOutcome(value)
		}
		hadFailure := accessFailure != ""
		closeApplication()
		if !hadFailure && accessFailure != "" && mayReplace(outcome) {
			accessRoot = true
		}
		if cleanup != nil {
			outcome = cleanup()
		}
		hadFailure = accessFailure != ""
		closeTransport()
		if !hadFailure && accessFailure != "" && mayReplace(outcome) {
			accessRoot = true
		}
		if cleanup == nil && cardInvitation != nil {
			cardInvitation.Erase()
		}
	}
	defer func() {
		shutdown("", nil)
		if (code == exitOK || childResult || accessRoot) && accessFailure != "" {
			code, reason = exitTransport, accessFailure
			childResult = false
		}
	}()
	if options.Command == "leash" {
		if err := host.ConfigureLeash(); err != nil {
			reason = "terminal_configuration"
			return exitConfig
		}
		if err := host.PublishLeash(protocol.ProcessState{Generation: 1, State: "waiting", Title: command.Title()}, nil); err != nil {
			reason = "terminal_configuration"
			return exitConfig
		}
	}
	if options.Command == "escape" {
		seed := options.Escape.Seed
		if !options.Escape.SeedSet {
			var entropy [8]byte
			if _, err := rand.Read(entropy[:]); err != nil {
				reason = "game_seed"
				return exitInternal
			}
			seed = int64(binary.LittleEndian.Uint64(entropy[:]))
		}
		if err := host.ConfigureEscape(session.EscapeConfig{Map: options.Escape.Map, Seed: seed, Round: options.Escape.Round, Once: options.Once,
			Control: options.Escape.Control, PhoneRender: options.Escape.PhoneRender, ShowNet: options.Escape.ShowNet}); err != nil {
			reason = "game_configuration"
			return exitConfig
		}
	}
	snapshot := host.Authority.Inspect(time.Now())
	if err := log.begin(options, identifier, snapshot.ExpiresAt); err != nil {
		return exitInternal
	}
	if options.Command == "leash" {
		if err := log.processState(protocol.ProcessState{Generation: 1, State: "waiting"}); err != nil {
			return exitInternal
		}
	}
	startContext := ctx
	if !snapshot.ExpiresAt.IsZero() {
		var cancel context.CancelFunc
		startContext, cancel = context.WithDeadline(ctx, snapshot.ExpiresAt)
		defer cancel()
	}
	transportConfig := relayConfig(options.Relay)
	transportConfig.OnConnection = func(stream tailcattransport.ByteStream) { host.Accept(stream) }
	server, err = start(startContext, transportConfig)
	if err != nil {
		if startContext.Err() != nil {
			reason = "expired_or_revoked"
			return exitExpired
		}
		if errors.Is(err, tailcattransport.ErrInvalidConfig) {
			reason = "transport_configuration"
			return exitConfig
		}
		reason = "transport_start"
		return exitTransport
	}
	relay := server.Relay()
	if err := host.Listen(string(relay.Mode), relay.Host, time.Now()); err != nil {
		if errorCode, _ := protocol.ErrorCodeOf(err); errorCode == protocol.CodeExpired {
			reason = "expired"
			return exitExpired
		}
		reason = "session_metadata"
		return exitProtocol
	}
	if err := log.listening(relay, options.TTL == 0); err != nil {
		return exitInternal
	}
	address, err := server.CopyAddress()
	if err != nil {
		reason = "invitation_address"
		return exitInvitation
	}
	defer clear(address)
	expires := int64(0)
	if !snapshot.ExpiresAt.IsZero() {
		expires = snapshot.ExpiresAt.Unix()
	}
	card := invitation.MouseCard{
		Version: invitation.CardVersion, Mode: invitation.Mode(options.Command), TailcatAddr: string(address), Port: invitation.VirtualPort,
		SessionID: identifier, ExpiresAt: expires, ProtocolMin: 1, ProtocolMax: 1,
	}
	cardInvitation, err = invitation.New(options.WebBaseURL, card)
	card.TailcatAddr, card.SessionID = "", [16]byte{}
	clear(identifier[:])
	clear(address)
	if err != nil {
		reason = "invitation_creation"
		return exitInvitation
	}
	relayLabel := relay.Host
	if relay.Mode == tailcattransport.RelayOfficial {
		relayLabel = "official"
	}
	if err := cardInvitation.Render(stdout, time.Now(), invitation.DisplayOptions{Relay: relayLabel, NoQR: options.NoQR, Readonly: options.Leash.Readonly}); err != nil {
		reason = "invitation_display"
		return exitInvitation
	}
	var outcome session.Outcome
	if options.Command == "escape" {
		console, interactive, err := openEscapeConsole(stdin, stdout)
		if err != nil {
			reason = "terminal_initialization"
			return exitInternal
		}
		outcome, err = watchEscape(ctx, host, options, stdout, log, console, interactive, shutdown)
		if err != nil {
			_ = log.cleanupFailure("terminal_presentation")
		}
	} else {
		stopStartup()
		code, outcome = watchLeash(ctx, host, options, command, stdin, stdout, log, interrupts, shutdown)
		childResult = childOutcome(outcome)
		reason = string(outcome)
		return code
	}
	reason = string(outcome)
	switch outcome {
	case session.ModeComplete:
		return exitOK
	case session.TTLExpired, session.GraceExpired:
		return exitExpired
	case session.LocalRevoke:
		return exitExpired
	case session.ProtocolFailure:
		return exitProtocol
	case session.TransportFailure:
		return exitTransport
	case session.InternalFailure:
		return exitInternal
	default:
		return exitInternal
	}
}

// A nonzero child status is not an earlier TailMouse root failure. Required
// cleanup must still fail visibly, while host failures keep their first cause.
func childOutcome(outcome session.Outcome) bool {
	switch outcome {
	case session.ModeComplete, session.LocalRevoke, session.TTLExpired, session.GraceExpired:
		return true
	default:
		return false
	}
}

func relayConfig(relay config.Relay) tailcattransport.Config {
	result := tailcattransport.Config{DERPHosts: relay.Hosts, DERPMapURL: relay.MapURL}
	if len(relay.Hosts) > 0 {
		result.DERPRegion, result.RegionCode, result.RegionName = relay.RegionID, relay.RegionCode, relay.RegionName
		result.DERPPort, result.STUNPort = relay.DERPPort, relay.STUNPort
	}
	return result
}
