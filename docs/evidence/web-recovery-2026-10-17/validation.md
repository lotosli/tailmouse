# Validation — 2026-10-17

## Passed

- All 31 original deployment files matched the pinned manifest's byte lengths and SHA-256 values; both source maps were verified before extraction.
- Frozen pnpm installation; strict browser and Worker TypeScript checks; repository type-aware lint; OpenSpec validation; architecture checks; build/release/static-asset tool tests in the quick gate.
- 306 Web unit/component tests passed, including the existing Escape and Leash components. Aggregate statements / branches / functions / lines: 85.89% / 84.34% / 83.51% / 87.44%. No coverage threshold was lowered and no recovered core file was excluded.
- The recovery browser build completed with the unchanged, verified deployed transport binaries.
- Chromium 151.0.7922.34, Firefox 153.0 and WebKit 26.5 passed entry-page checks at 1440px and 390px: section links and reload, Dev walkthrough, missing invitation exits, same-tab malformed resource invitation consumption, legacy invitation erasure, generic metadata, no script exceptions and no external requests. Landing pages had no horizontal overflow. See `browser-results.json` and screenshots.
- Upload UI tests distinguish verification from a confirmed host receipt, display the actual renamed file, copy its path and prepare terminal text without Enter. Permission revocation disables input actions. Quota and cancellation feedback do not invent a saved file or global remaining quota.
- Feedback tests prove that arbitrary stage strings, raw user agent details, URLs and synthetic invitation material are absent from the allowlisted report.

These are browser and synthetic-protocol checks. They are not a recovered native host end-to-end run, physical iPhone/Android verification, framework certification or a real pilot study.

## Required gates and release blockers

Both `pnpm gate:quick` and `pnpm gate` were run. They stop in the existing native staticcheck tool: its export-data reader supports version 4, while the current Go 1.27.2 toolchain emits version 5. The recovered old Go module still pins `honnef.co/go/tools v0.8.1`. No checks were skipped, weakened or relabeled as a full pass.

Independently, the source-release pipeline cannot build the missing native resource host and owned resource Wasm bridge. The regular Vite source build now rejects an identity without resource protocol inputs instead of accidentally bundling a new UI with only the legacy transport. Matching Alpha downloads, native startup/end summaries, authoritative shared remaining-upload quota, --open capacity-release acceptance and a full deployment remain pending native source recovery.

The production test deployment has not been overwritten by this candidate. No native package was published. Existing immutable published artifacts remain unchanged. The branch and draft PR preserve the browser implementation, provenance and concrete remaining work for recovery.

## Environment note

The saved cloud setup installs browser libraries under the writable local sysroot. Playwright's system dlopen check does not discover that local GLES library. The recorded setup procedure was followed: actual sandboxed rendering in all three engines, `ctypes` loading of GLES, and dependency resolution for 118 ELF files passed before caching dependency validation. Routine browser checks then ran without the skip-validation environment flag.
