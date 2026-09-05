//go:build tailcatintegration && (darwin || linux)

package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"

	"tailmouse/apps/cli/internal/invitation"
	tailcattransport "tailmouse/apps/cli/internal/transport/tailcat"
)

// Run with pnpm test:leash. All cases use the real CLI owner, native PTY,
// loopback DERP, recorded Tailcat Wasm and production Web build.
func TestHermeticLeashBrowser(t *testing.T) {
	for _, scenario := range []string{"cli", "vim", "shell", "long-task", "reconnect", "retained-exit", "browser-crash", "browser-crash-kill"} {
		t.Run(scenario, func(t *testing.T) { testNativeBrowser(t, scenario, nil) })
	}
}

// Run separately from functional acceptance so timing is not presented as
// physical-device or production-relay evidence.
func TestHermeticLeashStartup(t *testing.T) {
	testNativeBrowser(t, "startup", nil)
}

// PRD 9.13 names htop separately from the always-run CLI/Vim acceptance.
// Run explicitly with a verified htop binary available on PATH.
func TestHermeticLeashHtop(t *testing.T) {
	testNativeBrowser(t, "htop", nil)
}

func TestHermeticLeashNetwork(t *testing.T) {
	profile := tailcattransport.TestNetworkProfile{RTTMS: 150, JitterMS: 30, Loss: 1, Kbit: 256}
	testNativeBrowser(t, "network", &profile)
}

// PRD 17.5 requires every listed network parameter, not only the smoke profile.
// Each isolated case retains the same input, outage, recovery and output checks.
func TestHermeticLeashNetworkMatrix(t *testing.T) {
	for _, rtt := range []int{20, 80, 150, 300} {
		for _, jitter := range []int{0, 20, 60} {
			for _, loss := range []int{0, 1, 5} {
				for _, bandwidth := range []int{64, 256, 1024} {
					profile := tailcattransport.TestNetworkProfile{RTTMS: rtt, JitterMS: jitter, Loss: loss, Kbit: bandwidth}
					name := fmt.Sprintf("rtt%d-jitter%d-loss%d-kbit%d", rtt, jitter, loss, bandwidth)
					t.Run(name, func(t *testing.T) { testNativeBrowser(t, "network", &profile) })
				}
			}
		}
	}
}

// Opt-in measurements preserve the functional case's profile and deadlines.
func TestHermeticLeashSlowConsumerMemory(t *testing.T) {
	profile := tailcattransport.TestNetworkProfile{RTTMS: 150, JitterMS: 30, Loss: 1, Kbit: 256}
	testNativeBrowser(t, "network-memory", &profile)
}

func TestHermeticEscapeIdleMemory(t *testing.T) {
	testNativeBrowser(t, "escape-idle", nil)
}

func testNativeBrowser(t *testing.T, scenario string, profile *tailcattransport.TestNetworkProfile) {
	t.Helper()
	isNetwork := scenario == "network" || scenario == "network-memory"
	isEscape := scenario == "escape-idle"
	_, source, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("cannot locate browser integration source")
	}
	root := filepath.Clean(filepath.Join(filepath.Dir(source), "../../../.."))
	dist := filepath.Join(root, "apps", "web", "dist")
	if _, err := os.Stat(filepath.Join(dist, "index.html")); err != nil {
		t.Fatal("production Web build is required")
	}
	node, err := exec.LookPath("node")
	if err != nil {
		t.Fatal("Node is required for browser acceptance")
	}
	directory := t.TempDir()
	environment := []string{"PATH=/usr/bin:/bin", "HOME=" + directory, "ENV="}
	if coverage := os.Getenv("GOCOVERDIR"); coverage != "" {
		environment = append(environment, "GOCOVERDIR="+coverage)
	}
	binary, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	argv := []string{binary, "-test.run=^TestLeashCLIChild$"}
	childMode := "size"
	if scenario == "startup" {
		childMode = "performance"
	} else if strings.HasPrefix(scenario, "browser-crash") {
		childMode = "crash"
	} else if isNetwork {
		childMode = "network"
	}
	environment = append(environment, "TAILMOUSE_LEASH_CLI_CHILD="+childMode)
	title, wantCode := "Native CLI acceptance", 37
	if scenario == "vim" {
		if _, err := os.Stat("/usr/bin/vi"); err != nil {
			t.Fatal("Vim is required for full-screen native acceptance")
		}
		argv = []string{"/usr/bin/vi", "-u", "NONE", "-U", "NONE", "-i", "NONE", "-n", "--cmd", "set encoding=utf-8", "--", "fixture.txt"}
		title, wantCode = "Native Vim acceptance", 0
		if err := os.WriteFile(filepath.Join(directory, "fixture.txt"), []byte("Native Vim fixture 🐈\nSecond fixture line\n"), 0o600); err != nil {
			t.Fatal(err)
		}
	} else if scenario == "htop" {
		htop, err := exec.LookPath("htop")
		if err != nil {
			t.Fatal("htop is required for its named PRD acceptance")
		}
		// Show only the owned test process, prohibit process-changing actions,
		// and never load or overwrite the user's htop configuration.
		argv = []string{htop, "--readonly", "--pid=" + strconv.Itoa(os.Getpid())}
		environment = append(environment, "LC_ALL=C.UTF-8", "HTOPRC="+filepath.Join(directory, "htoprc"))
		title, wantCode = "Native htop acceptance", 0
	} else if scenario == "shell" {
		argv = []string{"/bin/sh", "-i"}
		// The isolated shell needs an explicit UTF-8 locale for line editing;
		// production keeps the owner's environment unchanged.
		environment = append(environment, "LC_ALL=C.UTF-8", "PS1=tailmouse-fixture> ", "PS2=tailmouse-continuation> ")
		title, wantCode = "Native Shell acceptance", 19
	} else if scenario == "long-task" {
		// A standard shell task emits progress while disconnected, then exposes
		// an interactive prompt on the same terminal before completing.
		script := `printf 'long-task-ready\n'; i=0; while [ "$i" -lt 100 ]; do i=$((i + 1)); printf 'long-task-progress:%s\n' "$i"; sleep 0.2; done; printf 'long-task-input\n'; IFS= read -r answer; printf 'long-task-complete:%s\n' "$answer"`
		argv = []string{"/bin/sh", "-c", script}
		title, wantCode = "Native long task acceptance", 0
	}
	if err := os.MkdirAll(filepath.Join(root, ".artifacts"), 0o700); err != nil {
		t.Fatal(err)
	}
	var network *tailcattransport.LocalTestNetwork
	var start func(context.Context, tailcattransport.Config) (*tailcattransport.Server, error)
	if profile != nil {
		network = tailcattransport.NewLocalTestNetwork(*profile)
		start = tailcattransport.LocalTestStarter(t, network)
	} else {
		start = tailcattransport.LocalTestStarter(t)
	}
	staticHandler := http.FileServer(http.Dir(dist))
	if scenario == "startup" {
		staticHandler = startupStaticHandler(t, dist)
	}
	deadline := 60 * time.Second
	if scenario == "startup" || isNetwork || isEscape {
		deadline = 90 * time.Second
	}
	ctx, cancel := context.WithTimeout(t.Context(), deadline)
	t.Cleanup(cancel)
	input, inputWriter, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	readOutput, output, err := os.Pipe()
	if err != nil {
		input.Close()
		inputWriter.Close()
		t.Fatal(err)
	}
	capture := &lockedLeashCapture{capture: cardCapture{card: make(chan invitation.MouseCard, 1)}}
	if network != nil {
		mux := http.NewServeMux()
		mux.Handle("/", staticHandler)
		for _, duration := range []time.Duration{300 * time.Millisecond, 3 * time.Second, 15 * time.Second} {
			mux.HandleFunc("POST /__test/pause/"+strconv.FormatInt(duration.Milliseconds(), 10), func(w http.ResponseWriter, r *http.Request) {
				network.Pause(duration)
				w.WriteHeader(http.StatusNoContent)
			})
		}
		mux.HandleFunc("POST /__test/bulk", func(w http.ResponseWriter, r *http.Request) {
			if _, err := inputWriter.Write([]byte{'B'}); err != nil {
				http.Error(w, "Local fixture input failed", http.StatusConflict)
				return
			}
			w.WriteHeader(http.StatusNoContent)
		})
		mux.HandleFunc("GET /__test/output", func(w http.ResponseWriter, r *http.Request) {
			capture.mu.Lock()
			finished := bytes.Contains(capture.capture.Bytes(), []byte("bulk-finished"))
			count := capture.capture.Len()
			capture.mu.Unlock()
			w.Header().Set("Cache-Control", "no-store")
			_ = json.NewEncoder(w).Encode(struct {
				Finished bool `json:"finished"`
				Bytes    int  `json:"bytes"`
			}{finished, count})
		})
		mux.HandleFunc("GET /__test/network", func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Cache-Control", "no-store")
			_ = json.NewEncoder(w).Encode(network.Inspect())
		})
		mux.HandleFunc("POST /__test/restore", func(w http.ResponseWriter, r *http.Request) {
			network.Restore()
			w.WriteHeader(http.StatusNoContent)
		})
		staticHandler = mux
	} else if scenario == "browser-crash" {
		// Only this owned fixture exposes fixed local input while no browser
		// exists. Never accept request-supplied terminal bytes or return output.
		mux := http.NewServeMux()
		mux.Handle("/", staticHandler)
		mux.HandleFunc("POST /__test/local-after-crash", func(w http.ResponseWriter, r *http.Request) {
			if err := inputWriter.SetWriteDeadline(time.Now().Add(time.Second)); err != nil {
				w.WriteHeader(http.StatusInternalServerError)
				return
			}
			_, writeErr := io.WriteString(inputWriter, "local-alive🐈")
			resetErr := inputWriter.SetWriteDeadline(time.Time{})
			if writeErr != nil || resetErr != nil {
				w.WriteHeader(http.StatusInternalServerError)
				return
			}
			w.WriteHeader(http.StatusNoContent)
		})
		mux.HandleFunc("GET /__test/local-after-crash", func(w http.ResponseWriter, r *http.Request) {
			capture.mu.Lock()
			seen := bytes.Contains(capture.capture.Bytes(), []byte("local-alive🐈"))
			capture.mu.Unlock()
			w.Header().Set("Cache-Control", "no-store")
			if !seen {
				w.WriteHeader(http.StatusAccepted)
				return
			}
			w.WriteHeader(http.StatusNoContent)
		})
		staticHandler = mux
	}
	static := httptest.NewServer(staticHandler)
	t.Cleanup(static.Close)
	outputDone := make(chan error, 1)
	go func() {
		limit := int64(2 << 20)
		if network != nil {
			limit = 8 << 20
		}
		_, err := io.CopyN(capture, readOutput, limit)
		if errors.Is(err, io.EOF) {
			err = nil
		} else if err == nil {
			err = errors.New("terminal fixture exceeded its output bound")
		}
		outputDone <- err
	}()
	done := make(chan int, 1)
	var nativeTransport *tailcattransport.Server
	finished := false
	retention := "1s"
	if scenario == "retained-exit" {
		retention = "5s" // Includes a fresh browser context and real Wasm startup.
	}
	args := []string{"leash", "--derp-host=localhost", "--no-qr", "--start-on=connect", "--post-exit-ttl=" + retention, "--cwd=" + directory, "--title=" + title, "--"}
	if scenario == "browser-crash-kill" {
		args = append(args[:len(args)-1], "--kill-on-disconnect", "--")
		wantCode = 143
	}
	args = append(args, argv...)
	if isEscape {
		// Reuse only the owned transport/browser fixture, never launch the
		// Leash command above. Idle means a connected result between rounds.
		args = []string{"escape", "--derp-host=localhost", "--no-qr", "--once=false", "--seed=42", "--map=courtyard", "--round=30s", "--ttl=2m"}
		wantCode = exitOK
	}
	go func() {
		code := runWithSignals(ctx, input, args, environment, directory, output, io.Discard, func(ctx context.Context, config tailcattransport.Config) (transportServer, error) {
			var err error
			nativeTransport, err = start(ctx, config)
			return nativeTransport, err
		}, nil)
		output.Close()
		input.Close()
		done <- code
	}()
	t.Cleanup(func() {
		cancel()
		inputWriter.Close()
		if !finished {
			select {
			case <-done:
			case <-time.After(8 * time.Second):
				t.Error("native fixture owner did not join")
			}
		}
		var outputErr error
		select {
		case outputErr = <-outputDone:
		case <-time.After(time.Second):
			// A failed owner may retain the writer. Close the reader only after
			// the normal EOF opportunity, so successful cleanup cannot race it.
			_ = readOutput.Close()
			outputErr = <-outputDone
			if !t.Failed() {
				t.Error("terminal fixture output did not finish within its bound")
			}
		}
		if err := readOutput.Close(); err != nil && !errors.Is(err, os.ErrClosed) {
			t.Error("terminal fixture reader did not close")
		}
		if outputErr != nil && !t.Failed() {
			t.Error("terminal fixture output failed")
		}
		capture.mu.Lock()
		clear(capture.capture.Bytes())
		capture.capture.Reset()
		capture.mu.Unlock()
	})
	var card invitation.MouseCard
	select {
	case card = <-capture.capture.card:
	case code := <-done:
		finished = true
		t.Fatalf("native fixture exited before invitation: %d", code)
	case <-ctx.Done():
		t.Fatal("native fixture invitation deadline exceeded")
	}
	encoded, err := invitation.Encode(card)
	card = invitation.MouseCard{}
	if err != nil {
		t.Fatal("native invitation could not be consumed")
	}
	request, err := json.Marshal(struct {
		BaseURL  string                               `json:"baseURL"`
		Fragment string                               `json:"fragment"`
		Scenario string                               `json:"scenario"`
		HostPID  int                                  `json:"hostPID"`
		Profile  *tailcattransport.TestNetworkProfile `json:"profile,omitempty"`
	}{static.URL, base64.RawURLEncoding.EncodeToString(encoded), scenario, os.Getpid(), profile})
	clear(encoded)
	if err != nil {
		t.Fatal("browser request could not be encoded")
	}
	defer clear(request)
	probeFile := "leash.mjs"
	if scenario == "startup" {
		probeFile = "startup.mjs"
	} else if isEscape {
		probeFile = "escape-memory.mjs"
	} else if isNetwork {
		probeFile = "leash-network.mjs"
	}
	command := exec.CommandContext(ctx, node, filepath.Join(root, "tests", "integration", "tailcat", probeFile))
	command.Dir, command.WaitDelay = root, 3*time.Second
	command.Stdin = bytes.NewReader(request)
	var probe bytes.Buffer
	command.Stdout, command.Stderr = &probe, &probe
	if err := command.Run(); err != nil {
		// The probe prints only a fixed stage, never Playwright's exception,
		// URL, page contents or an invitation-bearing stack trace.
		message := probe.String()
		if len(message) > 512 {
			message = "invalid probe output"
		}
		t.Errorf("native browser failed: %v; %s", err, message)
		t.FailNow()
	}
	if scenario == "startup" {
		var measured struct {
			BrowserVersion                    string  `json:"browserVersion"`
			IdleSettleMS                      int64   `json:"idleSettleMS"`
			IdleWorkerCount                   int     `json:"idleWorkerCount"`
			TransitionBrowserFootprintBytes   int64   `json:"transitionBrowserFootprintBytes"`
			ColdMS                            float64 `json:"coldMS"`
			WarmMS                            float64 `json:"warmMS"`
			HostRSSBytes                      int64   `json:"hostRSSBytes"`
			BrowserRSSBytes                   int64   `json:"browserRSSBytes"`
			RendererRSSBytes                  int64   `json:"rendererRSSBytes"`
			HostFootprintBytes                int64   `json:"hostFootprintBytes"`
			BrowserFootprintBytes             int64   `json:"browserFootprintBytes"`
			BaselineBrowserRSSBytes           int64   `json:"baselineBrowserRSSBytes"`
			BaselineBrowserFootprintBytes     int64   `json:"baselineBrowserFootprintBytes"`
			RendererFootprintBytes            int64   `json:"rendererFootprintBytes"`
			BrowserCoreFootprintBytes         int64   `json:"browserCoreFootprintBytes"`
			GPUFootprintBytes                 int64   `json:"gpuFootprintBytes"`
			ColdBrowserFootprintBytes         int64   `json:"coldBrowserFootprintBytes"`
			ColdRendererFootprintBytes        int64   `json:"coldRendererFootprintBytes"`
			ColdHeapBytes                     int64   `json:"coldHeapBytes"`
			ColdBackingBytes                  int64   `json:"coldBackingBytes"`
			WarmHeapBytes                     int64   `json:"warmHeapBytes"`
			WarmBackingBytes                  int64   `json:"warmBackingBytes"`
			LargestRendererFootprintBytes     int64   `json:"largestRendererFootprintBytes"`
			RendererProcessCount              int     `json:"rendererProcessCount"`
			ColdLargestRendererFootprintBytes int64   `json:"coldLargestRendererFootprintBytes"`
			ColdRendererProcessCount          int     `json:"coldRendererProcessCount"`
		}
		if err := json.Unmarshal(probe.Bytes(), &measured); err != nil || measured.ColdMS <= 0 || measured.WarmMS <= 0 || measured.HostRSSBytes <= 0 || measured.BrowserRSSBytes <= 0 || measured.RendererRSSBytes <= 0 {
			t.Fatal("startup probe emitted invalid measurements")
		}
		if !strings.HasPrefix(measured.BrowserVersion, "Chrome/") || len(measured.BrowserVersion) > 40 || measured.IdleSettleMS != 35000 || measured.IdleWorkerCount < 0 {
			t.Fatal("startup probe omitted its browser or idle-measurement identity")
		}
		t.Logf("engine %s; page-only inspection, no worker debugger; idle samples start after %d ms, remaining running workers %d", measured.BrowserVersion, measured.IdleSettleMS, measured.IdleWorkerCount)
		t.Logf("static link: 9 Mbit/s aggregate, 60 ms response latency; cold %.1f ms, warm %.1f ms", measured.ColdMS, measured.WarmMS)
		t.Logf("idle RSS over five one-second samples: host including Go test/relay fixture %d bytes (child excluded), Chromium process sum %d bytes, renderer process sum %d bytes", measured.HostRSSBytes, measured.BrowserRSSBytes, measured.RendererRSSBytes)
		browserIdleBytes := measured.BrowserRSSBytes
		if runtime.GOOS == "darwin" {
			if measured.HostFootprintBytes <= 0 || measured.BrowserFootprintBytes <= 0 || measured.BaselineBrowserFootprintBytes <= 0 || measured.TransitionBrowserFootprintBytes <= 0 {
				t.Fatal("macOS physical footprint measurements are missing")
			}
			t.Logf("macOS approximate physical footprint: host %.1f MiB, Chromium process sum %.1f MiB; blank browser baseline %.1f MiB (RSS %.1f MiB)", float64(measured.HostFootprintBytes)/(1<<20), float64(measured.BrowserFootprintBytes)/(1<<20), float64(measured.BaselineBrowserFootprintBytes)/(1<<20), float64(measured.BaselineBrowserRSSBytes)/(1<<20))
			t.Logf("physical footprint: cold total %.1f MiB / renderers %.1f MiB; warm renderers %.1f MiB / browser core %.1f MiB / GPU %.1f MiB", float64(measured.ColdBrowserFootprintBytes)/(1<<20), float64(measured.ColdRendererFootprintBytes)/(1<<20), float64(measured.RendererFootprintBytes)/(1<<20), float64(measured.BrowserCoreFootprintBytes)/(1<<20), float64(measured.GPUFootprintBytes)/(1<<20))
			t.Logf("page-replacement total physical footprint before idle settling: %.1f MiB (not hidden by the later idle measurement)", float64(measured.TransitionBrowserFootprintBytes)/(1<<20))
			t.Logf("page V8 used heap/backing storage: cold %d/%d bytes, warm %d/%d bytes; these are diagnostics, not total browser memory", measured.ColdHeapBytes, measured.ColdBackingBytes, measured.WarmHeapBytes, measured.WarmBackingBytes)
			t.Logf("renderer counts cold/warm %d/%d, largest footprint cold/warm %.1f/%.1f MiB", measured.ColdRendererProcessCount, measured.RendererProcessCount, float64(measured.ColdLargestRendererFootprintBytes)/(1<<20), float64(measured.LargestRendererFootprintBytes)/(1<<20))
			browserIdleBytes = measured.BrowserFootprintBytes
			if measured.HostFootprintBytes >= 150<<20 {
				t.Error("PRD host idle memory target exceeded under macOS physical-footprint accounting")
			}
		} else if measured.HostRSSBytes >= 150<<20 {
			t.Error("PRD host idle memory target exceeded under whole-process RSS accounting; native footprint analysis remains required")
		}
		// The owner made browser idle memory advisory, not a hard gate. Keep
		// the entire measured browser and report the original target honestly.
		t.Logf("browser idle memory advisory: %.1f MiB; original 200 MiB target exceeded: %t; non-blocking by owner decision; no blank-browser baseline subtraction", float64(browserIdleBytes)/(1<<20), browserIdleBytes >= 200<<20)
		if measured.ColdMS >= 15_000 || measured.WarmMS >= 3000 {
			t.Error("PRD startup target exceeded; local-relay measurements are not physical-device acceptance")
		}
	} else if isEscape {
		var memory struct {
			Samples               int    `json:"samples"`
			IdleSettleMS          int    `json:"idleSettleMS"`
			BrowserVersion        string `json:"browserVersion"`
			HostRSSBytes          int64  `json:"hostRSSBytes"`
			BrowserRSSBytes       int64  `json:"browserRSSBytes"`
			HostFootprintBytes    int64  `json:"hostFootprintBytes"`
			BrowserFootprintBytes int64  `json:"browserFootprintBytes"`
			BaselineBrowserBytes  int64  `json:"baselineBrowserBytes"`
		}
		if err := json.Unmarshal(probe.Bytes(), &memory); err != nil || memory.Samples != 5 || memory.IdleSettleMS != 35000 || memory.HostRSSBytes <= 0 || memory.BrowserRSSBytes <= 0 || memory.BaselineBrowserBytes <= 0 || !strings.HasPrefix(memory.BrowserVersion, "Chrome/") || len(memory.BrowserVersion) > 40 {
			t.Fatal("Escape idle-memory evidence is missing or invalid")
		}
		hostBytes, browserBytes := memory.HostRSSBytes, memory.BrowserRSSBytes
		if runtime.GOOS == "darwin" {
			if memory.HostFootprintBytes <= 0 || memory.BrowserFootprintBytes <= 0 {
				t.Fatal("Escape idle macOS physical footprints are missing")
			}
			hostBytes, browserBytes = memory.HostFootprintBytes, memory.BrowserFootprintBytes
		}
		t.Logf("Escape idle: %s, connected retained result; page-only inspection, normal PWA caching, 35000 ms natural settling and five one-second samples; no child process", memory.BrowserVersion)
		t.Logf("maximum sampled idle RSS: Host including test/relay %d bytes, complete browser %d bytes", memory.HostRSSBytes, memory.BrowserRSSBytes)
		t.Logf("idle %s accounting: Host %.1f MiB, complete browser %.1f MiB, undeducted blank-browser baseline %.1f MiB; browser 200 MiB advisory exceeded: %t", runtime.GOOS, float64(hostBytes)/(1<<20), float64(browserBytes)/(1<<20), float64(memory.BaselineBrowserBytes)/(1<<20), browserBytes >= 200<<20)
		if hostBytes >= 150<<20 {
			t.Error("PRD Escape host idle memory target exceeded")
		}
	} else if isNetwork {
		var evidence struct {
			InputBytes       int     `json:"inputBytes"`
			BulkBytes        int     `json:"bulkBytes"`
			BulkMS           float64 `json:"bulkMS"`
			ModifierReset    bool    `json:"modifierReset"`
			OutputRecovery   string  `json:"outputRecovery"`
			ReconnectRetries *struct {
				Busy             int `json:"busy"`
				HandshakeTimeout int `json:"handshakeTimeout"`
			} `json:"reconnectRetries"`
			Memory *struct {
				Samples               int     `json:"samples"`
				ElapsedMS             float64 `json:"elapsedMS"`
				BrowserVersion        string  `json:"browserVersion"`
				HostRSSBytes          int64   `json:"hostRSSBytes"`
				BrowserRSSBytes       int64   `json:"browserRSSBytes"`
				HostFootprintBytes    int64   `json:"hostFootprintBytes"`
				BrowserFootprintBytes int64   `json:"browserFootprintBytes"`
			} `json:"memory"`
		}
		if err := json.Unmarshal(probe.Bytes(), &evidence); err != nil || evidence.InputBytes != 40960 || evidence.BulkBytes != 4<<20 || evidence.BulkMS <= 0 || evidence.BulkMS >= 10_000 || !evidence.ModifierReset {
			t.Fatal("network probe omitted ordered-input, modifier or nonblocking-output evidence")
		}
		if evidence.OutputRecovery != "same-stream" && evidence.OutputRecovery != "fresh-stream" {
			t.Fatal("network probe omitted its output recovery path")
		}
		if evidence.ReconnectRetries == nil || evidence.ReconnectRetries.Busy < 0 || evidence.ReconnectRetries.HandshakeTimeout < 0 || evidence.ReconnectRetries.Busy+evidence.ReconnectRetries.HandshakeTimeout > 80 {
			t.Fatal("network probe omitted bounded explicit reconnect counts")
		}
		t.Logf("native Leash weak network: %d ordered input bytes; %d output bytes finished locally in %.1f ms before restoring a 15-second blocked link; fresh-stream modifiers cleared; output recovery: %s", evidence.InputBytes, evidence.BulkBytes, evidence.BulkMS, evidence.OutputRecovery)
		t.Logf("fresh-stream manual retries within the bounded 60-second recovery window: busy %d, handshake timeout %d", evidence.ReconnectRetries.Busy, evidence.ReconnectRetries.HandshakeTimeout)
		if scenario == "network-memory" {
			memory := evidence.Memory
			if memory == nil || memory.Samples != 5 || memory.ElapsedMS < 5000 || memory.ElapsedMS >= 15000 || memory.HostRSSBytes <= 0 || memory.BrowserRSSBytes <= 0 {
				t.Fatal("slow-consumer memory evidence is missing or outside the blocked-link window")
			}
			parts := strings.Split(memory.BrowserVersion, ".")
			if len(parts) != 4 || len(memory.BrowserVersion) > 40 {
				t.Fatal("slow-consumer browser identity is invalid")
			}
			for _, part := range parts {
				if value, err := strconv.ParseUint(part, 10, 32); err != nil || value > 999999 {
					t.Fatal("slow-consumer browser identity is invalid")
				}
			}
			t.Logf("slow consumer: Chromium headless shell %s, service workers blocked, five one-second samples within %.1f ms of blocked output; Host includes test/relay and bounded output capture, child excluded", memory.BrowserVersion, memory.ElapsedMS)
			t.Logf("slow-consumer maximum sampled RSS: Host %d bytes, complete browser %d bytes", memory.HostRSSBytes, memory.BrowserRSSBytes)
			if runtime.GOOS == "darwin" {
				if memory.HostFootprintBytes <= 0 || memory.BrowserFootprintBytes <= 0 {
					t.Fatal("slow-consumer macOS physical footprints are missing")
				}
				t.Logf("slow-consumer maximum sampled physical footprint: Host %.1f MiB, complete browser %.1f MiB; no baseline subtraction; loaded-session observation, not PWA idle acceptance", float64(memory.HostFootprintBytes)/(1<<20), float64(memory.BrowserFootprintBytes)/(1<<20))
			}
		} else if evidence.Memory != nil {
			t.Fatal("functional network case unexpectedly enabled memory inspection")
		}
	} else if strings.TrimSpace(probe.String()) != "leash browser acceptance passed: "+scenario {
		t.Fatal("browser probe emitted an unexpected trace")
	}
	waitForExit := ctx
	if isEscape {
		// A normal browser CLOSE completes Escape. Join that natural exit;
		// owner cancellation remains failure cleanup, not the success path.
		var stop context.CancelFunc
		waitForExit, stop = context.WithTimeout(ctx, 8*time.Second)
		defer stop()
	}
	select {
	case code := <-done:
		finished = true
		if code != wantCode {
			// Close is idempotent. Inspect only fixed classifications from the
			// completed owner; never print transport causes or invitation data.
			var closeErr error
			if nativeTransport != nil {
				closeErr = nativeTransport.Close(context.Background())
			}
			t.Fatalf("native exit = %d, want %d; transport drain failed: %t; transport close failed: %t",
				code, wantCode, errors.Is(closeErr, tailcattransport.ErrDrain), errors.Is(closeErr, tailcattransport.ErrClose))
		}
	case <-waitForExit.Done():
		t.Fatal("native owner did not finish after browser acceptance")
	}
}
