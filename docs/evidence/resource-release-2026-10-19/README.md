# Resource release integration — 2026-10-19

The normal build produces CLI, Web, Receive and Dev, both source-built Wasm transports, preview bootstrap and the retained Escape game. Recovery archives are provenance only. The owner authorized remote source commits and redeployment to the existing private test origin, `https://tailmouse.com`.

## Published source and artifacts

The deployed source is `8955e4763c087c5d8529134a143534ab07d9d742`, version `0.0.0-dev.8955e4763c08`, preserved on `codex/product-onboarding-2026-10` in [PR #1](https://github.com/lotosli/tailmouse/pull/1). Worker version `1ceb2b09-31fa-4255-bdd9-98ea99a348fb` receives 100% of traffic. The public Web-manifest SHA-256 is `7eb4d2079ce9afabd8ead2b20dec528a87eacfc81362112ad65bd8e2b207e4e1`.

Tailcat source and gitlink remain unchanged at `52fbad323e9d352f1febb623e0975368e9a8cbdd`, observed upstream main on this date. Toolchains are Go 1.27.2, Node 26.8.1 and pnpm 11.25.0; packaging uses GoReleaser 2.18.0 and CycloneDX CLI 0.33.1.

- [Deployment metadata](deployment.json) binds the source to the active Worker version and publication time.
- [Public asset verification](public-assets.json) matches all 32 representations, both Wasm compression paths, scoped preview routing, configuration, MIME, cache/security headers, HEAD, 404 and 405. The Web package contains those files plus its manifest.
- [Public browser verification](public-browser.json) records a fresh Firefox 153 profile: homepage, interactive walkthrough, loopback-port guidance, source link, exact manifest and no page errors. TLS verification stays enabled using the environment's trusted proxy CA.
- [Native archive verification](native-archive.json) binds the extracted Linux/amd64 executable's version, protocol identities and CLI/Web/Receive/Dev help to its archive hash. Six native archives, eight CycloneDX 1.7 SBOMs and all 55 distribution checksums pass independent verification from the clean deployed checkout.

The public checks create no invitation or native session. Actual terminal, preview, upload, reconnect and revocation acceptance uses local DERP fixtures.

## Acceptance evidence

The literal Linux `pnpm gate` passes at `2a5c854`, which contains all deployed production and build-tool changes. [The bounded gate record](gate-summary.txt) identifies that source and the raw local log hash. The deployed `8955e47` adds only portable tests and project memory; its focused Linux race checks pass in 1.631 seconds and both Windows architectures pass the complete native Go coverage gate. [Windows step evidence](windows-native-checks.json) records exact source, jobs and timestamps.

In [workflow 39247007408](https://github.com/lotosli/tailmouse/actions/runs/39247007408), the full Linux and macOS jobs pass; Linux also verifies six archives, eight SBOMs and the complete distribution. Both Windows native Go gates pass at 80.5%. Their full jobs report a resource Worker fixture failure after about eight seconds, then remain alive without completing. The run was canceled for diagnosis after more than 50 minutes; those Windows jobs and the dependent fuzz job are not passes. A corrected teardown and bounded test runner await a fresh complete workflow.

Observed local full-gate results:

- Real native/Wasm transport: 192.190 seconds. Unix Leash/browser acceptance: 258.054 seconds. Separate-origin and authorized same-origin resource journeys: 18.161 seconds. Named Vim/htop redraw: 0.294 seconds.
- Resource journeys verify terminal state, HTTP preview, WebSocket, one HTTP mutation, hash-verified 150 kB upload/receipt, insertion without Enter, refresh and revocation. Unit/race checks cover permissions, controller priority, expiry, quotas, no-overwrite commits, uncertain commit status, cancellation and redacted root errors.
- Browser regression: 186 passes and four existing platform-injection skips. Firefox/WebKit real transport: 132.860 seconds. Native race checks pass. Vulnerability scanning finds no called or imported-package vulnerability; six findings remain in required modules outside the application's call graph.
- Go statement coverage: 86.8%. Web statements/branches/functions/lines: 83.84% / 82.07% / 80.83% / 85.35%. The legacy edge package retains all four metrics above 97%. The new canonical-source helper has 100% line/branch/function coverage through real Git/Go builds.
- Escape/outage acceptance: 119.788 seconds. Leash network acceptance: 275.020 seconds. Exactly four profiles are used for each: RTT/jitter/loss/kbit values `20/0/0/1024`, `80/20/1/256`, `300/20/0/64` and `300/60/5/64`. Existing outage and reconnect assertions remain unchanged.

## Corrected failures and retained limits

The Worker fixture registered temporary-directory removal before runtime closure. A direct Node test confirms that an exception in the first cleanup hook prevents later hooks from running. Windows file locking makes that order unsafe; the still-open runtime also prevents process exit and delays the default reporter's failure details. Cleanup now joins runtime closure before deleting owned files and preserves cleanup errors. TAP reports failures directly; the existing 120-second test deadline remains, with a separate 150-second process bound for teardown. CI runs this Windows boundary early and emits phase notices for observable progress. Focused Linux Worker integration passes in 3.116 seconds, and the owned-child timeout is verified; Windows confirmation remains pending.

Windows native CI exposed redirected-parent ConPTY handle duplication, implicit batch-script dispatch, a console-close race during forced termination, and job accounting reaching zero before detached process handles signaled exit. The implementation initializes null ConPTY standard handles, rejects resolved `.bat`/`.cmd` scripts without an explicit interpreter, gives final cleanup ownership of console closure and waits for bounded identity-checked member handles. Both native architectures verify forced cleanup with a running root and attached/detached descendants. No deadline or exit assertion was relaxed.

Shared CLI and resource tests had unnecessary Unix-only tags. Portable native-child and console fixtures now check startup/retention/restart, read-only and disabled controls, resize, exact input chunks, short-invitation cleanup, management actions, output failures, diagnostic order and bounded drain. The failed Windows coverage runs at `c2a3d1a` (79.5%) and `2a5c854` (79.8%) remain failed; meaningful missing scenarios bring both architectures through the unchanged 80% gate at the deployed source.

A full-history Tailcat checkout changed embedded Go module versions despite an identical gitlink, causing strict notice verification to fail. Upstream Wasm now builds in a temporary tag-free depth-one clone of the verified local dependency. Actual synthetic Git/Go builds prove identical Wasm bytes before and after source tags appear. The dependency source, embedded VCS checks and notice verifier remain intact. Rebuilding the deployed revision in the active workspace produces the identical Web-manifest hash as its clean release checkout.

Earlier failures also identified Cloudflare double compression and MIME defaults, Windows checkout/path portability, macOS temporary-path canonicalization and a long-task fixture that stopped before reconnect acceptance completed. Corrections preserve asset integrity and original user-visible assertions. One local Leash recovery timeout passed on unchanged focused reproduction and subsequent complete gates; that failed attempt is not counted as a pass or used to widen deadlines. Earlier revisions of this record preserve the detailed intermediate run history.

This container uses an init-like descendant reaper because PID 1 does not reap, an empty-config SSH wrapper because an inherited include has invalid ownership, and explicit sandbox settings for trusted local browser fixtures because namespace creation is unavailable. Host-key and public TLS checks remain enabled. These settings do not alter deployed browser sandbox policy.

The same-origin deployment is the owner's trusted private-app test exception; it does not isolate hostile preview scripts. Native Windows Receive remains unsupported. Windows ConPTY native Go acceptance does not establish a browser-to-ConPTY end-to-end journey. Go 1.27.2 does not provide a Windows/ARM64 race detector; that runner retains native tests, coverage and vulnerability checks. Physical mobile devices, arbitrary frontend frameworks and execution of every cross-built archive remain unverified. Public CLI downloads are not published; the website links matching source-build instructions.

## Repeatable publication

1. Run quick/full gates and preserve the clean source on the remote task branch.
2. Run `pnpm build`, `pnpm release:snapshot`, `pnpm release:sbom` and `pnpm release:verify` with pinned tools; verify `checksums.txt` inside `.artifacts/distribution`.
3. Run `node tools/resource-deploy.mjs check`, then `node tools/resource-deploy.mjs publish`. Source/manifest drift, dirty identity and invalid asset/encoding inventories fail before upload.
4. Run `python3 docs/evidence/resource-release-2026-10-19/verify-public.py apps/web/dist/web-manifest.json PUBLIC_REPORT_JSON` and `node docs/evidence/resource-release-2026-10-19/verify-browser.mjs LOCAL_WEB_MANIFEST BROWSER_REPORT_JSON [TRUSTED_PROXY_CA]`.

Publication reuses `tailmouse-resource-test` and its existing custom domain. It adds no business proxy, database, analytics or invitation service.
