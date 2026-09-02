# Decision 2026-002: Product dependency baseline

- Status: accepted
- Verified: 2026-09-02
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
