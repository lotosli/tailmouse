# Resource release integration — 2026-10-19

The owner authorized normal build integration, missing tests, release acceptance, remote source commits and redeployment of `https://tailmouse.com`. This record supersedes the recovery-only limitation, while preserving the recovery archives as provenance. It does not claim that those archives are release inputs.

## Candidate and observed checks

The normal build now includes native resource commands, owned TMOUSE/2 Wasm, the pinned Tailcat Wasm, preview bootstrap and Escape. Tailcat is pinned to the unchanged upstream main revision `52fbad323e9d352f1febb623e0975368e9a8cbdd`, confirmed against GitHub on this date. Toolchains are Go 1.27.2, Node 26.8.1 and pnpm 11.25.0; local packaging uses GoReleaser 2.18.0 and CycloneDX CLI 0.33.1.

Observed focused acceptance before final release:

- Actual local DERP/native/Chromium resource journeys pass in separate-origin and the authorized same-origin modes: terminal state, HTTP preview, WebSocket, one HTTP mutation, hash-verified 150 kB upload and receipt, insertion without Enter, refresh and revocation. Named Vim and htop redraw acceptance passes.
- Native resource race coverage passes at 80.4%; the normal Go coverage run reports 86.8% aggregate, CLI 81.2% and resource package 80.6%.
- All 316 Web tests pass with all four coverage metrics above 80%, including the restored preview bootstrap. All 68 legacy edge unit tests and 23 local Worker/lifecycle tests pass.
- The real resource Worker verifies every emitted asset's bytes, MIME and cache/security headers, both Wasm artifacts over Brotli/gzip/identity, scoped preview routing, HEAD, 404 and 405. It found and fixed runtime double compression and missing MIME types for extensionless license files.
- The legacy origin verifier now checks the exact two-Wasm inventory and matching compressed representations. Preview framing policy is consistent between its manifest and edge responses.
- Upload tests cover no-overwrite commit, uncertain commit status, quota consumption, hash failure, directory swaps and cleanup. Terminal/control tests cover read-only access, local priority, PID retention, output overflow, heartbeat expiry and revocation. CLI tests cover lifecycle order, fail-before-network validation and redacted root errors.

The final clean release checkout is fixed at `400e146855e2925857f79d414ff4b0441a3cf9fd`, with version `0.0.0-dev.400e146855e2`. The literal `pnpm gate` completed successfully with exit 0 on the pre-cutover base `c9464c60ce576d0601ed69b1bcb130000b3a4259`; see [the bounded gate record](gate-summary.txt). The final production correction sets deterministic UTF-8 headers for HTML/text assets after observing Cloudflare's defaults. It passes focused unit coverage, actual Worker integration, normal root build, rebuilt packages and public verification. The other later changes remove one unused Windows helper and repair test/CI fixtures. Native resource and browser behavior are unchanged from the passing complete gate; no second complete local gate is claimed for the header correction.

Additional observed checks:

- Five decoder/frame fuzz targets pass with ten-second mutation budgets. Native race checks pass. `govulncheck` reports zero reachable vulnerabilities and six findings in required modules outside the application's call graph.
- Clean six-target packaging, eight CycloneDX 1.7 inventories and independent distribution verification pass. All 55 SHA-256 checksums match. The Linux/amd64 executable extracted from its actual archive reports the matching version, Tailcat revision and resource protocol 2, and exposes CLI/Web/Receive/Dev help successfully.
- The full gate passes real transport in 192.661 seconds, Unix Leash in 262.024 seconds, both resource browser journeys in 17.937 seconds, named TUI redraw in 0.305 seconds, and Escape impairment smoke in 16.318 seconds. Browser regression passes 186 cases with four existing platform injection skips. Firefox/WebKit real transport passes in 133.422 seconds; native race and vulnerability checks pass; the four-profile Escape/outage and Leash matrices pass in 119.382 and 282.861 seconds respectively.
- Web coverage is 83.79% statements / 82.07% branches / 80.83% functions / 85.32% lines. The edge package reports 99.37% / 98.98% / 97.36% / 99.64%. Go aggregate coverage is 86.8%, also verified after the portable policy fixture adjustment.

## Failures retained and corrected

Earlier gate attempts exposed a result-screen selector collision, legacy homepage/cache expectations, a source-version change during an active build, and a pnpm installation that rejected symlinked `node_modules`. The selector now targets its result region; navigation assertions retain credential-erasure checks; the release has its own immutable checkout and actual frozen-lockfile dependency installation.

One complete-gate attempt failed to display restored Leash output within its existing 45-second recovery bound. The exact unchanged test then passed in 64.708 seconds, and the next complete Unix Leash phase passed in 262.024 seconds. The failure is retained, not counted as a pass or used to relax deadlines. The subsequent literal full gate also passes, including all four Leash profiles.

Remote CI exposed Windows checkout line endings, Windows module-URL/path construction, a macOS canonical temporary-path difference and an unused Windows helper. Those fixtures are corrected. Hosted Ubuntu additionally reports Chromium's `No usable sandbox` under AppArmor, so only its trusted local browser-test step opts into the existing no-sandbox fixture setting. Generic host authorization/heartbeat and CLI lifecycle tests now use a portable HTTP resource; Unix receive tests retain actual private-file/commit assertions, while unsupported platforms assert fail-closed initialization. Filename validation remains portable. This does not add Windows Receive support or lower coverage thresholds.

Windows ARM64 also attempted to assemble ARM64 cgo code using the image's x64 GCC. Its job now uses `CGO_ENABLED=0`, matching the native release configuration, while retaining native Go execution and upstream C API core tests. Cross-target upstream `go vet` passes with that configuration; remote runtime results are recorded separately.

A hosted macOS run then reached real Leash acceptance and failed the long-task progress assertion after reconnect. Its fixture stopped generating progress after a fixed 40 seconds, independently of the required 31-second offline interval and browser setup. The fixture now accepts an explicit finish signal only after the browser verifies resumed progress and an additional live update. Same-PID checks, the full offline interval and the existing 100-second owner deadline remain intact. Focused Linux acceptance passes in 34.511 seconds. Remote run `39236530254` at `6c41a8a` then passes macOS Leash in 267.302 seconds, both resource journeys in 17.340 seconds and 186 browser cases before matrix cancellation. This changes only test coordination, not shipped runtime behavior.

That run exposes native ConPTY failures on both Windows x64 and ARM64: readiness appears in the parent test log instead of the owned terminal, raw-mode children cannot use console handles, and Windows implicitly starts a `.cmd` interpreter. [Microsoft's confirmed redirected-parent behavior](https://github.com/microsoft/terminal/issues/11276#issuecomment-923207186), retrieved on 2026-10-19, explains the first failure. The correction sets `STARTF_USESTDHANDLES` with null handles so ConPTY supplies them, and rejects resolved `.bat`/`.cmd` scripts before allocation. Existing input, resize, Unicode, interrupt and job-cleanup assertions remain; batch rejection covers explicit paths and stored PATH/PATHEXT. Both Windows targets compile and ARM64 vet passes locally. Native CI is pending; these corrections are not yet in the published `400e146` artifacts.

The first public static verification stopped on HTML MIME metadata: Cloudflare returned `text/html` where the manifest requires `text/html; charset=utf-8`; plain-text notices had the same omission. The Worker now sets both explicitly. The regression supplies bare provider MIME defaults, and Worker line/function/branch coverage is 100%/100%/98.90%. The complete actual Worker asset/encoding test and the strict public verifier both pass after the correction. No verifier assertion was relaxed.

## Published release

`https://tailmouse.com` serves version `0.0.0-dev.400e146855e2` from the remotely preserved `400e146` source revision. Worker version `d475e00f-8985-4913-92de-42cb84b60407` is active at 100%, confirmed through the Cloudflare deployment API. The public manifest SHA-256 is `c45fba651e9567679c6ae186f8cd736a4bbc3d701ed0528e73fb3828dc8eccad`.

- [Deployment metadata](deployment.json) records the exact source and active Worker version.
- [Public asset verification](public-assets.json) matches all 32 representations, both Wasm encoding negotiations, configuration, route behavior and security/cache headers. The Web package contains those representations plus its manifest: 33 files total.
- [Public browser verification](public-browser.json) records a fresh Firefox 153 session with verified HTTPS, the new homepage, working walkthrough, loopback-port guidance, source-build link, exact manifest and no page errors.
- [Packaged Linux executable verification](native-archive.json) binds the extracted executable's version and resource commands to its actual archive hash. Final packaging again verifies six archives, eight SBOMs and all 55 checksums.

These public checks create no invitation or native session. Real terminal/preview/upload/reconnect/revocation acceptance uses the local DERP fixtures described above. GitHub's four-platform CI is still running; local Linux release acceptance is not a claim that all remote jobs have passed.

## Environment constraints

This cloud container runs `tail` as PID 1. The normal gate uses `tools/test-subinit.py` only in that environment to reap descendants after the actual process-group cleanup tests. It does not weaken their assertions. Local SSH/SFTP tests use environment wrappers that select an empty SSH configuration because the inherited system include has invalid ownership; host-key checks remain enabled. The container forbids Chromium's sandbox namespaces, so its activation script selects `TAILMOUSE_TEST_NO_SANDBOX=1` for trusted local fixtures. Firefox also requires its content/GMP/RDD/socket/utility sandbox disabled because `/proc/self/uid_map` is read-only. These are environment settings for trusted fixtures; application deployment does not change browser sandbox policy.

Linux/amd64 is the available native runtime. Six-target cross-compilation and package inspection do not establish macOS, Windows or Linux/arm64 runtime acceptance. Physical mobile devices and arbitrary frontend frameworks remain unverified. The owner-selected same-origin mode is for trusted private applications; it does not provide isolation from hostile preview JavaScript.

Exactly four impairment profiles are selected for both retained Escape and Leash: 20/0/0/1024, 80/20/1/256, 300/20/0/64 and 300/60/5/64, expressed as RTT ms / jitter ms / loss percent / kbit per second. Existing outage and reconnection assertions remain required.

## Publication procedure

1. Run `pnpm gate:quick` and `pnpm gate`; preserve a clean source commit and verify its remote branch.
2. Run `pnpm build`, `pnpm release:snapshot`, `pnpm release:sbom` and `pnpm release:verify` with pinned tools. Preserve existing release directories instead of deleting unrelated output.
3. Run `node tools/resource-deploy.mjs check`, then `node tools/resource-deploy.mjs publish`. The publisher rejects dirty sources, a dirty build stamp, source-revision drift, mismatched inventories and corrupt compressed representations before upload.
4. Run `python3 docs/evidence/resource-release-2026-10-19/verify-public.py apps/web/dist/web-manifest.json PUBLIC_REPORT_JSON`. It uses verified HTTPS, checks all raw representation hashes plus negotiated Wasm, and performs only static reads and a 405 probe. No invitations or credentials enter its evidence.
5. Run `node docs/evidence/resource-release-2026-10-19/verify-browser.mjs LOCAL_WEB_MANIFEST BROWSER_REPORT_JSON [TRUSTED_PROXY_CA]` for a fresh public Firefox profile. The optional environment-provided proxy CA is imported into that isolated profile; HTTPS verification stays enabled. This checks the actual homepage, interactive guide, source link and exact public manifest, without creating a native session.

Publication reuses `tailmouse-resource-test` and its existing `tailmouse.com` custom domain. It adds no business proxy, database, invitation service or analytics. Public CLI downloads remain unavailable until a separate GitHub release is published; the website links the matching source build instructions.
