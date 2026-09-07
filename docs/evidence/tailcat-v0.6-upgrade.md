# Tailcat v0.6.0 upgrade evidence

## Decision and provenance

- **Owner-directed, 2026-09-07:** TailMouse shall update to Tailcat v0.6.0 and, after the update, support and test only the current pinned Tailcat revision. No PSK-disable option, downgrade path, or compatibility guarantee for earlier Tailcat releases is part of the product.
- **Observed upstream, 2026-09-07:** GitHub's tag-object API reports annotated tag `v0.6.0` as `verified: true`, `reason: valid`, verified at `2026-09-04T18:39:04Z`, and targeting commit `790406204c002a6f109ef7c6a30a436601a1f6a8`.
- **Observed locally, 2026-09-07:** The parent gitlink advances from `4a25a91e0337252a4d16e097b03cf3cbb92c20cd` to that exact release commit. `git -C third_party/tailcat status --short` remains empty. The update does not edit Tailcat source or track its later `main` head.
- **Observed locally, 2026-09-07:** The root module graph changes only as required by v0.6.0: `tailscale.com` advances to `v1.103.0-pre.0.20260904030409-31d8badb3bfb` and indirect `github.com/tailscale/wireguard-go` advances to `v0.0.0-20260904023712-e855235c55a2`. No new TailMouse direct dependency or replace is added.

## Implemented boundary

The existing Native adapter now calls the v0.6 `Addr`, `ParseAddr`, and `TailcatAddr` APIs. Tailcat types remain confined to the Native and browser adapters. TailMouse still supplies a zero-value PSK configuration, so Tailcat v0.6 generates one fresh nonzero 256-bit WireGuard pre-shared key during `Server.Start`; `DisablePresharedKey` remains false and no compatibility setting is exposed.

Tailcat reports entropy failure during PSK generation as an upstream startup panic. The adapter contains startup panics at that volatile boundary, closes the backend, and returns only the existing redacted `ErrStart` classification before an invitation or application stream exists. Tests use generated in-memory credentials or synthetic redacted values only.

The PSK-bearing address remains one opaque MouseCard field. A real full-region address passes the existing canonical CBOR, 1400-byte URL, fragment-only, QR, browser consumption, erasure, and diagnostic-redaction contracts. Oversized input fails before any partial invitation is returned or displayed. TMOUSE framing and identifiers are unchanged.

## Verification

| Evidence | Result |
| --- | --- |
| Unchanged pre-upgrade PTY reproduction | Passed in 1.239 s; the earlier timeout was not reproduced or attributed to Tailcat |
| `pnpm tailcat:check` at the recorded v0.6 gitlink | Passed upstream module verification, tidy diff, vet, tests, Native build, and Wasm build; submodule remained clean |
| Focused Native adapter unit suite | Passed |
| `pnpm test:transport` | Passed current v0.6 Native-to-Wasm controlled-DERP acceptance in 193.695 s |
| `pnpm test:leash` | Passed nine macOS Native/PTY/Wasm/browser scenarios in 251.298 s |
| `pnpm test:escape-network` | Passed the complete impairment, disconnect, reconnect, and close/drain matrix in 1043.252 s |
| Root `pnpm build` | Passed after the required module-graph tidy |
| Notices and distribution | Verified 57 component versions, 123 notice sources, six Native archives, 20 Web files, seven CycloneDX 1.7 SBOMs, and complete SHA-256 coverage |
| `pnpm gate:quick` | Passed; 211 Web unit tests, 166 browser cases with four capability-specific skips, real transport, macOS Leash, and impairment smoke all passed |
| Coverage | Web statements/branches/functions/lines were 95.80%/93.95%/95.46%/96.36%; Go statement coverage was 90.4% overall and 90.7% for the Tailcat adapter |
| Final `pnpm tailcat:check` | Passed at `790406204c002a6f109ef7c6a30a436601a1f6a8`; the submodule remained clean |
| Full-gate Escape matrix | Passed in 1055.281 s after race checks and zero called vulnerabilities |
| Full-gate Leash matrix | The fail-fast run stopped after 2493.52 s when `rtt80-jitter60-loss5-kbit64` timed out during fresh-stream reconnect after three retryable `SESSION_BUSY` responses |
| Exact unchanged failure profile | Passed independently in 59.435 s with the same code, v0.6 artifacts, network parameters, assertions, and deadlines; accepted under the owner's existing non-reproduction rule without a code or timeout change |
| `pnpm fuzz:smoke` | Passed all four fuzz targets |

The generated Web manifest records the same Tailcat commit as the Native build. Its Tailcat Wasm objects are:

| Encoding | Bytes | SHA-256 |
| --- | ---: | --- |
| raw | 27,102,859 | `77ebe853e89e0bebf67908d5334e26bacca5daf66885d039e1f4efb41b2b1bcb` |
| gzip | 6,289,532 | `2f6ea9f97bab1147e97867f7c3506235438c877e5e9fa61e528b0b0811cce686` |
| Brotli | 5,068,045 | `cbaaaf7a5236815f3259616da1357f761815f016be024e11a43f0bdbcdad67ad` |

Compared with the previously recorded artifact, raw Wasm is 33,655 bytes smaller, gzip is 5,200 bytes larger, and Brotli is 3,379 bytes smaller. These are build outputs, not a browser-memory claim.

## Scope and remaining proof

TailMouse inherits v0.6's Meow setup retries, proxied TCP close draining, and hermetic netcheck improvements through the unchanged upstream implementation. It does not expose Tailcat application UDP, SOCKS UDP association, SSH authorized keys, forwarding/exit-node behavior, peer-key identity, or CLI environment configuration.

Linux and Windows artifacts are cross-built and inspected, but native runtime behavior remains `deferred / not verified` under the current owner-selected macOS scope. The Tailcat v0.6 upgrade is accepted for the current macOS scope. Publication must use artifacts rebuilt from the committed v0.6 gitlink rather than any pre-upgrade output.
