# Resource sharing

This guide describes `cli`, `web`, `receive`, `dev`, `send`, `files` and `text` under TMOUSE/2. Protected legacy Leash retains its separate contract; the minigame was removed in 1.0.

## Simple sharing additions (alpha.3)

`tailmouse send FILE` offers one file and `tailmouse files DIRECTORY` offers read-only, root-confined browsing. The `files` manifest resource authorizes only `download` streams. `files.list` takes a relative `path` and bounded `offset`; replies contain at most 40 entries plus `next`/`more`. `download.begin` selects one path, followed by `download.ready` (name/size), bounded data frames, an end frame and `download.completed` (size/SHA-256). Clients verify both before committing the save. Symlinks, hidden names, non-regular files, absolute paths and traversal are rejected or omitted. Names are limited to 180 UTF-8 bytes, relative paths to 512 bytes and pages to 40 entries so even escaped metadata fits one bounded JSON frame. Directory enumeration stops at 10,000 entries. Two active downloads, configured file/traffic budgets and attempt counts bound resource use; failed attempts do not refund reservations. Changes to native file size/mtime during reading fail the transfer.

`tailmouse text [TEXT]` exposes the `text` resource and authenticated text channel. `text.get` reads the current value; explicit `text.set` replaces it. `text.value` replies contain at most 16 KiB of plain UTF-8 with only newline, carriage return and tab control characters. Native stdin is bounded; diagnostics contain only operational metadata. The host command's deliberate text surface displays replies. There is no shell/clipboard side effect. Text exists only in session memory.

The website's `/#share` page can initiate a browser-host session with selected File objects and text. Its Worker owns an ephemeral Tailcat listener, pins authenticated peers to member grants and reuses the same framing, visitor UI and integrity checks. The default is one visitor, one hour, up to 100 selected files, 256 MiB per file and a 1 GiB download budget. A reconnect uses the existing peer key and grant within a 60-second control-disconnect window. Host keys/invitations/text are not saved; a closed host page requires a new session. Closing or expiring the host ends active access. Background mobile continuity is not promised. Browsers without a streaming save picker have a 64 MiB Blob fallback ceiling. Static hosting does not relay or store transferred content.

Old frontends fail closed on unfamiliar resource IDs. These are optional TMOUSE/2 resources; Protected Leash and existing resource channels retain their contracts. See [installation and usage](../README.md) for the startup wizard, checksum-verified archive installers, native updater and package-manager recipes. Published archives remain unsigned.

## Native configuration

With v0.1.0-alpha.2 or newer, no local configuration file is needed for the hosted service. Run `tailmouse web 8080`, `tailmouse cli -- sh`, `tailmouse receive ./uploads` or a valid combined `dev` command. Create the receive directory first. Both hosted origins default to `https://tailmouse.com` with the existing trusted-app same-origin mode; use only preview applications you trust.

`--config FILE` remains optional for custom deployments and saved preferences, and accepts either native TOML or deployment JSON. Limits-only configuration keeps the hosted defaults. Setting either frontend or content origin disables the implicit hosted pairing: custom Web deployments need an explicit content origin and separate registrable domains, or explicit `--test-single-origin` for trusted test applications. An explicit test-mode value always takes precedence. Defaults are embedded; startup does not fetch or create a local configuration file. The browser still reads its deployment's static configuration normally.

Default limits are TTL 1h, approval `auto`, one member, 256 MiB per file, 1 GiB cumulative upload traffic, 100 creation attempts and two active uploads. `--max-clients` permits 1–4. Decimal KB/MB/GB and binary KiB/MiB/GiB are deliberately different. Canceled traffic and failed creation attempts consume their respective budgets.

`--cli PROGRAM` declares one executable with no shell splitting. Use `-- PROGRAM ARGS...` for arguments; the two forms cannot be combined. Dev needs at least two resources. No uploaded file is executed, extracted or automatically sent to a CLI.

Every common flag maps to `TAILMOUSE_` plus its uppercase name with underscores: for example `TAILMOUSE_FRONTEND_BASE`, `TAILMOUSE_CONTENT_BASE`, `TAILMOUSE_DERP_MAP`, `TAILMOUSE_TTL` and `TAILMOUSE_MAX_FILE`. Priority is explicit flag > environment > configuration > default. An explicit missing or malformed configuration fails startup.

A native-only TOML configuration can include local filesystem paths:

```toml
version = 1
[share]
frontend-base = "https://ui.example.com"
content-base = "https://preview.example.net"
ttl = "1h"
max-clients = 2
max-file = "256MiB"
max-total = "1GiB"
max-files = 100
```

`--derp-map` accepts a local file or HTTPS map, with `--derp-region` selecting an included region. Only the selected relay information travels in the invitation; the browser never reads the host's local path. See [custom DERP](custom-derp.md) for relay requirements. The transport adapter does not enable a general exit node, arbitrary forwarding or an unauthenticated shell.

`--json` writes deliberate `share.created` output containing the invitation, then redacted lifecycle/operational events. It cannot take interactive local PTY input. `--open` passes the invitation through a platform API or stdin rather than a subprocess argument. Diagnostic errors and upload events omit filenames, paths, terminal bytes, cookies and HTTP bodies. Operational notifications are bounded and best effort if local output is slow; they are not a durable audit log. Nothing is uploaded to analytics.

## Ownership and reconnection

A native session owns its child process, HTTP target, cookie jars, upload reservations and grants. Grants bind an authenticated member to the actual transport peer, session generation and expiry. Every business stream is authorized again. The adapter binds grants to a key-derived peer IP with 80 bits of key identity. The current Tailcat revision also exports full peer-key lookup, but this adapter does not use it or claim full-key binding.

Control heartbeat is 5 seconds with a 15-second liveness budget. Reconnection is bounded to 60 seconds with jitter, using the same browser transport key. It does not replay terminal input, HTTP mutations or upload commits. An upload that loses its final confirmation queries the existing upload ID; it never starts another file as an implicit retry. A native directory-sync error after atomic creation is retained as an uncertain storage result and cannot create a duplicate on retry.

Refresh recovery lives in per-tab sessionStorage on `s-<session>.<frontend-base>`, never in the untrusted preview. A final rejection, leave or terminal session outcome erases it. Background/locked mobile browsers may suspend Workers, sockets and uploads. Returning to the foreground may require recovery or a fresh invitation; background continuity is not promised.

The child survives a guest disconnect and reconnects with the same PID. One native reader feeds bounded output/history queues. A slow guest cannot block PTY collection. A natural child exit remains visible; standalone CLI retains its result for 60 seconds, while Dev keeps other resources running. Ending the native session terminates owned PTY process groups within its cleanup budget; this does not claim to control descendants that deliberately create unrelated OS sessions.

After bounded output history overflows, the terminal shows a persistent recovery notice and requests an application redraw by resizing. Some applications, including htop, may only send partial updates in response. A controlling visitor can use the existing Ctrl+L button when that is the application’s redraw shortcut; read-only visitors cannot inject it. Reconnection retains the child PID but does not promise a complete terminal snapshot.

Ctrl+] opens local management. Numbered visitors can be approved, granted the single input seat, or revoked. Local input revokes remote input authority before writing. `--read-only`/`--cli-read-only` rejects remote input, resize and interrupt natively. OSC 52 clipboard writes are blocked and terminal links require confirmation.

## Web compatibility

The native target freezes its resolved IP set at startup. Every resolved address must be loopback unless `--allow-remote` explicitly authorizes this target. Unspecified/multicast addresses, alternate target authorities, CONNECT, proxy environment variables and cross-origin redirects are rejected. Host/SNI retain the original logical target identity. Failed TCP preflight leaves Web unavailable so a developer can start the server later; TLS failure never downgrades to HTTP. A canceled request does not mark an otherwise healthy service unavailable.

Supported HTTP methods are GET, HEAD, POST, PUT, PATCH, DELETE and OPTIONS. Request and response bodies use bounded streamed chunks. HEAD, 204 and 304 have no response body; non-HTML Range responses retain their semantics. HTML gzip/deflate decoding and shim insertion remove stale lengths, content encodings and validators. The bounded prelude preserves the doctype and checks restrictive meta CSP before releasing application HTML. Upstream CSP, X-Frame-Options and COOP/COEP are not removed. An additional policy restricts business assets and requests to the shared origin.

Cookies are native in-memory jars isolated by session/member/resource. No local browser profile is read. Cookie/Host and hop-by-hop headers supplied by the guest cannot replace native authority; Origin and Referer are mapped only from the exact content or logical upstream origin. `credentials: omit` bypasses the jar. Set-Cookie is not exposed to preview JavaScript. Tests cover member separation, path, expiry, HttpOnly handling, Secure and a same-origin SameSite subset. Go 1.27 treats loopback as a secure cookie context as current browsers do; non-loopback HTTP never receives Secure cookies. Insecure `SameSite=None` is rejected. Complex cross-site or JavaScript cookie flows require separate compatibility work.

The main-thread WebSocket shim preserves text/binary messages, subprotocols, bounded bufferedAmount and close codes, with bounded response acknowledgments. It is installed before application scripts. It does not intercept Worker WebSockets or turn a Service Worker into a transparent WebSocket proxy. A named framework is supported only once its exact version appears in the acceptance ledger.

Unsupported policy, blocked cross-origin traffic and upstream failure affect Web independently. A lost response to a write means **the result is unknown**: verify application state before retrying. The client does not automatically replay the write. A curl/webhook request to a sharing address receives static bootstrap behavior, not upstream business content.

## Receive safety

The receiver anchors an existing directory with `os.Root`, excludes the filesystem root and user home, and keeps private 0700 staging directories and 0600 files. Names are NFC-normalized, bounded to 180 UTF-8 bytes including the final suffix, and reject traversal, separators, encoded separators, control characters, hidden names and reserved device names.

Linux commits the verified open inode using no-replace `linkat`. macOS uses the open-inode APFS clone operation and fails closed on unsupported filesystems. A completed file remains after the session ends. Hash mismatch, cancellation or quota failure does not produce a completed receipt. Cancellation before commit is checked again immediately before the atomic operation; cancellation after its linearization point does not undo a completed file.

A local ownership key, signed stage markers, signed temporary filenames and per-session locks identify abandoned TailMouse partials. Startup cleanup never recursively removes arbitrary directories merely because they resemble temporary names, and never deletes another live host's partials. The ownership key grants no session or resource access. Unknown files remain untouched.

Choose a dedicated upload directory that other software will not automatically execute or load as configuration. Directory uploads, resumable partial uploads and native Windows receive acceptance are outside v1.

## Static deployment

Use two independently registrable bases, for example `ui.example.com` and `preview.example.net`. Two subdomains under `example.com` do not satisfy isolation. Configure wildcard DNS for `*.ui.example.com` and `*.preview.example.net`, plus TLS certificates covering those names. The examples are reserved domains, not live service claims.

1. Build the complete distribution and verify its manifest and notices.
2. Copy [the public configuration](../deploy/resource/tailmouse-config.example.json) to `tailmouse-config.json`, replace the two base origins and optionally add an HTTPS `derpMap` plus integer `derpRegion`.
3. Serve this same JSON from `/tailmouse-config.json` on the trusted UI and point native `TAILMOUSE_CONFIG` or `--config` at its local copy. Keep private paths and secrets out of this public file; use native flags/environment/TOML for those overrides.
4. Serve `apps/web/dist` using the UI and content hosting headers recorded in its `web-manifest.json`. Configure TLS and the origin-specific framing policy on your static host. Provisioning DNS/certificates or publishing files is an operator action, not performed by this repository build.
5. Run a new resource invitation and verify initial and deep navigation through the controlled preview before making a deployment claim.

The trusted origin serves the UI, local Worker/runtime/Wasm assets, configuration and release manifest. UI/Wasm bundles use content-addressed filenames. The content origin serves only `/.tailmouse/` bootstrap assets from the same release; other paths return 404 until the browser's Service Worker controls them. Set `Service-Worker-Allowed: /` only for `/.tailmouse/sw.js`. JS must have a JavaScript MIME type and Wasm `application/wasm`; never return HTML for a missing asset. Bootstrap and configuration require revalidation; content business responses are not stored by TailMouse.

No database, account service, session lookup table or business HTTP gateway is required. The persistent Bridge frame waits for SW control and binding before its application frame navigates. Its MessagePort grants only the fixed Web resource; it receives no invitation, member grant, CLI capability or upload receipt. New SW instances request a fresh bridge binding. Ending a workspace makes a best-effort content SW/cache cleanup, while native revocation remains authoritative even if browser cleanup cannot finish.

The release manifest ties native/source identity, frontend major, TMOUSE major, upstream gitlink, owned resource Wasm and every emitted UI/Bridge/SW file hash. The resource Wasm inventory accepts only the recorded Tailcat workspace dependency; other module replacements or missing checksums fail closed. A major mismatch is rejected without a security downgrade. HTTPS and a trusted entry document remain necessary: asset hashes alone cannot defend against an operator replacing the entry document and its checks together.

## Errors and diagnostics

Stable process exits are 0 normal completion/end, 2 configuration, 3 resource initialization, 4 transport startup/cleanup, 5 security policy and 6 internal/output failure. Child exit status is a resource state, not the CLI process's exit code.

| Code or state                                              | Scope and action                                                                                              |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| UNAUTHORIZED / EXPIRED                                     | Session access ended; clear recovery and obtain valid access.                                                 |
| SESSION_BUSY                                               | Admission/stream capacity; wait for the host or another member to leave.                                      |
| BAD_FRAME / incompatible major                             | Reject the stream/session; use matching builds.                                                               |
| READONLY                                                   | CLI permission; only the host can grant input.                                                                |
| WEB_POLICY / WEB_TLS                                       | Web security boundary; correct the declared target or trust configuration.                                    |
| WEB_UNAVAILABLE / WEB_SOCKET_FAILED                        | Web resource; inspect/reprobe the local application.                                                          |
| WEB_UNSUPPORTED_SECURITY_POLICY / WEB_UNSUPPORTED_ENCODING | Web compatibility; do not remove policy or disable verification to conceal failure.                           |
| REQUEST_RESULT_UNKNOWN                                     | HTTP mutation may have completed; inspect application state before retrying.                                  |
| UPLOAD_NAME_INVALID / UPLOAD_LIMIT                         | Receive input/quota; choose a valid name or ask the host to change limits.                                    |
| UPLOAD_HASH_MISMATCH / UPLOAD_STORAGE                      | No successful completion confirmation; inspect storage, then deliberately start a new attempt if appropriate. |
| UPLOAD_CLOSED                                              | The requested active/completed upload is unavailable to this member.                                          |

The release evidence under `docs/evidence/resource-release-2026-10-19/` distinguishes local automated acceptance from unverified native platforms and physical devices. Use the repository security reporting guidance for vulnerabilities; never include invitations in public issues.

## Owner-selected tailmouse.com test deployment

The owner explicitly selected one origin for both UI and preview. [tailmouse-config.test.json](../deploy/resource/tailmouse-config.test.json) sets both bases to `https://tailmouse.com` and opts in with `testSingleOrigin: true`. No extra domain or wildcard subdomain is required. The workspace lives at `/.tailmouse/workspace/`; each preview uses a separate `/.tailmouse/p/<session>/` Service Worker scope, so ordinary UI asset requests do not enter the application proxy.

This mode is only for testing applications trusted by the owner. Same-origin preview scripts can access the UI and its browser storage; the malicious-content isolation requirement is not satisfied and is not claimed by its acceptance test. Native grants, fixed upstreams, upload checks and resource limits still apply. The UI and native output explicitly identify the test mode. Ordinary links/forms/history navigation use the preview namespace; direct absolute `location` assignment can leave it. The normal configuration remains available for isolated untrusted-preview acceptance.
