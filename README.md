# TailMouse

A small native CLI and a mobile-first browser client for two kinds of temporary session:

## Escape demo

Steer the mouse, dash, and avoid the cat following your RTT-delayed scent trail. The browser predicts your movement locally; the host decides the outcome.

![Real Escape gameplay with joystick movement, dash cooldown, RTT and a pursuing cat](docs/media/escape.gif)

## Leash demo

Control one explicitly launched terminal application from a browser. Interactive shells and full-screen TUIs use a real PTY, not screenshots.

![Real Vim editing over Leash, including Unicode input and browser shortcut controls](docs/media/leash-vim.gif)

These 18.6-second Escape and 16.18-second Vim recordings use the built browser client and a native macOS host over official Tailcat DERP. They demonstrate working flows, not completed release or physical-mobile acceptance.

TailMouse is an **unofficial** application built on [Tailcat](https://github.com/tailscale/tailcat). The host needs only the `tailmouse` executable; it embeds Tailcat's Go library. The browser loads the same dependency revision as Wasm. Users do not separately install the Tailcat CLI or join a Tailscale account. Browser transport is currently **DERP-only**; there is no browser direct-UDP or WebRTC upgrade. Leash does **not** stream native GUI windows or desktops.

TailMouse is not affiliated with or endorsed by Tailscale Inc. Tailscale and Tailcat names and trademarks belong to their respective owners.

**Treat every invitation link, QR code and access code as a credential.** Leash is password-protected by default: the invitation and separately displayed access code are both required, and the browser sends a fresh challenge proof rather than the code. The explicit `--no-password` exception makes the full invitation sufficient for the configured permissions. A writable terminal has the launched process's authority. DERP sees connection metadata, timing and traffic sizes, although session payloads are end-to-end encrypted. The Web page is a trusted endpoint and can see session plaintext. The accepted V2 short-link design also trusts the official Cloudflare edge with the protected invitation in plaintext for a bounded lease; it never sends the separate access code there. The edge is deployed for prelaunch testing; full public lifecycle acceptance remains pending.

## Development status

This checkout is not a published v0.1 release. macOS has native/browser integration evidence. Linux and Windows builds, static checks, artifacts and platform-specific test binaries are present, but native execution is explicitly deferred until the owner provides matching environments; those platforms are `not verified`, and no runtime-support claim is made. This deferral does not block the current macOS-scoped development completion. Unix cleanup owns the launched session-leader group and session-validated foreground job groups selected through its controlling PTY; native macOS tests cover ordinary interactive-shell separation, but a descendant that deliberately creates an unrelated session is outside this portable boundary. Use disposable test commands until the remaining release acceptance is complete.

The release target is macOS 13+, Linux glibc distributions and Windows 11, each on amd64/arm64. Browser targets are the latest two major Safari, Chrome, Edge and Firefox versions, with iPhone Safari and Android Chrome as mobile acceptance targets. Automated browser profiles do not establish physical-device support. See the [conformance ledger](docs/evidence/prd-conformance.md) for current evidence and remaining work, including process-tree, platform and final release acceptance. The official static browser client and short-link edge are deployed for prelaunch testing; the Homebrew tap and versioned application release are not yet claimed.

## Continue development

Start with [project memory](context.md), [agent instructions](AGENTS.md), [architecture](docs/architecture.md) and [the constitution](docs/governance/constitution.md). The active [V2 tasks](openspec/changes/implement-prd-v2/tasks.md) and [protected short-invitation tasks](openspec/changes/add-protected-short-invitations/tasks.md) identify unfinished implementation and acceptance work; use the conformance ledger above for evidence rather than inferring completion from checked-in code.

The [V3 PRD](docs/evidence/TailMouse_PRD_v3.zh-CN.md), [V4 PRD draft](docs/evidence/TailMouse_PRD_v4.zh-CN.md) and [V4 scope decision](docs/decisions/2026-006-v4-remote-work-direction.md) preserve the next product direction. V4's native receiver, file sharing and named loopback TCP forwarding are planning, not implemented features. Follow [SDD](docs/development/sdd.md) to review and accept the corresponding OpenSpec change before implementing them. V4 inherits V3 Native rather than introducing a second native client.

## Build and try locally

Clone the repository, then use the exact Node, pnpm and Go versions in [tooling/versions.json](tooling/versions.json), with Corepack available:

```sh
git clone https://github.com/lotosli/tailmouse.git
cd tailmouse
```

Enable Corepack's pnpm shim before building. Ensure that shim precedes any separately installed pnpm on PATH, so nested build commands use the same pinned package manager. From the repository root:

```sh
corepack enable pnpm
git submodule update --init -- third_party/tailcat
corepack pnpm install --frozen-lockfile
corepack pnpm build
```

Native output is `.artifacts/native/tailmouse` (`tailmouse.exe` on Windows); static Web output is `apps/web/dist/`. The build verifies the initialized Tailcat checkout against the recorded gitlink. Do not copy in a separately downloaded Wasm or update the submodule implicitly. Dependencies and build outputs are recreated from tracked inputs; no previous contributor's `.artifacts/`, `node_modules/` or `dist/` directory is required. Local builds and hermetic Worker tests do not require Cloudflare credentials; deployment and opt-in public acceptance are separate operator workflows.

In each macOS/Linux terminal used below, add the built CLI to PATH:

```sh
export PATH="$PWD/.artifacts/native:$PATH"
tailmouse version
```

Serve the built Web client for a browser on this same computer:

```sh
corepack pnpm --filter @tailmouse/web exec vite preview --host 127.0.0.1 --port 4173 --strictPort
```

Leave that terminal running. In another terminal at the repository root, start either example:

```sh
tailmouse escape --web-base-url http://127.0.0.1:4173/
tailmouse leash --web-base-url http://127.0.0.1:4173/ -- vim
```

The second example requires Vim on the host. Open the invitation printed by the CLI in your browser. Leash's default `connect-or-enter` policy waits for a valid browser connection or local Enter before starting the saved command.

The loopback URL is only for a browser on the host computer: `127.0.0.1` on a phone means the phone itself. For a phone, use the verified official `https://link.tailmouse.com/` deployment or publish the same static files to another trusted reachable HTTPS origin, set `--web-base-url` or `TAILMOUSE_WEB_BASE_URL` to that origin, then scan the new QR code. The [self-hosting guide](docs/web-self-hosting.md) covers HTTPS, Nginx, MIME types, compression, cache updates and non-root mounts. Vite preview is a local verification server, not the production hosting configuration.

## Escape

```sh
tailmouse escape --web-base-url http://127.0.0.1:4173/ --control touch --map courtyard --seed 42 --round 45s
tailmouse escape --web-base-url http://127.0.0.1:4173/ --control tilt --once=false
```

Collect both cheeses, then reach the unlocked exit before capture or timeout. Use the touch joystick and Dash control; tilt is an explicit optional action with permission and calibration, and touch remains available after refusal. The browser shows RTT, connection state and dash cooldown. The host decides collisions and results.

The terminal shows the spectator map and scent trail. `q` or Ctrl+C closes Escape; after a result, `r` starts another round when `--once=false` and the session has not expired. `d` toggles debug details. Defaults are a 45-second round and a 10-minute session TTL. A temporary connection loss slows/stops movement, then pauses the round; reconnect has a 30-second grace window.

## Leash

On macOS, launch an interactive zsh:

```sh
tailmouse leash --web-base-url http://127.0.0.1:4173/ -- /bin/zsh -i
```

Or launch Vim and other terminal commands with their own arguments:

```sh
tailmouse leash --web-base-url http://127.0.0.1:4173/ --readonly --start-on now -- vim
tailmouse leash --web-base-url http://127.0.0.1:4173/ --title demo --no-restart --no-terminate --post-exit-ttl 0 -- printf hello
tailmouse leash --web-base-url http://127.0.0.1:4173/ -- codex
tailmouse leash --web-base-url http://127.0.0.1:4173/ -- claude
```

The last two commands are AI CLI examples and require the selected program to be installed and configured on the host. Leash has no AI-provider integration: standards-based terminal CLIs and TUIs use the same PTY byte stream and inherit the selected command environment and filesystem authority.

Arguments after `--` are passed literally to the launched program, not interpreted as TailMouse flags. When switching programs, replace their arguments too: Vim's `-u NONE -U NONE -i NONE -n` options must not be passed to zsh. Use `/bin/zsh -f -i` to test without personal shell startup configuration. Pipes, redirects, wildcards and variables require an explicitly launched shell; TailMouse does not interpret them. Restart reuses the original argv, working directory and environment rather than accepting a replacement command from the browser.

The browser provides a terminal, touch history scrolling, Esc/Tab/arrows, Ctrl/Alt modifiers and explicit copy/paste. Readonly hides input and process controls and is enforced by the host, but it does not redact sensitive output. Enable Screen reader support explicitly if needed. Browser Backpressure pauses input; use the displayed recovery action, and do not assume already-sent input can be safely retried.

Browser disconnect normally leaves the child running and returns the Host to listening; Leash has no reconnect-grace deadline. The same live page can explicitly open a fresh stream with credentials still held in memory and receive reset, retained scrollback and live output in order. A reopened page needs the original invitation and, for protected access, the separate code again. The default raw-byte scrollback is 1 MiB (configurable from 64 KiB to 16 MiB); older bytes may be dropped with an indication. This is bounded history, not a terminal recording.

Leash's session TTL and post-exit retention both default to `host`: access and a safe retained result remain until Host shutdown or local revocation. An explicit total TTL can bound access; an explicit positive `--post-exit-ttl` bounds retained result time, and `--post-exit-ttl 0` ends it immediately. Child exit releases PTY/process/input/pump resources even while bounded output and final status remain available. Expiry revokes browser access but does not kill a running child by default. `--kill-on-expire` and `--kill-on-disconnect` explicitly request termination and remain subject to the process-tree limitation above.

While a child runs, the first local Ctrl+C interrupts it; a second within two seconds requests host and child shutdown. Ordinary `q` remains application input. Browser interrupt/restart/terminate require confirmation and the host's permission. These controls are not a security sandbox or a replacement for OS process isolation.

## Configuration and relays

```sh
tailmouse config path
tailmouse --help
tailmouse escape --help
tailmouse leash --help
```

Settings resolve per field as **flags > environment > version-1 TOML > defaults**. Boolean flags can be disabled with `--flag=false`. See [configuration](docs/configuration.md) for the complete TOML schema, environment selectors, defaults and exit codes.

With no relay override, Tailcat selects from its official relay map. The static Web host serves application files; DERP carries the encrypted connection. Self-hosting the Web files does not create a relay, and using a custom DERP does not host the Web application. Virtual port 44321 is inside Tailcat's userspace network, not a public terminal service to port-forward.

To use an operator-managed relay, follow [custom DERP requirements](docs/custom-derp.md). Hostname mode and HTTPS map mode are mutually exclusive; the selected region is embedded in the invitation, so the browser needs no separate map configuration.

## Security and troubleshooting

- Share invitations privately and keep access codes separate. Keep both out of issue reports, screenshots, terminal recordings, browser diagnostics and shell arguments. `--no-qr` hides the QR, not the remaining `Open:` URL or the terminal-only access code.
- Protected access is not an account identity system: anyone with both credentials can attempt control. In `--no-password` mode, anyone with the invitation alone can attempt the configured permissions. Use an explicit short TTL when Host-lived access is unnecessary.
- The page consumes the fragment and removes it from visible history. Credentials are memory-only: after reload or page-cache restoration, reopen an unexpired original invitation and enter the code again. Caching static Wasm does not preserve a session or make relay connectivity optional.
- A trusted Web deployment matters. There are no required third-party scripts or analytics, but a modified page or browser extension can still expose terminal data. Verify matching Native/Web revision metadata and use the documented HTTPS/security headers.
- `SESSION_BUSY` means another browser owns the slot. `EXPIRED` needs a fresh host session. A protocol mismatch needs compatible Native and Web builds, not repeated retries.
- For a loading failure, check that the static server returns real local JS/Wasm files with the correct MIME and compression headers, not an HTML fallback. Browser permissions or a failed static cache registration do not authorize more capabilities.
- For relay failure, check DNS, public TLS, reachability and the custom-relay restrictions. TailMouse does not provide a production TLS-verification bypass. Capture only redacted error codes and version information.
- Missing clipboard or tilt permission retains the manual paste/touch path. IME/Unicode input uses xterm's native input handling; virtual modifiers apply to keys, not terminal device replies or composed text.
- A GUI-launching command can create a local native window, but Leash shows only its PTY bytes and process state. No desktop, camera or microphone is streamed.

TailMouse does not provide anonymity, file transfer, SSH, a hosted account/control plane or unattended remote administration. Tailcat owns encryption and transport; TailMouse owns session permissions, protocol and the two modes. See [Tailcat's transport description](https://github.com/tailscale/tailcat#readme) for the upstream boundary.

## Development and release checks

After installing dependencies, install the locked Playwright browsers:

```sh
corepack pnpm exec playwright install
```

On Linux, use `corepack pnpm exec playwright install --with-deps` to also install the required system libraries. Review the platform and tool prerequisites in [gates and snapshot builds](docs/development/gates.md) before running:

```sh
corepack pnpm gate:quick
corepack pnpm gate
corepack pnpm tailcat:check
corepack pnpm release:snapshot
```

`gate:quick` is the iteration gate; `gate` additionally runs race, vulnerability and the complete real Go/Wasm impairment suite. Both stop at the first required failure. TypeScript statements/branches/functions/lines and Go statements each retain their configured 80% floor.

`release:snapshot` additionally requires the pinned GoReleaser executable. It creates local six-platform archives and checks identity without signing, deleting prior output or publishing. Local per-artifact SBOM, checksum and source-notice verification are also available. Snapshots are not approved releases. See [gates and snapshot builds](docs/development/gates.md) for prerequisites and the separate release/platform acceptance requirements.

## License

TailMouse-owned source is licensed under [Apache-2.0](LICENSE), with project attribution in [NOTICE](NOTICE). [Third-party notices](THIRD_PARTY_NOTICES.txt) preserve the original licenses and attribution, including the read-only Tailcat submodule. All three files accompany native and static Web distributions. The [source inventory](tooling/third-party-licenses.json) records versions and original-file hashes; `pnpm check:licenses` rejects drift after the build. Dependency changes require reviewing and explicitly updating notices with `pnpm release:notices`.

The repository keeps three application boundaries (`apps/cli`, `apps/web`, `apps/link-edge`), language-neutral contracts under `protocol`, and system tests under `tests`. See [Tailcat ownership](docs/development/tailcat-submodule.md) and the [product baseline](docs/product-baseline.md) for dependency and scope constraints. Tailcat source and its recorded gitlink are read-only unless an update is explicitly requested.
