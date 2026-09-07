## 1. Establish the upgrade baseline

- [x] 1.1 Preserve the existing `pnpm gate` failure evidence, then rerun `go test -count=1 -failfast -run='^(TestProtectedConnectOrEnterStartsOneImmutableCommandUnderRace|TestProtectedCredentialUsesOnlyTerminalAndReportsRedactedState)$' ./apps/cli/cmd/tailmouse` without changing the tests. Stop on a repeatable failure and handle it separately; do not attribute a pre-existing or intermittent PTY failure to Tailcat.
- [x] 1.2 Verify that signed tag `v0.6.0` peels to `790406204c002a6f109ef7c6a30a436601a1f6a8`, advance only the `third_party/tailcat` gitlink from `4a25a91e0337252a4d16e097b03cf3cbb92c20cd` to that commit, and prove the upstream checkout is clean with `git -C third_party/tailcat status --short` and `git diff --submodule=short -- third_party/tailcat`.
- [x] 1.3 Run `pnpm tailcat:check` before adapting TailMouse and preserve its first failing command as the compatibility baseline.

## 2. Adapt the existing boundary

- [x] 2.1 Replace direct deprecated `ConnBlob`, `ParseConnBlob`, and server address references inside the existing Native/Wasm adapters and their integration tests with `Addr`, `ParseAddr`, and `TailcatAddr`; keep Tailcat types inside the established boundary and add no package, abstraction, dependency, or configuration switch.
- [x] 2.2 Add focused tests proving that the default v0.6 server produces a PSK-bearing opaque address, TailMouse never enables `DisablePresharedKey`, PSK-generation failure stops before invitation creation, and credential-bearing errors and retained invitation state remain redacted and erased. Use only generated in-memory credentials and synthetic redacted fixtures.
- [x] 2.3 Extend invitation and QR tests so a v0.6 full-region address remains below the existing 1400-byte limit, round-trips as one opaque MouseCard field, stays in the URL fragment, and is rejected before display if an existing bound is exceeded. Do not add a MouseCard or TMOUSE PSK field.
- [x] 2.4 Prove the current v0.6 Native/Wasm pairing with `pnpm test:transport` and `pnpm test:leash`; add no backward-compatibility probe, downgrade, or guarantee for earlier Tailcat releases.
- [x] 2.5 Run the existing impairment and close/drain suites, including `pnpm test:escape-network`, to verify that TailMouse inherits v0.6 Meow retries and TCP draining without duplicating upstream behavior; retain the upstream netcheck tests as the proof for hermetic test discovery.

## 3. Rebuild evidence and pass release gates

- [x] 3.1 Rebuild Native and Wasm from the one recorded gitlink with `pnpm build`, regenerate only dependency-derived notices and SBOM data with `pnpm release:notices`, `pnpm release:snapshot`, and `pnpm release:sbom`, then verify identity and licensing with `pnpm check:licenses` and `pnpm release:verify`.
- [x] 3.2 Record the verified current-version behavior, security trade-off, artifact sizes, unsupported earlier-Tailcat boundary, and deferred Linux/Windows runtime status in English project evidence and architecture memory, reconciling any owner edits before touching shared files.
- [x] 3.3 Run `pnpm gate:quick`, `pnpm tailcat:check`, `pnpm gate`, and `pnpm fuzz:smoke` in that order with fail-fast semantics. Require statements, branches, functions, and lines to remain at or above 80%, a clean Tailcat checkout, and matching Native/Wasm revision identities. Preserve any full-matrix failure and, under the owner's existing non-reproduction rule, accept it only when the exact unchanged profile passes independently without relaxing assertions or deadlines.
- [x] 3.4 Review the final diff to confirm it contains no Tailcat source edits, PSK downgrade, UDP, SSH, forwarding, peer-key identity, new service, new extension point, or unrelated cleanup; run `git diff --check` and stage only explicitly reviewed paths.
