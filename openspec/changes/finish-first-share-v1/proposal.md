# Finish the first-share experience and publish 1.0

Status: accepted by the owner's 2026-10-20 instruction to implement the product/UX review and publish/deploy v1.0.0.

## Evidence and decision

Review of public alpha.3 and source a6800d1 found installation-first onboarding despite browser hosting, a Receive-first guide unsuitable for Windows, late file validation, no browser QR/system share, no runtime byte progress, opaque download capabilities, replacement-text ambiguity and a non-recovering CLI wizard. The live mobile homepage was 8,300px tall. Two same-name selected files reproduced a start-time error.

Implement two task entry points, immediate per-file validation with editable selection, local QR and explicit system sharing, actual runtime byte progress, persistent session state separated from transient actions, expiry and honest transfer states, capability-aware downloads, clear replacement-text editing and platform-aware retrying CLI guidance. Use existing components, browser APIs and the already pinned Go QR encoder in the owned Wasm bridge. No new dependencies, workspaces, service, analytics, account system, browser storage or upstream changes. An additional QR service or persistent session history would add unnecessary scope and credential persistence.

The release number is owner-directed. Keep six targets and document unsigned packages, native Windows Receive/Worker limits and physical mobile limits honestly; signing identities and real-user study results are not available and cannot be invented. Provide an actual synthetic-data transfer recording and an executable study plan, without recording invitations or contacting participants. Add GitHub topics, installation/uninstallation/recovery documentation and a concise current compatibility matrix. The owner subsequently explicitly requires complete removal of the Escape minigame: delete its CLI/UI/core/assets/tests/build and network-suite entry points. Keep protected Leash, native resources, the trusted same-origin exception and the four representative Leash profiles. Historical release/evidence records remain immutable.

## Boundaries

TMOUSE/2 remains unchanged: a sender's completed write is not proof the visitor saved a file. Show this distinction rather than inventing a delivery receipt. QR matrices and native-share payloads remain within explicit sharing surfaces and memory, with no public third-party QR endpoint. Download validation still checks length and SHA-256; canceled attempts retain existing quota semantics. Text remains one shared value, not chat/history; refresh cannot erase an unsent draft. Invalid wizard input may retry under the existing context, while denied terminal launch never executes. Versioned tags/assets remain immutable; recipes follow published digests.

## Acceptance

Selection correction, oversize/browser limit feedback, QR decoding of synthetic invitations, system-share cancellation/failure, runtime progress/error bounds, status visibility after transient actions, download success/cancel/retry, replacement-text drafts and CLI invalid-choice/readonly/platform paths. Complete quick/full gates, six-target tagged packaging and public download verification; test public browser transfer and installer/update, deploy exact tagged source and preserve source-bound evidence. No public network is required by the test suite.

## Observed legacy-origin cutover

On 2026-10-20 the public link.tailmouse.com manifest still identifies 0d53eb28cb72 and advertises the removed game, independently of the alpha.3 resource site. Completing the owner's removal therefore includes updating the existing legacy Worker/R2 deployment. Preserve its existing SQLite namespace and API; do not restore or delete invitation data. A small entry-router supplement sends only known, non-credential homepage/hosting anchors to the canonical product site. Exact legacy fragments and short locators keep their authentication origin, and custom origins remain untouched. This avoids offering browser hosting from an origin without resource deployment configuration. The full native/protocol gate binds the preceding candidate; the separately recorded UI supplement reruns affected Web, build and Worker checks before tagging. No native, protocol or edge application/API source changes are needed.

## Outcome review — 2026-10-20

Published ordinary Latest v1.0.0 and deployed the tagged application at both official origins. The complete Linux gate plus source-bound UI supplement pass; native/protocol/edge business source remains unchanged between the full-gate candidate and final UI commit. All public native assets, actual installation/update, five-width layouts, browser file/text transfer and synthetic protected short-link lifecycle/code entry pass. A retained gzip OS header preserves an existing immutable runtime representation while matching every decoded byte from the fresh tagged build; separate legacy manifests/SBOMs and public raw hashes verify it. Existing namespace and rate bindings remain unchanged. Signing/native-device/study limits stay explicit. Topics remain blocked by an actual GitHub integration 403, separately from delivered product/release/deployment work.
