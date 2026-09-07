## Why

TailMouse currently pins Tailcat commit `4a25a91e0337252a4d16e097b03cf3cbb92c20cd`, while Tailcat v0.6.0 is a signed upstream release at commit `790406204c002a6f109ef7c6a30a436601a1f6a8`. The release adds default WireGuard pre-shared keys, loss-tolerant Meow setup, safer TCP close draining, and faster hermetic network checks that apply directly to TailMouse's existing Native/Wasm transport boundary. Updating now lets the phase-two publication use those upstream security and reliability fixes without copying them into TailMouse.

The measurable outcome is that the parent repository pins the exact v0.6.0 commit, both Native and Wasm artifacts report that revision, every generated Tailcat address contains a nonzero pre-shared key, current v0.6 peers pass real transport tests, and `pnpm tailcat:check` followed by `pnpm gate` exits zero with the submodule clean.

## What Changes

- Advance only the Tailcat submodule gitlink from `4a25a91e0337252a4d16e097b03cf3cbb92c20cd` to the signed v0.6.0 release commit `790406204c002a6f109ef7c6a30a436601a1f6a8`; do not track the later moving `main` head.
- Adopt Tailcat's default nonzero WireGuard pre-shared key for every ephemeral TailMouse Host. Do not set `DisablePresharedKey` or add a downgrade flag.
- Move direct adapter and integration references from deprecated `ConnBlob` APIs to Tailcat's v0.6 `Addr`, `ParseAddr`, and `TailcatAddr` names while preserving the existing TailMouse-owned address boundary and credential handling.
- Rebuild Native and Wasm from the same gitlink; update only dependency-derived checksums, sums, identity metadata, notices, and generated release evidence required by existing gates.
- Verify PSK-bearing full-region addresses stay within MouseCard and QR limits, remain fragment-only credentials, and are rejected or redacted at the same boundaries as the prior address form.
- Exercise the current v0.6 Native/Wasm pairing through the existing real transport suites. TailMouse does not add backward-compatibility probes, modes, or guarantees for earlier Tailcat releases.
- Inherit upstream Meow resend, TCP teardown draining, and hermetic netcheck improvements through the adapter; prove them with existing impairment, close/drain, and Tailcat integration suites rather than duplicate their implementation.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `transport-boundary`: Pin Tailcat v0.6.0, require its default PSK-bearing address path, and migrate the adapter off deprecated upstream names while retaining one exact Native/Wasm revision boundary.
- `invitation-card`: Require the v0.6 PSK-bearing full Tailcat address to remain inside the existing fragment-only size, QR, erasure, and redaction limits.

## Impact

The change affects the `third_party/tailcat` gitlink, the Native Tailcat adapter and its integration fixtures, the generated Tailcat Wasm, Go dependency sums, release identity, dependency notices/SBOM inputs, and compatibility evidence. It does not change TMOUSE/1 framing, identifiers, session policy, access-code authentication, application capabilities, or Tailcat source.

Default PSK addresses improve confidentiality against future store-now-decrypt-later attacks and prevent a DERP operator that sees node public keys from joining the WireGuard tunnel. They also make the complete Tailcat address more sensitive. TailMouse already treats the complete address and invitation as in-memory bearer credentials, and Native/Web artifacts already require one exact shared gitlink. Earlier Tailcat versions are outside the supported and tested product boundary after this upgrade.

The pre-update clean publication checkout recorded unrelated controlling-terminal test timeouts during `pnpm gate`. Compatibility work must preserve that first failure, run its exact unchanged reproduction before attribution, and require a final full zero-exit gate; it must not relabel a pre-existing or intermittent failure as a Tailcat regression.

## Evidence / Assumptions

- **Reported, 2026-09-07:** The owner explicitly requested updating Tailcat to v0.6.0 and testing compatibility.
- **Observed upstream, 2026-09-07:** GitHub marks v0.6.0 as a verified signed release dated 2026-09-04; its annotated tag resolves to `790406204c002a6f109ef7c6a30a436601a1f6a8`, while `main` has already advanced to `7a50a1abd8bca63432afbcc5c04dd278c7029e31`.
- **Observed upstream, 2026-09-07:** v0.6.0 enables a random WireGuard PSK by default, resends Meow pings during setup, drains proxied gVisor TCP close, avoids real-network netchecks in tests, and disables a netns path that previously added three-second loopback netcheck stalls.
- **Observed upstream, 2026-09-07:** v0.6.0 retains `ConnBlob` as deprecated aliases and documents `DisablePresharedKey` as a security-reducing compatibility option that TailMouse does not use.
- **Observed locally, 2026-09-07:** TailMouse imports Tailcat only through its Native adapter and browser Wasm boundary. The current adapter uses the deprecated aliases but constructs an ephemeral zero-value Server, so v0.6.0 will generate and embed a fresh PSK unless TailMouse explicitly disables it.
- **Owner-directed, 2026-09-07:** After the update, TailMouse does not support or test compatibility with earlier Tailcat versions.
- **Unknown:** Exact MouseCard/QR size, Wasm size, third-party notice delta, and full-gate outcome remain unverified until implementation.

## Non-Goals

- Editing, patching, formatting, or committing Tailcat source.
- Tracking Tailcat `main`, automatically floating future tags, or adding a Tailcat update bot.
- Exposing UDP, SOCKS UDP ASSOCIATE, SSH authorized keys, arbitrary forwarding, `TAILCAT_PEER_KEY`, or Tailcat CLI environment behavior as TailMouse features.
- Disabling PSK, adding a user compatibility switch, changing TMOUSE identifiers, or building compatibility probes or guarantees for earlier Tailcat releases.
- Replacing Tailcat tests with TailMouse copies or adding a transport abstraction, service, package, dependency, workspace, or release framework.
- Treating Linux or Windows cross-compilation as native runtime verification; those environments remain `deferred / not verified`.

## Simplicity Budget

- **Dependencies:** No new TailMouse dependency. The existing Tailcat submodule advances to one exact signed release; its upstream module graph changes are accepted only as required by that release. Staying on `4a25a91e` would miss the requested security/reliability fixes, while copying selected fixes would fork upstream behavior.
- **Workspaces/packages:** None. The existing Native and browser adapters remain the only boundaries.
- **Configuration surfaces:** None. A PSK-disable option would weaken the selected security default and is not required by an accepted TailMouse scenario.
- **Protocol surface:** None. Tailcat address bytes change inside the existing opaque MouseCard field; TMOUSE/1 framing and identifiers do not.
- **Abstractions:** None. Directly migrate deprecated calls inside the existing adapter and reuse existing tests/gates.
