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

The quick/full gate and final clean packaging/publication results are recorded below when observed; focused results alone are not a passing release.

## Environment constraints

This cloud container runs `tail` as PID 1. The normal gate uses `tools/test-subinit.py` only in that environment to reap descendants after the actual process-group cleanup tests. It does not weaken their assertions. Local SSH/SFTP tests use environment wrappers that select an empty SSH configuration because the inherited system include has invalid ownership; host-key checks remain enabled. The container forbids Chromium's sandbox namespaces, so its activation script selects `TAILMOUSE_TEST_NO_SANDBOX=1` for trusted local fixtures. Other environments retain the sandbox by default.

Linux/amd64 is the available native runtime. Six-target cross-compilation and package inspection do not establish macOS, Windows or Linux/arm64 runtime acceptance. Physical mobile devices and arbitrary frontend frameworks remain unverified. The owner-selected same-origin mode is for trusted private applications; it does not provide isolation from hostile preview JavaScript.

Exactly four impairment profiles are selected for both retained Escape and Leash: 20/0/0/1024, 80/20/1/256, 300/20/0/64 and 300/60/5/64, expressed as RTT ms / jitter ms / loss percent / kbit per second. Existing outage and reconnection assertions remain required.

## Publication procedure

1. Run `pnpm gate:quick` and `pnpm gate`; preserve a clean source commit and verify its remote branch.
2. Run `pnpm build`, `pnpm release:snapshot`, `pnpm release:sbom` and `pnpm release:verify` with pinned tools. Preserve existing release directories instead of deleting unrelated output.
3. Run `node tools/resource-deploy.mjs check`, then `node tools/resource-deploy.mjs publish`. The publisher rejects dirty sources, a dirty build stamp, source-revision drift, mismatched inventories and corrupt compressed representations before upload.
4. Run `python3 docs/evidence/resource-release-2026-10-19/verify-public.py apps/web/dist/web-manifest.json PUBLIC_REPORT_JSON`. It uses verified HTTPS, checks all raw representation hashes plus negotiated Wasm, and performs only static reads and a 405 probe. No invitations or credentials enter its evidence.

Publication reuses `tailmouse-resource-test` and its existing `tailmouse.com` custom domain. It adds no business proxy, database, invitation service or analytics. Public CLI downloads remain unavailable until a separate GitHub release is published; the website links the matching source build instructions.
