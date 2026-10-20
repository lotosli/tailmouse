package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/skip2/go-qrcode"
	"golang.org/x/term"
	"tailmouse/apps/cli/internal/share"
	tailcattransport "tailmouse/apps/cli/internal/transport/tailcat"
)

// shareOutput serializes the deliberate invitation surface with local PTY
// output. Diagnostic events never include the invitation or upstream errors.
type shareOutput struct {
	mu     sync.Mutex
	writer io.Writer
}

func (w *shareOutput) Write(data []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.writer.Write(data)
}
func runShare(ctx context.Context, stdin *os.File, args, environ []string, configDir string, stdout, stderr io.Writer, start transportStarter, interrupts <-chan os.Signal, stopStartup func()) (code int) {
	options, help, err := share.Parse(args, environ, configDir)
	structured := options.JSON
	for _, argument := range args[1:] {
		if argument == "--" {
			break
		}
		if argument == "--json" || argument == "--json=true" {
			structured = true
		}
		if argument == "--json=false" {
			structured = false
		}
	}
	defer func() {
		if structured && code != 0 {
			_ = json.NewEncoder(stdout).Encode(share.Event{Event: "share.error", Code: map[int]string{2: "CONFIGURATION", 3: "RESOURCE_START", 4: "TRANSPORT", 5: "SECURITY_POLICY", 6: "INTERNAL"}[code]})
		}
	}()
	if help {
		if _, err = io.WriteString(stdout, share.Help); err != nil {
			return 6
		}
		return 0
	}
	if err != nil {
		_, _ = fmt.Fprintln(stderr, "Invalid sharing configuration. Run tailmouse", args[0], "--help.")
		return 2
	}
	isTTY := stdin != nil && term.IsTerminal(int(stdin.Fd()))
	if options.Approval == "manual" && !isTTY || options.JSON && isTTY && len(options.Argv) > 0 {
		_, _ = fmt.Fprintln(stderr, "Manual approval requires a local terminal; --json cannot use interactive local PTY input.")
		return 2
	}
	if options.TextEnabled && options.Text == "" && !isTTY && stdin != nil {
		data, readErr := io.ReadAll(io.LimitReader(stdin, share.MaxText+1))
		if readErr != nil || !share.ValidText(string(data)) {
			_, _ = fmt.Fprintln(stderr, "Text must be valid plain UTF-8, at most 16 KiB.")
			return 2
		}
		options.Text = string(data)
		clear(data)
	}
	sessionCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	host, token, err := share.NewHost(sessionCtx, options, environ)
	if err != nil {
		_, _ = fmt.Fprintln(stderr, "Resource initialization failed; check the command, directory, target and TLS policy.")
		if errors.Is(err, share.ErrConfig) {
			return 2
		}
		if errors.Is(err, share.ErrWebPolicy) || errors.Is(err, share.ErrWebTLS) {
			return 5
		}
		return 3
	}
	var transport transportServer
	var console *leashLocalConsole
	defer func() {
		cancel()
		if err := host.Close(); err != nil && code == 0 {
			code = 6
		}
		if transport != nil {
			closeCtx, stop := context.WithTimeout(context.Background(), 2*time.Second)
			if err := transport.Close(closeCtx); err != nil && code == 0 {
				code = 4
			}
			stop()
		}
		if console != nil {
			if err := console.Close(); err != nil && code == 0 {
				code = 6
			}
		}
	}()
	transportConfig := tailcattransport.Config{BindPeer: true, PreferredRegion: options.DERPRegion, OnConnection: func(stream tailcattransport.ByteStream) { host.Serve(stream, tailcattransport.PeerIdentity(stream)) }}
	if options.DERPMap != "" {
		if strings.HasPrefix(options.DERPMap, "https://") {
			transportConfig.DERPMapURL = options.DERPMap
		} else {
			transportConfig.DERPMapFile = options.DERPMap
		}
	}
	transport, err = start(sessionCtx, transportConfig)
	if err != nil {
		_, _ = fmt.Fprintln(stderr, "Tailcat transport could not start.")
		return 4
	}
	address, err := transport.CopyAddress()
	if err != nil {
		return 4
	}
	defer clear(address)
	output := &shareOutput{writer: stdout}
	publish := func(secret string) error {
		link, e := host.Invitation(string(address), secret)
		if e != nil {
			return e
		}
		if options.JSON {
			event := struct {
				Event   string `json:"event"`
				URL     string `json:"url"`
				TTL     string `json:"ttl"`
				Command string `json:"command"`
			}{"share.created", link, options.TTL.String(), options.Command}
			if e = json.NewEncoder(output).Encode(event); e != nil {
				return e
			}
			if options.Open {
				if e = openShareBrowser(sessionCtx, link); e != nil {
					_, _ = fmt.Fprintln(stderr, "Could not open a local browser; use the displayed link.")
				}
			}
			return nil
		}
		if options.TTL == 0 {
			if _, e = io.WriteString(output, "NO EXPIRATION: access continues until you end or revoke this session.\n"); e != nil {
				return e
			}
		}
		rights := "observe and control"
		if len(options.Argv) == 0 {
			switch {
			case options.Offer != "":
				rights = "download selected files (read-only)"
			case options.TextEnabled:
				rights = "exchange temporary text"
			case options.Directory != "":
				rights = "upload files to the selected directory"
			default:
				rights = "preview the configured web app"
			}
		}
		if options.ReadOnly {
			rights = "observe terminal only"
		}
		_, e = fmt.Fprintf(output, "TailMouse %s — %s\nTTL: %s; members: %d; approval: %s\nTransport: encrypted Tailcat over DERP\n%s\n", options.Command, rights, options.TTL, options.MaxClients, options.Approval, link)
		if e != nil {
			return e
		}
		if options.Target != "" {
			if _, e = io.WriteString(output, "Web scope: whole configured origin.\n"); e != nil {
				return e
			}
		}
		if options.Directory != "" {
			if _, e = io.WriteString(output, "Uploads never execute automatically.\n"); e != nil {
				return e
			}
		}
		if file, ok := stdout.(*os.File); ok && term.IsTerminal(int(file.Fd())) && !options.NoQR {
			qr, e := qrcode.New(link, qrcode.Medium)
			if e != nil {
				return errors.New("share QR could not be encoded")
			}
			if _, e = io.WriteString(output, qr.ToSmallString(false)); e != nil {
				return e
			}
		}
		if options.Open {
			if e = openShareBrowser(sessionCtx, link); e != nil {
				_, _ = fmt.Fprintln(stderr, "Could not open a local browser; use the displayed link.")
			}
		}
		if options.TextEnabled && !options.JSON {
			if _, err := io.WriteString(output, "Type a line and press Enter to update shared text. Ctrl+C ends sharing.\n"); err != nil {
				return err
			}
		}
		return nil
	}
	host.Ready()
	if err = publish(token); err != nil {
		return 6
	}
	token = ""
	if options.JSON {
		if err = json.NewEncoder(output).Encode(struct {
			Event string `json:"event"`
		}{"share.ready"}); err != nil {
			return 6
		}
	}
	var inputDone chan error
	if isTTY && !options.JSON {
		file, ok := stdout.(*os.File)
		if !ok {
			return 3
		}
		console, err = openLeashConsole(stdin, file)
		if err != nil {
			return 3
		}

		output.mu.Lock()
		output.writer = shareConsoleWriter{console, sessionCtx}
		output.mu.Unlock()
		if terminal := host.Terminal(); terminal != nil {
			terminal.SetLocal(output)
			cols, rows, e := console.Size()
			if e == nil && cols >= 20 && rows >= 5 {
				if terminal.LocalResize(sessionCtx, cols, rows) != nil {
					return 3
				}
			}
		}
		inputDone = make(chan error, 1)
		go func() { inputDone <- manageShare(sessionCtx, console, host, output, publish, cancel) }()
	}
	stopStartup()
waiting:
	for {
		select {
		case <-host.Context().Done():
			break waiting
		case event := <-host.Events():
			if options.JSON {
				if json.NewEncoder(output).Encode(event) != nil {
					return 6
				}
			} else if event.Event == "text.received" {
				if _, err := fmt.Fprintf(output, "\r\nReceived shared text:\r\n%s\r\n", host.TextValue()); err != nil {
					return 6
				}
			} else if event.Event == "member.waiting" {
				if _, err := io.WriteString(output, "\r\nA visitor is waiting. Ctrl+] then a and the visitor number approves access.\r\n"); err != nil {
					return 6
				}
			}
		case inputErr := <-inputDone:
			inputDone = nil
			if inputErr != nil {
				return 6
			}
			cancel()
			break waiting
		case value, ok := <-interrupts:
			if !ok {
				interrupts = nil
				continue
			}
			if value == os.Interrupt || shutdownSignal(value) {
				cancel()
				break waiting
			}
			if leashResizeSignal(value) && console != nil && host.Terminal() != nil {
				cols, rows, e := console.Size()
				if e == nil && cols >= 20 && cols <= 500 && rows >= 5 && rows <= 200 {
					if host.Terminal().LocalResize(sessionCtx, cols, rows) != nil {
						return 6
					}
				}
			}
		}
	}
	cancel()
	if inputDone != nil {
		if err := <-inputDone; err != nil {
			return 6
		}
	}
	if host.Terminal() != nil && host.Terminal().Err() != nil {
		return 6
	}
	if options.JSON {
		if err = json.NewEncoder(output).Encode(struct {
			Event string `json:"event"`
		}{"share.closed"}); err != nil {
			return 6
		}
	}
	return 0
}
func manageShare(ctx context.Context, console *leashLocalConsole, host *share.Host, output io.Writer, publish func(string) error, cancel context.CancelFunc) (failure error) {
	buffer := make([]byte, 4096)
	menu := false
	var textInput shareTextInput
	defer func() { clear(textInput.data) }()
	var selection byte
	for {
		n, e := console.ReadInput(ctx, buffer)
		if e != nil {
			if ctx.Err() == nil && !errors.Is(e, io.EOF) {
				return errors.New("local input failed")
			}
			return
		}
		start := 0
		flush := func(end int) bool {
			if end > start && host.HasText() && host.Terminal() == nil {
				return textInput.Feed(host, buffer[start:end], output) == nil
			}
			if end > start && host.Terminal() != nil && host.Terminal().Running() {
				if host.Terminal().LocalInput(ctx, buffer[start:end]) != nil {
					return false
				}
			}
			return true
		}
		for i := 0; i < n; i++ {
			key := buffer[i]
			if selection != 0 {
				ok := false
				if key >= '1' && key <= '4' {
					switch selection {
					case 'a':
						ok = host.ApproveMember(int(key - '0'))
					case 'g':
						ok = host.GrantMember(int(key - '0'))
					case 'x':
						ok = host.RevokeMember(int(key - '0'))
					}
				}
				selection = 0
				start = i + 1
				if !ok {
					if _, e := io.WriteString(output, "\r\nVisitor action unavailable.\r\n"); e != nil {
						return errors.New("local output failed")
					}
				}
				continue
			}
			if key == 3 && host.Terminal() == nil {
				cancel()
				return
			}
			if menu {
				menu = false
				switch key {
				case 0x1d:
					if host.Terminal() != nil {
						if host.Terminal().LocalInput(ctx, []byte{0x1d}) != nil {
							return errors.New("local terminal input failed")
						}
					}
				case 'p':
					host.Pause()
				case 'a', 'g', 'x':
					selection = key
					if _, e := io.WriteString(output, "\r\nChoose visitor 1–4: "); e != nil {
						return errors.New("local output failed")
					}
				case 'r':
					host.TakeLocal()
					if host.Terminal() != nil {
						if host.Terminal().RestoreLocal(ctx) != nil {
							cancel()
							return errors.New("local terminal resize failed")
						}
					}
				case 'i':
					if publish(host.Rotate()) != nil {
						cancel()
						return errors.New("local invitation output failed")
					}
				case 'q':
					cancel()
					return
				}
				start = i + 1
				continue
			}
			if key == 0x1d {
				if !flush(i) {
					return errors.New("local terminal input failed")
				}
				menu = true
				start = i + 1
				for _, member := range host.Members() {
					if _, e := fmt.Fprintf(output, "\r\nVisitor %d: approved=%t connected=%t controls-input=%t", member.Slot, member.Approved, member.Connected, member.Controller); e != nil {
						return errors.New("local output failed")
					}
				}
				if _, e := io.WriteString(output, "\r\nTailMouse: [p] pause admission  [a] approve visitor  [g] grant input  [x] revoke visitor  [r] revoke input  [i] rotate invite  [q] end\r\n"); e != nil {
					return errors.New("local output failed")
				}
			}
		}
		if !menu && !flush(n) {
			return errors.New("local terminal input failed")
		}
	}
}

type shareConsoleWriter struct {
	console *leashLocalConsole
	ctx     context.Context
}

func (w shareConsoleWriter) Write(data []byte) (int, error) {
	if e := w.console.Write(w.ctx, string(data)); e != nil {
		return 0, e
	}
	return len(data), nil
}
