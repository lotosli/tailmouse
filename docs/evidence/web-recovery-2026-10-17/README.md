# Browser recovery and onboarding evidence

## Observed baseline

On 2026-10-17 the executor contained clean legacy commit `13440a5c97b15fb1a01aafd93f874ee18e0e35b9`, with no prior uncommitted resource implementation, stash, unreachable Git objects, release packages or attached task artifacts. GitHub had only `main`, no pull requests and no Actions artifacts. This establishes the checked locations, not proof that every other machine has lost its copy. The owner has been asked for a backup/workspace location.

The public deployment remained available. Its manifest SHA-256 is `6ab99ac1aeb6e499c1b3fb00d786a4ac14c444e14cfeeaa7a60aadb18e31503e`; its reported version is `0.0.0-dev.13440a5c97b1.dirty`, with Tailcat `52fbad323e9d352f1febb623e0975368e9a8cbdd` and resource protocol 2. These describe that deployed binary, not the old native tree.

All 31 manifest entries were downloaded and checked for exact byte length and SHA-256. Twenty-eight owned TypeScript/TSX sources were recovered from the two verified source maps. The resource CSS was recovered from the manifest-listed compiled CSS. `source-provenance.json` records exact original source hashes and the CSS byte range. The Worker module was retrieved read-only from the existing deployment; it is stored as deployment evidence, not installed as a second backend.

The original `index.html` and `service-worker.js` are checked in because their public paths are mutable. Hashed assets are preserved by the explicit recovery build. `tools/recover-web-assets.mjs` always uses the pinned manifest; it cannot silently adopt a newer live manifest or mismatched bytes.

## What is missing

- Native resource command/session/preview/upload implementation and tests.
- TailMouse-owned resource Go/Wasm bridge source and its build pipeline.
- Matching native Alpha packages and native end-to-end acceptance evidence in this executor.
- Authoritative remaining-upload-quota data exposed to the browser. The recovered host contract provides configured limits, not a live global remaining counter.

Do not replace these items with a legacy CLI or call the preserved Wasm a source rebuild. No native support, framework compatibility or real participant outcome is inferred from browser mocks or screenshots.

## Recovery candidate

The candidate restores the browser baseline and improves acquisition guidance, first Receive success, the Dev workflow, permissions, lifecycle messages, failure actions, upload receipts, generic metadata and manual allowlisted feedback. Public CLI availability is explicitly pending. It also handles fragment-only invitation navigation while allowing known homepage anchors to survive reloads.

`pnpm web:recovery-build` verifies the preserved binaries and emits `.artifacts/web-recovery`. Its manifest identifies the frontend commit and dirty state, the original manifest hash, and `nativeSourceRecovered: false` / `resourceWasmRebuilt: false`. The normal Vite source build fails explicitly while the resource release inputs are missing. This candidate is not a full native release.

Validation results and remaining gate blockers are recorded in `validation.md` after the final checks. Screenshots and machine-readable browser results are kept with the recovery evidence. No real invitation or private application data is used in these tests.
