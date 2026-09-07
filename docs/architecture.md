# TailMouse code architecture

## Repository shape

```text
TailMouse/
├── apps/
│   ├── cli/                              # Go composition root and native runtime
│   │   └── internal/transport/tailcat/  # only native Tailcat import boundary
│   └── web/                              # Preact/Vite browser client
│       └── src/transport/tailcat/       # only browser Tailcat bridge boundary
├── protocol/                             # language-neutral TMOUSE/1 contract
├── tests/                                # cross-runtime and system tests
├── third_party/
│   └── tailcat/                          # external read-only Git submodule
├── openspec/                             # current specs and proposed changes
├── docs/                                 # context, governance, practices, decisions
├── tools/                                # fail-fast policy and gate scripts
├── go.mod                                # native Go module
├── go.work                               # local Go module composition
└── pnpm-workspace.yaml                   # JS workspace and orchestration
```

Directories appear with accepted changes; empty placeholder layers are not architecture.

## Dependency direction

```text
apps/cli composition
  -> native application/core contracts
  -> protocol concepts
  -> internal/transport/tailcat adapter -> local Tailcat submodule module
  -> internal/platform adapters -> operating-system APIs

apps/web composition
  -> UI/session state
  -> protocol concepts
  -> src/transport/tailcat adapter -> Tailcat Go/Wasm bridge
  -> browser capability adapters -> browser APIs

protocol specs and fixtures <- Go and TypeScript conformance tests
system tests                <- packaged native app and built static web app
```

Core logic does not import Tailcat, DOM, Node, PTY, or operating-system implementations. External capabilities enter through narrow interfaces owned by consumers. Create an interface for a real test/second implementation or a verified volatile boundary, not to reproduce textbook layers.

## Runtime boundaries

### Native Go application

`apps/cli` is the executable composition root. Protocol state, session policy, and flow control remain independent of Tailcat. PTY, clipboard, and controlled input are platform boundaries with cancellation, bounded buffers, and explicit error propagation. Unix PTY and Windows ConPTY differences stay in platform adapters.

Invitation rendering uses the exactly pinned, MIT-licensed `skip2/go-qrcode` encoder through the existing private bitmap function. It adds no transitive module or application abstraction; minimum version, M correction, four-module quiet zone and invitation limits remain TailMouse-owned policy. Format-bit tests and an independent native browser decoder validate output rather than requiring identical QR masks from different encoders.

The concrete Escape binding lives in the native session package and connects the independent round core to protocol frames. `Host.Wait` drives its ticker; the existing per-connection PING sender also drains its bounded game output. One lock serializes round state and input acceptance, never network I/O. Input carries the current connection lease, snapshots coalesce, and reconnect discards old queued work before sending initialization and current state. The CLI configures the binding before opening transport and retains ownership of the session wait/close lifecycle.

The CLI terminal spectator reads immutable game/map/scent/result values and measured counters at 20 Hz. Its platform console boundary owns raw input and restoration; it does not enter the game engine or Tailcat adapter. Redirected output is non-animated. Post-round restart is host-owned and preserves the session TTL; the existing ordered PING/PONG path establishes that the connected browser has processed the previous result and drained old input before the next initialization. No new wire message, TUI dependency or input-history replay is introduced.

### Leash native state and process boundary

`internal/leash` owns the private immutable command snapshot and bounded raw-byte history. Byte cursors define the snapshot/live boundary without interpreting terminal sequences. `internal/platform/pty` owns the operating-system terminal and child handles, cancellable I/O, dimensions and process-group operations. The CLI composes these with session authority; neither the core nor protocol imports PTY or Tailcat implementations. A child lifetime is distinct from a browser stream lifetime.

The concrete Leash pump consumes a narrow cancellable PTY interface. One reader appends raw bytes to history and the fixed browser-delivery ring before local mirroring; one writer drains an input buffer whose capacity includes in-flight bytes. Subscription reads never perform PTY reads or block its producer. Snapshot and live cursors are captured together, stale subscriptions are invalidated, and cancellation joins the writer without taking ownership of the user's terminal or implicitly killing the child.

The host exposes a one-shot valid-HELLO notification for Leash startup. It records successful authority acquisition before a potentially blocked WELCOME write and survives a disconnect; it is not current permission or connection state. The CLI owns invitation-first ordering and exactly-once process allocation. The Unix Leash console reuses the existing cancellable descriptor operations and restoration while also preserving redirected files/pipes, batching raw input bytes and obtaining dimensions from the available local terminal. These boundaries do not themselves own the process or its lifetime.

The CLI owns one shared concrete Leash process loop: start policy, raw local input, signals, resize debounce, child exit, retention and restart. Unix signal naming and SIGWINCH recognition and Windows input-record resize notifications remain tiny platform functions; lifecycle policy is not copied. The loop stops and joins initialization's signal receiver before consuming interrupts itself. Session access closure is idempotent and distinct from process cancellation; default expiry/disconnect can close network access while local PTY I/O continues. Only explicit kill policies or owner shutdown terminate the process tree. A restart reuses the private command snapshot and starts a new pump with a fixed marker, never accepting replacement command data from the browser.

Full exit follows one composition-root callback shared by both modes: close and join application streams, run the concrete mode cleanup, then drain/close Tailcat. Mode loops retain the local console until the callback returns, and the outer owner erases its invitation after restoration. Leash records a local owner-revocation request and performs its existing bounded graceful termination inside that cleanup phase, not before application closure. The callback observes the mode cleanup outcome so an earlier application/transport failure is not overwritten by later cleanup or terminal restoration. Access-only expiry uses the same idempotent transport operations without full mode cleanup, erases its invitation, and leaves the default local child/terminal active. Browser process controls, restart and natural child-exit retention retain their separate lifetimes. No lifecycle framework or worker is introduced.

Before replacing a generation, restart joins the local-input reader and erases its accepted queued/in-flight chunks. The caller still owns stdin; unread redirected source bytes are not preconsumed. Unix interrupt validates a foreground job and sends `TIOCSIG` through the owned PTY. The kernel resolves the current group, so an interactive shell can collect its interrupted job without userspace signaling a potentially reused numeric group. The owner remembers that session-validated job group. Terminate records the current foreground group, signals remembered job groups before the original session-leader group, and observes all of them through graceful or forced cleanup. A group that outlives its leader remains owned; a reused group ID from another session is rejected.

Unix forced cleanup waits for the original child's result and remembered job groups before closing the PTY master, preventing terminal hangup from racing the requested SIGKILL or leaving the ordinary foreground shell job alive. The waits remain bounded and descriptor cleanup still runs on failure. The portable v0.1 boundary is the leader group plus foreground groups selected through its controlling PTY; a process that deliberately creates an unrelated session is not reclaimed through a global process-table scan.

The Windows boundary prepares literal argv, cwd and UTF-16 environment exclusively from the private snapshot, then creates ConPTY and atomic Job Object membership using platform APIs. Its private channels have synchronous ConPTY ends and overlapped, deadline-capable host ends. One process waiter records root exit, then observes the non-breakaway job before normal pseudoconsole closure. Terminate requests the native console-close event while output continues draining, then forces the job after at most five seconds or earlier cancellation. Normal exit, Terminate and final Close share one once-started console-close worker: the pre-24H2 API may block, so no resource/resize lock covers it, and successful final cleanup joins it. Force cleanup observes an empty job, not just root exit, before releasing its handle. This adds no helper process or service. Windows now uses the shared CLI owner with a platform-local console instead of an unsupported stub. Native Windows execution is `deferred / not verified` until the owner supplies a Windows 11 environment; cross-compilation does not establish runtime behavior or support.

The Windows local console duplicates inherited input/output handles without inheritance, leaving caller ownership intact. Console input records retain native keys, UTF-16 units, modifiers, releases and repeats through ConPTY's Win32-input-mode encoding; local Ctrl+C and Enter remain the owner policy's raw bytes. One coalesced buffer-size event feeds the shared resize debounce. Redirected streams remain bytes. Overlapped private handles use their own Go deadlines; synchronous calls retain a native thread while their joined cancellation callback uses `CancelSynchronousIo`. Cleanup restores console modes before private handles close and reports retained cancellation cleanup failures. The generation-owned shared input reader discards any expanded repeat remainder on restart. Existing Go console output performs UTF-8 to `WriteConsoleW` conversion, so TailMouse adds no codec, global codepage change, worker service or dependency.

Windows explicit Interrupt encodes a fixed Ctrl+Break press/release as native Win32 keyboard-event input to the owned ConPTY. Local Ctrl+C remains raw input, letting the child's mode distinguish input from signaling. The platform's cancellable writer token serializes that control sequence with complete pump chunks; control admission and writing share a two-second deadline. A child may ignore the native event without an automatic retry or escalation. No host-console reattachment, helper process, output parser, new wire message or dependency is introduced. Native end-to-end Windows CLI execution remains an owner-deferred, unverified follow-up.

The native session binding publishes validated process state and drives reset/history/drop/live frames through the existing connection sender alongside PING. It adds no network worker. One copied history snapshot hands off to the pump's bounded delivery cursor; state and resize coalesce, and one pending control is reauthorized against its lease, generation and current process state immediately before the owner consumes it. Successful explicit Interrupt returns the owner state to running. One unsent interrupt acknowledgment is retained ahead of coalesced state so the browser can distinguish that reply from a pre-request running frame; a selected frame already has the sole sender's ordering guarantee. Snapshot replacement and detach discard the retained acknowledgment. Network I/O never holds the binding or pump lock. Restart rejects old-stream input until an ordinary PING/PONG after the new reset establishes an ordered drain boundary. Windows native acceptance is owner-deferred and remains `not verified`.

Mode diagnostics reuse the synchronous CLI sink and typed session observer. Process records project only validated state, generation, PID, exit and signal, never the display title. Drop records carry the wire's cumulative per-generation loss before attempting its network notification; a reconnect may repeat the same total. History usage reads its protected size without copying bytes. Escape HUD and verbose diagnostics share one at-most-one-hertz rate window over accepted inputs and successfully delivered snapshots, divided by actual elapsed time. No terminal data, diagnostic queue, worker or metrics endpoint is introduced.

### Tailcat adapters

Only `apps/cli/internal/transport/tailcat` imports the native Tailcat module. It translates upstream connection, credential, identity, and version details into a minimal TailMouse-owned transport contract and redacts sensitive values. Only `apps/web/src/transport/tailcat` calls the browser Go/Wasm bridge. Upstream types do not escape either adapter.

The recorded dependency is Tailcat v0.6.0 commit `790406204c002a6f109ef7c6a30a436601a1f6a8`. Native and Wasm builds must report that same gitlink. The Native adapter leaves `DisablePresharedKey` false and lets Tailcat create a fresh nonzero 256-bit WireGuard PSK at startup; the resulting complete address is one opaque bearer credential. An upstream startup panic is contained at the adapter boundary and becomes the existing redacted startup classification before invitation creation. Earlier Tailcat revisions have no supported compatibility or downgrade path after this update.

The native adapter fetches official/custom maps through a private standard-library HTTP client with normal certificate verification. Initial and redirected URLs must remain HTTPS without user information or fragments; acquisition is caller-cancellable and bounded to ten requests, ten seconds and an eight-MiB body. The complete map is validated before probing, rejecting inconsistent entries and relay TLS-bypass fields. Tailcat still selects the region from the supplied map and creates the ephemeral Host identity and full-region invitation. There is no stale-map fallback, global HTTP/trust mutation, new public option or copied selection algorithm. Controlled TLS tests inject trust only into their instance; integration-only self-signed relay allowances do not enter production map acquisition.

`third_party/tailcat` is an external Git submodule tracking `main` for explicit updates. The parent gitlink pins the exact revision used by each TailMouse commit without copying upstream source into TailMouse history. Agents and normal TailMouse changes treat the checkout as read-only. Source changes or gitlink updates require an explicit owner request; gates never update it automatically.

### Browser client

The web client is a static mobile-first PWA using Preact, Canvas 2D for Escape, and xterm.js with FitAddon for Leash. Small capability adapters centralize permission, degradation, and testing. The client uses no remote scripts, fonts, analytics, or server runtime. It consumes an invitation fragment once, immediately removes it from the address bar, and never persists it.

Protected Leash keeps the separately entered access code only in active-page memory. Web Crypto derives a proof for the Host's fresh challenge and erases proof/challenge working bytes; a retry creates a new stream and proof rather than replaying either. The Host alone reports protected or link-only access and admits capabilities. Page disposal and page-cache restoration erase invitation and code state. Link-only access is an explicit CLI exception, not a browser downgrade.

The existing Wasm loader counts decoded bytes through one backpressured stream into streaming compilation. It uses an unencoded response's valid length or the verified build artifact's raw size for compressed/lengthless responses. Integer updates are coalesced and EOF establishes download completion; cancellation/failure releases the load-local stream without retaining another Wasm copy. Session presentation carries only a numeric percentage and the observable loading, combined relay/Meow and session-handshake stages. A native progress element exposes the value without turning each chunk into a live-region announcement. Tailcat's bridge and the existing deadlines are unchanged.

A page-local monotonic recorder uses those same presentation boundaries to retain only numeric startup durations in memory. EOF separates Wasm transfer from remaining initialization; dial completion separates the combined relay/Meow phase; the protocol callbacks bound authentication/admission; and the first usable terminal reset plus process state marks terminal readiness. Access-code entry wait is accumulated separately and subtracted from total startup time. The About panel shows every phase and preserves `met`, `missed`, or `pending` warm/cold target status without analytics, storage, a new worker, or another timing source.

Escape's concrete browser session state owns game initialization, authoritative snapshot/result validation and the bounded movement/dash sender. The existing connection remains the only stream reader and serialized writer; the game state submits frames through that writer and stops with the connection. Rendering reads immutable game state and supplies intent, without reaching Tailcat or assigning authority. The synchronous native game core remains independent of protocol and scheduling.

The Escape view owns one animation loop and its mounted input/audio resources. Its Canvas renderer consumes validated world values; its concrete input boundary owns pointer capture, focused keyboard input, orientation permission, bounded calibration and fallback. Host initialization carries only the three documented phone/control/network settings. Closing the session unmounts active controls and retains only the safe result value for display, not the game client or its connection closure.

The game client also owns a bounded visual mouse predictor. Input and the existing animation loop advance current intent; fresh snapshots rebase its position with the PRD's correction bands and one short dust effect. Repeated snapshots cannot extend an in-progress correction beyond its deadline. Suspension discards elapsed movement, and a stale snapshot bounds extrapolation without changing host phase. No input-history replay, network clock estimate, cat simulation, collection or outcome logic exists in the predictor. Result, teardown and new initialization discard it.

Leash's browser client owns connection-local process/reset state, dropped-byte accounting and a 256 KiB input budget including its single in-flight chunk. It submits raw input, coalesced resize and one pending control through the existing session writer; no input sender timer or output queue is added. The reader waits for xterm to parse each output chunk before releasing its bytes. Abort, explicit close and view disposal release an unmounted or stalled display wait. Every reset after the initial connection clears old input and waits for a serialized post-state PONG before enabling new input, including separate starting/running snapshots within one generation. Recoverable host denials update visible state without closing the session or retrying already-sent bytes.

An active browser's oversized-frame rejection uses that same serialized writer for one locally classified ERROR. It immediately disposes mode input, suppresses queued application writes and discards decoder surplus. A shared two-second notification budget bounds any in-flight write plus the error; success uses the adapter's existing bounded FIN/EOF closure, while failure retains the original protocol classification and force-closes without retry. Peer ERROR frames are never echoed. This does not change handshake routes or the separate truncated-stream policy.

The decoder marks locally observed frame truncation without retaining upstream errors or changing the wire error vocabulary. Only an established session maps that provenance to transport loss. Native deferred cleanup discards connection work and releases the lease; the browser disposes its mode and may retain only the existing in-memory invitation for explicit fresh-stream retry. Handshakes, complete invalid frames, already detected bounds/routes and peer protocol errors remain strict. Existing TTL, grace, capabilities, input-reset and first-failure rules still apply. No additional reader, retry loop, queue or Tailcat change is introduced.

The Leash view owns one local xterm/FitAddon instance, resize observation, elapsed-time display and keyboard/clipboard/confirmation resources. It renders host state and capabilities, hides readonly controls, and never accepts replacement command data. Clipboard copy and paste require user actions. No clipboard/link addon or remote asset is loaded. OS process-tree and physical-device acceptance remain separate from browser-profile tests.

Screen-reader mode is explicit, connection-local opt-in: forcing it on interferes with xterm's ordinary Unicode input. Public key and textarea input events identify virtual-modifier intent; terminal replies, composed text and paste remain raw. Terminal parsing and composition remain xterm-owned.

One view-local touch displacement accumulator scrolls the normal buffer through xterm's public API. It emits no terminal input, does not emulate alternate-screen application controls, and clears on end/cancel, multiple fingers, reset, blur or disposal. Native pinch zoom remains allowed; no gesture framework, inertia loop or timer is added.

### Static delivery

The existing Vite build verifies Tailcat artifact checksums, content-names its runtime/Wasm, compresses hashed assets and emits a file-identity manifest. A single service worker precaches that fixed asset list with integrity checks and never stores navigation or runtime/session data. Navigations use explicit network-only forwarding; other non-allowlisted requests are untouched. Worker updates wait for old clients to close before deleting obsolete caches in the same mount scope. There is no runtime discovery, PWA dependency, dynamic cache growth or forced activation. HTML remains network-validated.

Release dependency input comes from the bundler's included modules and the compiled Wasm's bounded Go module information, not from the entire development lockfile or a second implementation of upstream build tags. Vite-generated runtime helpers retain their producer identity. The static manifest records dependency identities and toolchain versions without local paths or linker settings. Tailcat checks and its nested Wasm build use the exact project Go pin and trimmed source paths; the Web build rejects untrimmed, stale-toolchain or stale-gitlink artifacts. Per-artifact SBOM generation is a separate release step; license verification remains required.

The release-only verifier consumes those build records and independently inspected native executables, checks archive contents without extraction, and stages one portable distribution with CycloneDX SBOMs and SHA-256 coverage. It uses the official pinned CycloneDX validator for schema checks and re-derives per-artifact identities to detect omissions or tampering. Unknown internal library relationships remain explicitly incomplete; platform acceptance and legal certification are not inferred from artifact verification. No release tool enters the application runtime or the Tailcat submodule.

One source-controlled notice bundle preserves exact root/nested legal and attribution files from the six-target/Web dependency union, with a version/source/hash inventory. An explicit command updates it; normal gates re-derive and compare without writes. The release verifier matches actual SBOM dependencies and notice bytes against that inventory. Both native archives and the static Web bundle include the project license, project notice and third-party text. Static notices are not application imports or precached assets. This tooling boundary introduces no application dependency or license-classification framework.

On an invited page, registration waits until runtime loading ends so its integrity-checked precache can reuse the completed immutable HTTP response instead of downloading Wasm again. A page without an invitation installs directly. One registration promise contains only the safe cache status and spans user-initiated retries; no invitation or transport reference enters the worker.

The minimal Nginx example serves only static files with the production security and caching headers; the Docker build context contains only its configuration and built assets. Sensor access is same-origin and still requires Escape's existing user-initiated permission flow. See `docs/web-self-hosting.md` for MIME/compression, deployment and verification boundaries.

Official publication uses one R2 bucket behind only `link.tailmouse.com`. An exact root-only internal rewrite selects `index.html`; manifest-listed hashed paths retain immutable metadata, entry/metadata/notices remain no-cache, Cloudflare negotiates Brotli or gzip, and one response transform mirrors the static-server security headers. The R2 custom domain requires TLS 1.2 or newer and its `r2.dev` development URL remains disabled. There is no Worker, Pages project, application backend or credential in repository configuration. `docs/cloudflare-r2-publication.md` is the operator runbook; public mutation remains separately owner-authorized.

The schema-2 Web manifest is the pre-publication contract rather than a second deployment system. It records exact bytes, hashes and HTTP metadata for every uploadable object plus the root rewrite, 404 behavior, security headers and no-backend invariant. Release verification independently matches the directory to that allowlist and proves the sole raw Wasm's gzip and Brotli variants decompress to the same bytes. The manifest itself remains no-cache and is verified from the expected local file, avoiding an impossible self-hash.

### Protocol

`protocol/` owns TMOUSE frames, state transitions, limits, capability negotiation, and golden fixtures. Wire identifier 1 is the Escape TMOUSE/1.0 contract; identifier 2 is the protected-capable Leash TMOUSE/1.1 contract. An identifier-1 Leash peer and identifier-2 Leash peer fail closed in either direction before admission, terminal disclosure or child startup; there is no automatic downgrade. Implementation types are not protocol definitions. A breaking framing or state change increments the protocol version and updates Go, TypeScript, cross-version and cross-language conformance tests together.

## Monorepo mechanics

pnpm orchestrates JavaScript workspaces and cross-language commands; Go remains native. `go.work` composes the TailMouse module with the checked-out Tailcat module so adapter development uses the recorded local dependency. The root lockfile is the only JavaScript resolution record, local packages use `workspace:`, and cycles are rejected. Only an actual independently built unit becomes a package.

## Test topology

- Unit tests stay next to owned logic and cover success, boundaries, and failures.
- One golden fixture corpus drives Go and TypeScript protocol conformance.
- Integration tests use local, controlled, credential-free Tailcat/DERP infrastructure.
- A `tailcatintegration`-tagged adapter starter shares the existing loopback relay between adapter probes and real CLI/PTY/browser acceptance. Normal builds contain no fixture or TLS bypass; CLI tests do not import upstream types. `pnpm test:leash` verifies protected/link-only terminal behavior, shell, Vim, lifecycle and impairment cases against the production Web build and recorded Wasm on Unix. Explicit selectors cover isolated installed Codex CLI and Claude Code version/interactive terminal acceptance plus macOS official-relay acceptance without turning those external prerequisites into default-gate dependencies.
- Playwright verifies user-visible connection, degradation, and mobile behavior.
- Vitest's official Playwright provider runs DOM/Canvas component tests in the existing Chromium engine alongside Node unit suites, with one combined coverage gate. It adds no production dependency or DOM emulator.
- Impairment and security tests cover reconnect, loss, reorder, latency, backpressure, oversized input, and credential leakage.

Coverage is measured only when TailMouse-owned production source exists. No source reports a skip, not 100%. Source below the constitution threshold fails the gate. Unmodified external submodule source is outside the TailMouse coverage denominator and instead runs Tailcat's build, test, vet, module-integrity, and WebAssembly checks.

## Change rule

A change that adds a cross-boundary dependency, runtime, workspace, or public protocol surface updates OpenSpec and this document first. A rename or formatting-only correction needs no additional planning artifact.
