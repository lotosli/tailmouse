// Package share implements the four resource-sharing commands and their native authority.
package share

import (
	"bytes"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/BurntSushi/toml"
	"golang.org/x/net/publicsuffix"
)

var ErrConfig = errors.New("invalid resource-sharing configuration; see tailmouse --help")

type Options struct {
	Command                                          string
	Offer, Text                                      string
	TextEnabled                                      bool
	Argv                                             []string
	Cwd, Title, Target, Directory, Approval          string
	FrontendBase, ContentBase, DERPMap, CAFile       string
	DERPRegion, MaxClients, MaxFiles                 int
	MaxFile, MaxTotal                                int64
	TTL                                              time.Duration
	ReadOnly, AllowRemote, JSON, Open, Verbose, NoQR bool
	TestSingleOrigin                                 bool
}

func IsCommand(value string) bool {
	return value == "cli" || value == "web" || value == "receive" || value == "dev" || value == "send" || value == "files" || value == "text"
}

// Parse has no process, transport or directory-creation side effects.
func Parse(args, environ []string, configDir string) (Options, bool, error) {
	o := Options{TTL: time.Hour, Approval: "auto", MaxClients: 1, MaxFiles: 100, MaxFile: 256 << 20, MaxTotal: 1 << 30, Cwd: ".", FrontendBase: "https://tailmouse.com"}
	if len(args) == 0 || !IsCommand(args[0]) {
		return o, false, ErrConfig
	}
	o.Command = args[0]
	env := map[string]string{}
	for _, v := range environ {
		if k, x, ok := strings.Cut(v, "="); ok {
			env[k] = x
		}
	}
	configPath := filepath.Join(configDir, "tailmouse", "config.toml")
	explicit := false
	if v := env["TAILMOUSE_CONFIG"]; v != "" {
		configPath = v
		explicit = true
	}
	for i, a := range args[1:] {
		if strings.HasPrefix(a, "--config=") {
			configPath = strings.TrimPrefix(a, "--config=")
			explicit = true
		}
		if a == "--config" && i+2 < len(args) {
			configPath = args[i+2]
			explicit = true
		}
		if a == "--" {
			break
		}
	}
	var file struct {
		Version int            `toml:"version"`
		Share   map[string]any `toml:"share"`
	}
	if data, err := os.ReadFile(configPath); err == nil {
		if strings.HasSuffix(configPath, ".json") {
			var deployment struct {
				Version          int    `json:"version"`
				FrontendBase     string `json:"frontendBase"`
				ContentBase      string `json:"contentBase"`
				DERPMap          string `json:"derpMap,omitempty"`
				DERPRegion       int    `json:"derpRegion,omitempty"`
				ReleaseManifest  string `json:"releaseManifest"`
				TestSingleOrigin bool   `json:"testSingleOrigin,omitempty"`
			}
			decoder := json.NewDecoder(bytes.NewReader(data))
			decoder.DisallowUnknownFields()
			if len(data) > 4096 || decoder.Decode(&deployment) != nil || decoder.Decode(&struct{}{}) != io.EOF || deployment.Version != 1 || deployment.ReleaseManifest != "/web-manifest.json" || validateOrigins(deployment.FrontendBase, deployment.ContentBase, deployment.TestSingleOrigin) != nil || deployment.DERPRegion < 0 {
				return o, false, ErrConfig
			}
			file.Version = 1
			file.Share = map[string]any{"frontend-base": deployment.FrontendBase, "content-base": deployment.ContentBase, "derp-map": deployment.DERPMap, "derp-region": deployment.DERPRegion, "test-single-origin": deployment.TestSingleOrigin}
		} else if _, err = toml.Decode(string(data), &file); err != nil || file.Version != 1 {
			return o, false, ErrConfig
		}
	} else if explicit || !errors.Is(err, os.ErrNotExist) {
		return o, false, ErrConfig
	}
	fs := flag.NewFlagSet(o.Command, flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	var maxFile, maxTotal, program string
	fs.StringVar(&configPath, "config", configPath, "configuration file")
	fs.StringVar(&o.Cwd, "cwd", o.Cwd, "working directory")
	fs.StringVar(&o.Title, "title", "", "plain-text title")
	fs.StringVar(&o.Approval, "approval", o.Approval, "auto or manual")
	fs.StringVar(&o.FrontendBase, "frontend-base", o.FrontendBase, "trusted wildcard base")
	fs.BoolVar(&o.TestSingleOrigin, "test-single-origin", false, "trusted-application single-origin test deployment")
	fs.StringVar(&o.ContentBase, "content-base", o.ContentBase, "isolated wildcard base")
	fs.StringVar(&o.DERPMap, "derp-map", "", "local file or HTTPS URL")
	fs.StringVar(&o.CAFile, "ca-file", "", "additional PEM CA roots")
	fs.IntVar(&o.DERPRegion, "derp-region", 0, "DERP region")
	fs.IntVar(&o.MaxClients, "max-clients", o.MaxClients, "one through four")
	fs.IntVar(&o.MaxFiles, "max-files", o.MaxFiles, "upload creation attempts")
	fs.StringVar(&maxFile, "max-file", "256MiB", "maximum file size")
	fs.StringVar(&maxTotal, "max-total", "1GiB", "session traffic budget")
	fs.DurationVar(&o.TTL, "ttl", o.TTL, "session lifetime; 0 until local end")
	fs.BoolVar(&o.ReadOnly, "read-only", false, "readonly terminal")
	fs.BoolVar(&o.ReadOnly, "cli-read-only", false, "readonly Dev terminal")
	fs.BoolVar(&o.AllowRemote, "allow-remote", false, "authorize non-loopback target")
	fs.BoolVar(&o.JSON, "json", false, "structured events without local PTY input")
	fs.BoolVar(&o.Open, "open", false, "open guest link locally")
	fs.BoolVar(&o.Verbose, "verbose", false, "redacted diagnostics")
	fs.BoolVar(&o.NoQR, "no-qr", false, "omit QR")
	fs.StringVar(&o.Target, "web", "", "Dev web target")
	fs.StringVar(&o.Directory, "receive", "", "Dev receive directory")
	fs.StringVar(&program, "cli", "", "Dev executable without arguments")
	for k, v := range file.Share {
		if fs.Lookup(k) == nil || k == "config" {
			return o, false, ErrConfig
		}
		if err := fs.Set(k, fmt.Sprint(v)); err != nil {
			return o, false, ErrConfig
		}
	}
	var sourceErr error
	fs.VisitAll(func(f *flag.Flag) {
		if v, ok := env["TAILMOUSE_"+strings.ToUpper(strings.ReplaceAll(f.Name, "-", "_"))]; ok && f.Name != "config" {
			if err := fs.Set(f.Name, v); err != nil {
				sourceErr = ErrConfig
			}
		}
	})
	if sourceErr != nil {
		return o, false, sourceErr
	}
	// Separate literal command argv before flag parsing. Never shell-split --cli.
	flags := args[1:]
	var argv []string
	for i, a := range flags {
		if a == "--" {
			argv = append([]string{}, flags[i+1:]...)
			flags = flags[:i]
			break
		}
	}
	var flagArgs, positions []string
	for i := 0; i < len(flags); i++ {
		value := flags[i]
		if !strings.HasPrefix(value, "-") || value == "-" {
			positions = append(positions, value)
			continue
		}
		flagArgs = append(flagArgs, value)
		name, _, inline := strings.Cut(strings.TrimLeft(value, "-"), "=")
		f := fs.Lookup(name)
		if f == nil {
			continue
		}
		boolean, isBoolean := f.Value.(interface{ IsBoolFlag() bool })
		if !inline && !(isBoolean && boolean.IsBoolFlag()) && i+1 < len(flags) {
			i++
			flagArgs = append(flagArgs, flags[i])
		}
	}
	flagArgs = append(flagArgs, positions...)
	if err := fs.Parse(flagArgs); err != nil {
		return o, errors.Is(err, flag.ErrHelp), func() error {
			if errors.Is(err, flag.ErrHelp) {
				return nil
			}
			return ErrConfig
		}()
	}
	// The hosted pair is one default deployment, not permission to use custom
	// same-origin previews. Visit includes values set by files and environment.
	var customOrigin, explicitTestMode bool
	fs.Visit(func(f *flag.Flag) {
		switch f.Name {
		case "frontend-base", "content-base":
			customOrigin = true
		case "test-single-origin":
			explicitTestMode = true
		}
	})
	if !customOrigin {
		o.ContentBase = o.FrontendBase
		if !explicitTestMode {
			o.TestSingleOrigin = true
		}
	}
	rest := fs.Args()
	switch o.Command {
	case "cli":
		if len(rest) != 0 || program != "" || o.Target != "" || o.Directory != "" {
			return o, false, ErrConfig
		}
		o.Argv = argv
	case "web":
		if len(rest) != 1 || len(argv) != 0 || program != "" || o.Target != "" || o.Directory != "" {
			return o, false, ErrConfig
		}
		o.Target = rest[0]
	case "send", "files":
		if len(rest) != 1 || len(argv) != 0 || program != "" || o.Target != "" || o.Directory != "" {
			return o, false, ErrConfig
		}
		o.Offer = rest[0]
	case "text":
		if len(rest) > 1 || len(argv) != 0 || program != "" || o.Target != "" || o.Directory != "" {
			return o, false, ErrConfig
		}
		o.TextEnabled = true
		if len(rest) == 1 {
			o.Text = rest[0]
		}
		if !ValidText(o.Text) {
			return o, false, ErrConfig
		}
	case "receive":
		if len(rest) != 1 || len(argv) != 0 || program != "" || o.Target != "" || o.Directory != "" {
			return o, false, ErrConfig
		}
		o.Directory = rest[0]
	case "dev":
		if len(rest) != 0 || program != "" && len(argv) != 0 {
			return o, false, ErrConfig
		}
		o.Argv = argv
		if program != "" {
			o.Argv = []string{program}
		}
	}
	if o.ReadOnly && len(o.Argv) == 0 || (o.AllowRemote || o.CAFile != "") && o.Target == "" {
		return o, false, ErrConfig
	}
	var err error
	o.MaxFile, err = ParseSize(maxFile)
	if err != nil {
		return o, false, ErrConfig
	}
	o.MaxTotal, err = ParseSize(maxTotal)
	if err != nil {
		return o, false, ErrConfig
	}
	count := 0
	for _, set := range []bool{len(o.Argv) > 0, o.Target != "", o.Directory != "", o.Offer != "", o.TextEnabled} {
		if set {
			count++
		}
	}
	if count == 0 || o.Command == "dev" && count < 2 || o.Command == "cli" && len(o.Argv) == 0 || o.TTL < 0 || o.MaxClients < 1 || o.MaxClients > 4 || o.MaxFiles < 1 || o.MaxFiles > 10000 || o.MaxFile < 1 || o.MaxTotal < o.MaxFile || o.DERPRegion < 0 || (o.Approval != "auto" && o.Approval != "manual") || len(o.Title) > 256 || !utf8.ValidString(o.Title) || strings.ContainsFunc(o.Title, unicode.IsControl) {
		return o, false, ErrConfig
	}
	if err := validateOrigins(o.FrontendBase, o.ContentBase, o.TestSingleOrigin); err != nil || o.Target != "" && o.ContentBase == "" {
		return o, false, ErrConfig
	}
	o.Cwd, err = filepath.Abs(o.Cwd)
	if err != nil {
		return o, false, ErrConfig
	}
	info, err := os.Stat(o.Cwd)
	if err != nil || !info.IsDir() {
		return o, false, ErrConfig
	}
	if o.Directory != "" && !filepath.IsAbs(o.Directory) {
		o.Directory = filepath.Join(o.Cwd, o.Directory)
	}
	if o.Offer != "" && !filepath.IsAbs(o.Offer) {
		o.Offer = filepath.Join(o.Cwd, o.Offer)
	}
	if o.Target != "" {
		if _, err := ParseTarget(o.Target); err != nil {
			return o, false, err
		}
	}
	return o, false, nil
}

func ParseSize(value string) (int64, error) {
	units := []struct {
		s string
		n int64
	}{{"KiB", 1 << 10}, {"MiB", 1 << 20}, {"GiB", 1 << 30}, {"KB", 1000}, {"MB", 1000000}, {"GB", 1000000000}, {"B", 1}}
	for _, u := range units {
		if strings.HasSuffix(value, u.s) {
			v, err := strconv.ParseInt(strings.TrimSuffix(value, u.s), 10, 64)
			if err != nil || v < 0 || v > (1<<53-1)/u.n {
				return 0, ErrConfig
			}
			return v * u.n, nil
		}
	}
	return 0, ErrConfig
}

func ParseTarget(value string) (*url.URL, error) {
	if p, err := strconv.Atoi(value); err == nil {
		if p < 1 || p > 65535 {
			return nil, ErrConfig
		}
		value = "http://127.0.0.1:" + value
	} else if !strings.Contains(value, "://") {
		value = "http://" + value
	}
	u, err := url.Parse(value)
	if err != nil || u.User != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Hostname() == "" || strings.ContainsAny(u.Hostname(), "\\%\x00") {
		return nil, ErrConfig
	}
	if p := u.Port(); p != "" {
		n, e := strconv.Atoi(p)
		if e != nil || n < 1 || n > 65535 {
			return nil, ErrConfig
		}
	}
	if ip := net.ParseIP(u.Hostname()); ip != nil && ip.IsUnspecified() {
		return nil, ErrConfig
	}
	return u, nil
}

func ValidateOrigins(front, content string) error { return validateOrigins(front, content, false) }
func validateOrigins(front, content string, testSingleOrigin bool) error {
	bases := make([]*url.URL, 0, 2)
	for _, v := range []string{front, content} {
		if v == "" && len(bases) == 1 {
			return nil
		}
		u, e := url.Parse(v)
		if e != nil || u.Scheme != "https" || u.Hostname() == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") || net.ParseIP(u.Hostname()) != nil {
			return ErrConfig
		}
		bases = append(bases, u)
	}
	a, e := publicsuffix.EffectiveTLDPlusOne(bases[0].Hostname())
	b, f := publicsuffix.EffectiveTLDPlusOne(bases[1].Hostname())
	if testSingleOrigin {
		if bases[0].Scheme != bases[1].Scheme || bases[0].Host != bases[1].Host {
			return ErrConfig
		}
		return nil
	}
	frontHost, contentHost := strings.ToLower(bases[0].Hostname()), strings.ToLower(bases[1].Hostname())
	if frontHost == contentHost || strings.HasSuffix(frontHost, "."+contentHost) || strings.HasSuffix(contentHost, "."+frontHost) {
		return ErrConfig
	}
	if e != nil || f != nil || a == b && !testSingleOrigin {
		return ErrConfig
	}
	return nil
}

const Help = `TailMouse — Share a terminal. Share a web app. Receive files.
One command. One link. Just a browser.
Run tailmouse without arguments for guided startup; tailmouse update upgrades the executable.

  tailmouse cli [options] -- <program> [args...]
  tailmouse web [options] <port|host:port|http(s)://origin/path>
  tailmouse send [options] <file>          offer one file for download
  tailmouse files [options] <directory>   share a read-only directory
  tailmouse text [options] [text]         exchange temporary text (or pipe stdin)
  tailmouse receive [options] <existing-directory>
  tailmouse dev --web 5173 --receive ./uploads -- codex
  tailmouse dev --cli codex --web localhost:5173
  tailmouse escape                     retained minigame

Default: tailmouse.com, with no configuration file or account required.
The hosted UI and previews share an origin; use only apps you trust.
Common: --ttl 1h (0 until end), --title TEXT, --approval auto|manual,
  --max-clients 1 (1–4), --open, --json, --verbose, --no-qr,
  --derp-map FILE|HTTPS-URL, --derp-region ID, --config FILE,
  --frontend-base HTTPS-BASE, --content-base HTTPS-BASE.
Custom deployments: --config accepts TOML or deployment JSON. Configuring
either origin disables the hosted pairing. Web then needs a content base on
a different registrable domain, or explicit --test-single-origin for trusted
test apps. Origins must match the trusted static deployment.
CLI: --cwd DIR, --read-only (Dev: --cli-read-only).
Web: --allow-remote, --ca-file PEM. Shares the whole configured origin.
Receive: --max-file 256MiB, --max-total 1GiB, --max-files 100.
Dev: at least two resources; --cli PROGRAM cannot be combined with -- argv.
Precedence: CLI > TAILMOUSE_* environment > [share] TOML > defaults.
Manual approval needs a local TTY. Ctrl+] opens local management;
Ctrl+] twice sends the literal key. Local input takes remote control back.
The link grants access to the declared resources until revoked or expired.
Terminal sharing is not a sandbox or native desktop sharing. Browser traffic
uses encrypted Tailcat over DERP. No account or guest installation required.
`
