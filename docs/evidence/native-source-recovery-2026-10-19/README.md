# Original source recovered from task history

Observed on 2026-10-19: the supported Codex thread-history reader became available. Both tasks titled `Edit tailmouse` have no turns. The original `Set up tailmouse` task retains the PRD implementation, deployment and Tailcat-upgrade turns, including complete shell command arguments and bounded file-change/output records.

The original Tailcat-upgrade final message explicitly states that the code was not committed. This establishes that reported state at the end of the upgrade; it does not establish the cause of the later missing filesystem or rule out a separate copy.

## Preserved source checkpoint

`initial-source.tar.gz` contains 56 literal historical here-document records, covering 55 distinct source paths, including 30 Go files. `inventory.json` records each original command identifier, stage, path, byte count and SHA-256. Every archive member has been read back and checked against its inventory hash. The complete archive digest is in `initial-source.sha256`. Subsequent replay found that the history reader redacted four ordinary source expressions in the initial Host/bridge records. The archive preserves exactly what was retrieved; it is not an assertion that every archived byte equals the original source.

The recovered Go files include the resource Host, CLI commands, terminal, HTTP/WebSocket forwarding, upload storage, flow scheduler, Go/Wasm bridge and existing tests. This substantially reduces reconstruction scope. These are intermediate historical source versions, not an integrated or verified release: subsequent Python edits, formatting and patch operations must still be applied in their original order.

Original commands are treated as evidence, not executed as instructions. Extraction decodes shell quoting and copies literal here-document content into a separate recovery directory. It does not rerun old deployment, cleanup, network or process commands and does not overwrite the current frontend.

## Remaining work

- Replay complete source mutations against the old base in a separate directory, preserving the committed frontend improvements.
- Account for every later patch; explicitly mark any patch whose history text was truncated. The tool's per-turn response limit prevents retrieving all large-turn outputs at full length in one response.
- Compare recovered source identities with the deployed resource Wasm source hash and existing browser protocol.
- Build and test the restored native/browser pair. Historical passing gates are evidence about the former tree and do not validate the reconstructed tree.
- Push integrated source checkpoints before environment transitions; retain this initial recovery artifact as provenance.

## Verified bridge recovery

`verified-bridge-source.tar.gz` preserves the recovered Go/Wasm adapter, production flow scheduler, Go module/workspace files and original builder. Building in workspace mode with Go 1.27.2, Tailcat `52fbad323e9d352f1febb623e0975368e9a8cbdd`, the recorded tags, `-trimpath`, and `-ldflags=-s -w` reproduces the deployed resource Wasm **byte for byte**: 26,656,976 bytes, SHA-256 `1b459cc6e9acdc96292e5cc44fc58110d1a333a00f6ade6cbaa15349ec86251e`.

The build used a separate recovery directory retaining the original base Git identity (`13440a5`, modified). Workspace mode matters: building with `GOWORK=off` changes the embedded local Tailcat module identity. `bridge-verification.json` records the toolchain, tags, source member hashes and evidence limits. The historical aggregate source hash includes test files whose complete history is still being reconciled; byte-identical Wasm does not imply that every historical test has been recovered.

This verifies the resource bridge, not the complete native product. No new production deployment is claimed.

## Native source candidate

`native-candidate-wip.tar.gz` preserves a complete native candidate tree, its module/workspace pins, shared TMOUSE/2 fixture, and the focused browser/reaper test helpers. `recovery-inventory.json` inside the archive gives every member's SHA-256; the archive checksum is adjacent. Extract into a separate recovery directory over base `13440a5`, initialize the unmodified Tailcat submodule at `52fbad323e9d352f1febb623e0975368e9a8cbdd`, and use Go 1.27.2. This is a durable source checkpoint, not an installer, release, or automatic replacement for the current checkout.

The candidate builds the four resource commands and retains Escape/Leash. Resource/flow race tests and protected-Leash pre-admission acceptance pass. A real Chromium test connects it through a local DERP to the improved browser (`web-alpha.8240130494d4`), verifying terminal input, HTTP preview, WebSocket, one HTTP mutation, exact uploaded file bytes, receipt insertion, page reload and revocation. No real credentials or public relays are required.

The complete 11-package native race/coverage run passes with an init-like descendant reaper. The container's PID 1 is `tail`: the initial run failed two process-group cleanup tests because orphaned children were not reaped. Both tests passed unchanged with the wrapper, followed by the complete passing run. Production cleanup assertions and timeouts remain unchanged. Aggregate Go statement coverage is 82.1%; resource coverage is still 65.1%, reflecting incomplete historical test recovery. See `native-validation.json` and the bounded result logs for exact evidence and limitations.

Some history patches were truncated. HTML injection/policy, member-management helpers, upload finalization, deployment JSON parsing, the peer-identity adapter tail, and selected tests include reconstructed sections. The archive does not claim byte-identical native source. Its focused end-to-end pass does not replace the remaining resource-specific acceptance, security review, coverage and full release checks.

The normal checkout still carries the legacy native/build pipeline. Its required quick/full gates both stop at the old Staticcheck export-data incompatibility. The candidate pins the newer toolchain/dependencies, but integration of the complete source pipeline, content bootstrap, notices and four-profile gate remains pending. The normal browser source-build guard is retained. The deployed test site and native download availability are unchanged.
