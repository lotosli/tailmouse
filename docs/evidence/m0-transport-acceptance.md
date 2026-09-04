# M0 transport acceptance

Evidence ID: `M0-20260902-darwin-arm64`

## Scope

This record covers the M0 product path: one installed `tailmouse` host executable, a static browser client with no TailMouse installation, the Tailcat Wasm adapter, fragment-only MouseCard delivery, and bidirectional `TMOUSE-M0-HELLO` echo through both official and explicit custom-host relay configuration.

The network acceptance command handles the invitation only in bounded process memory, sends it directly from the executable's deliberate `Open:` output to an isolated browser context, verifies immediate fragment removal, and emits no credential in its result. The Web application is served as static files; no TailMouse application backend is present.

## Recorded result

- Recorded at: `2026-09-02T15:21:40.431Z`
- Source base revision: `39e95af618f1aef7715f774d37879b495f986f7c`
- Installed binary SHA-256: `25cef91013de46b28403118695fd9e5e37e78604e0189b50aa04c516204ed28f`
- Tailcat gitlink: `4a25a91e0337252a4d16e097b03cf3cbb92c20cd`
- Host: macOS arm64
- Go: `go1.27.1`
- Node.js: `v26.8.1`
- Browser engine: Playwright Chromium, isolated context, no TailMouse browser installation
- Official relay path: passed installed-host-to-static-browser bidirectional echo
- Custom-host relay path: passed installed-host-to-static-browser bidirectional echo using `tc301a.ipn.dev` on the production custom-host port
- Static request inspection: passed; no request contained an invitation fragment
- TailMouse application backend: none

The explicit custom-host endpoint above was a currently served public Tailcat DERP node used to verify the production port-443 custom-host path. The complementary hermetic acceptance starts a controlled local DERP and STUN service, embeds its complete region in the ConnBlob, and proves the same native-to-Wasm exchange without public availability. A real operator-owned hostname remains part of the release-device evidence in task 6.10; this M0 record does not claim that later evidence.

## Reproduction

Run the deterministic transport acceptance first:

```sh
pnpm test:transport
```

Then run the explicit network acceptance with a reachable DERP hostname that accepts unaffiliated Tailcat clients on TCP 443:

```sh
pnpm test:m0-acceptance -- --custom-host <DERP_HOST>
```

The command rebuilds Tailcat Wasm from the recorded gitlink, builds the static PWA, installs a stamped `tailmouse` executable into an isolated temporary directory, executes both relay scenarios, prints a redacted JSON result, and removes the temporary executable. It fails on the first unsuccessful stage and does not belong to the hermetic default gate because public service availability is not a repository invariant.

**Observed, 2026-09-03:** The current reproduction runner uses the shared native build-identity check and validates JSON session diagnostics. The historical public-network result below predates these M1 changes; it is not a claim that the revised public runner has been rerun. The default gate independently repeats controlled local DERP acceptance for the current implementation.

**Observed, 2026-09-03:** The current command has migrated from echo to TMOUSE/1 handshake and explicit session close. It uses a version-1 test config and removes `TAILMOUSE_*` overrides from the child environment, so operator configuration cannot change the selected test path. The M0 result above remains historical echo evidence; the migrated public-network command has not yet been re-recorded. Current hermetic session evidence is in `prd-conformance.md`.

## Gate evidence

The repository delivery gate passed on `2026-09-02` with the Tailcat submodule unchanged:

```sh
pnpm gate
```

The full result included strict architecture and OpenSpec validation, formatting, type-aware lint, typecheck, Go and Tailcat static checks, 18 Web unit tests, upstream Tailcat tests, all configured coverage floors, Native and Wasm builds, the 61.814-second hermetic transport test, 15 desktop/mobile browser tests, Go race tests, and `govulncheck` with no called vulnerabilities. Recorded coverage was:

- Web statements: 81.08%
- Web branches: 81.14%
- Web functions: 80.26%
- Web lines: 82.33%
- TailMouse-owned Go statements: 89.7%

## Close-order regression and correction

**Observed, 2026-09-03:** A later full gate exposed an intermittent native drain failure after a successful browser echo. The original test performed its drain assertion after the approximately sixty-second wrong-token timeout, which could mask the active closer's TCP TIME-WAIT interval.

The recorded upstream revision documents `Server.DrainTCP` as a passive-closer operation in `third_party/tailcat/tailcat.go`. Its existing Wasm connection exposes `closeWrite` in `third_party/tailcat/web/main_js.go`. TailMouse now uses that operation for bounded graceful browser close: browser FIN, native EOF and passive close, browser EOF, then runtime release. Cancellation retains force-close behavior. No Tailcat source or gitlink changed.

The hermetic test now asserts the two-second drain immediately after native echo completion, while the independent wrong-token probe is still running. One focused run passed in 62.571 seconds and two consecutive runs passed in 122.560 seconds. Browser unit tests cover close order, timeout, cancellation, concurrent-read protection, unread data rejection, and repeated close.

The subsequent full gate passed on 2026-09-03, including another immediate-drain integration run (61.617 seconds), 38 Web unit tests, 25 Playwright tests, all owned Go race tests, and vulnerability checks with no called vulnerabilities. Coverage was Go 92.7%; Web statements 87.10%, branches 87.44%, functions 86.29%, and lines 89.09%. The Tailcat submodule remained unchanged.
