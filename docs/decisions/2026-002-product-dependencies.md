# Decision 2026-002: Product dependency baseline

- Status: accepted
- Verified: 2026-09-04
- Scope: OpenSpec change `implement-prd-v1`, task 1.1

## Evidence

- **Reported:** PRD v1.0 requires CBOR MouseCards, terminal QR output,
  TOML configuration, Unix PTYs, cross-platform terminal control, xterm.js,
  and FitAddon behavior.
- **Observed:** The Go module proxy reported `fxamacker/cbor/v2` v2.9.3,
  `yeqown/go-qrcode/v2` v2.3.0, `creack/pty` v1.1.24,
  `BurntSushi/toml` v1.6.0, `x/sys` v0.47.0, and `x/term` v0.45.0 as
  their latest stable module versions.
- **Observed:** The npm registry reported `cborg` 6.1.2, `@xterm/xterm`
  6.0.0, and `@xterm/addon-fit` 0.11.0 as their latest stable versions.
- **Observed:** xterm.js 6 removed the Canvas renderer addon and recommends
  its DOM renderer or WebGL. The PRD separately requires Canvas 2D for Escape
  and xterm.js for Leash; it does not require the removed xterm Canvas addon.

## Options

1. Use the latest stable, narrowly scoped libraries listed above.
2. Handwrite general CBOR, QR error correction, PTY, or terminal emulation.
3. Pin xterm.js 5 solely to retain its removed Canvas addon.

## Decision

Use option 1. The selected Go packages are the narrow implementations already
justified by the accepted proposal. `cborg` provides a small pure JavaScript
CBOR implementation without an optional native extraction dependency. The
official xterm.js core and FitAddon satisfy Leash; Escape uses the browser's
Canvas 2D API directly. Do not add an xterm renderer addon unless acceptance
evidence proves the built-in renderer cannot meet the PRD.

Until each Go dependency has a real production import, a build-tagged manifest
keeps it in `go.mod` without adding it to the shipped binary. Each blank import
is removed as its real consumer lands.

## Consequences

- All direct versions are exact in `go.mod`, the pnpm catalog, and lockfiles.
- Release notices and vulnerability checks must cover these modules.
- A dependency change requires current compatibility evidence and an accepted
  OpenSpec update; gates do not float versions automatically.

## QR correction, 2026-09-04

- **Observed:** The release inventory has not located an explicit license grant
  for the original encoder's `yeqown/reedsolomon` v1.0.0 dependency. This is an
  unresolved inventory item, not a legal conclusion about upstream ownership.
- **Observed:** The Go proxy reports `skip2/go-qrcode`
  `v0.0.0-20200617195104-da1b6568686e` as its latest version. Its
  [module license](https://github.com/skip2/go-qrcode/blob/da1b6568686e/LICENSE)
  is MIT, and its encoder/error-correction implementation requires no external
  modules. The age of that latest revision is explicit, not a newer-release claim.
- **Decision:** The accepted proposal replaces only the QR encoder. The current
  narrow bitmap function owns the unchanged M correction, minimum version 4,
  quiet zone and invitation limits. It no longer needs a writer adapter.
  No speculative QR abstraction or Web dependency is added.
- **Verification:** Tests read independent format words, exercise size bounds,
  and decode synthetic short, Escape, Leash and maximum-length content using
  macOS Chromium's native BarcodeDetector. Other platforms retain portable QR
  unit tests; this probe does not claim physical-phone scanning acceptance.

**Supersession, 2026-09-07:** The accepted V2 `add-protected-short-invitations` change removes the former QR version-4 floor. The same pinned encoder now selects the smallest level-M symbol for the displayed URL; four-module quiet zones remain. Terminal presentation uses half-block glyphs, with independent decoding of the rendered matrix.

## Project license and source notices, 2026-09-04

- **Evidence/authority:** PRD release requirements leave the project license unspecified; the owner delegates such omissions. The earlier QR authorization gap is resolved by the accepted encoder replacement, without changing Tailcat.
- **Options:** Apache-2.0 or MIT for owned source; preserving only root licenses or also nested source notices for dependencies. Root-only collection misses separately attributed compression and Go subcomponents. A new classification framework is unnecessary for preserving reviewed, pinned sources.
- **Decision:** Use the complete standard Apache-2.0 text for its explicit contributor patent grant, with project-only NOTICE. One generated third-party text and source/hash inventory preserve all named root/nested legal and attribution files from the production dependency union, plus separately identified source-only OpenSpec skills. Extra source-subtree notices remain attributed without implying linkage. Updating is explicit; gates only verify.
- **Outcome:** The independently collected Go notices match preserved source hashes for all seven targets. Six actual native binaries and bundled Web/Wasm match 56 distribution component versions. All three notice files are verified in six archives and the static Web output; seven SBOMs and 33 checksums pass. Tailcat is unchanged. Future dependency changes require renewed source review; this outcome is not a legal certification or permission to publish.
