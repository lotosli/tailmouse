# Six simple sharing workflows — v0.1.0-alpha.3 published

Observed on 2026-10-20: owner-authorized source `ed3b47cd6a1465df6deead93fe16c65e71d08d12` is preserved on remote main and immutable annotated tag `v0.1.0-alpha.3`. Native send/files/text, browser-to-browser transfer, interactive startup and verified installation/update are implemented. README, homepage and resource documentation describe the matching commands and limits.

## Validation and source binding

The complete [Linux gate](full-gate.json) passes on clean `b84ffc7bd7f4bbdc0da93ee5ab68e19558a0c900`: protected Leash, resource/transport journeys, race/vulnerability checks, 186 browser cases with four existing skips, and exactly four profiles in each network suite. Go coverage is 86.3%, resource coverage 81.0%; all four Web/edge metrics exceed 80%. [Interrupted acceptance](interrupted-full-gate.json) is a retained failure, not a pass; its maximum HTML-text frame bug was fixed before the successful gate.

The tag adds only a [UI supplement](ui-supplement.json): homepage browser-sharing entry, tablet panel visibility, long filename wrapping and clearing host selections on End. Native/protocol/tooling inputs remain unchanged. Type/lint checks, 331 browser unit tests, Web build, actual Worker integration and real native/two-browser file/text acceptance pass after these UI changes. Input hashes bind this supplement separately from the full gate.

A clean separate clone of the tag passes normal build, actual Worker integration, six-target archive verification, eight CycloneDX inventories and all distribution checksums. [Build/publication](build-and-publication.json) records exact commands, outcomes and retained log hashes. The downloaded Linux x64 binary runs with the expected version and all seven resource commands plus update help. Other target runtime execution is not claimed.

## Public release and deployment

[Release v0.1.0-alpha.3](https://github.com/lotosli/tailmouse/releases/tag/v0.1.0-alpha.3) (ID `418013885`) was published at `2026-10-20T04:56:07Z`, with prerelease disabled and Latest verified. All 17 assets have matching uploaded sizes and SHA-256 digests. [Public downloads](public-downloads.json) verify every canonical URL without an Authorization header or GitHub cookies. [Manifest](release-manifest.json) and [checksums](SHA256SUMS) are byte-identical copies of the published assets.

The same tag is deployed at https://tailmouse.com, Worker version `2e42c153-9b60-4001-ad3a-b0d0e93123e3` at 100% traffic. [Provider confirmation](deployment.json) binds its manifest SHA-256 `cea980a8d3c9661c38190fbccb9d364a43c21a0f221e1a0448c22e9060bf8a6a`. [Public asset checks](public-assets.json) verify the complete inventory, compression negotiation, configuration, routes and security headers. [Firefox acceptance](public-browser.json) checks the exact manifest, commands/install links and five widths from 390 to 2700px. TLS verification stays enabled.

[Public browser transfer](public-transfer.json) exercises two browser pages over the default public DERP: synthetic file length/SHA-256, text in both directions, fragment consumption and host revocation. [Native installation/update](native-install-update.json) verifies the published POSIX installer and an explicitly stamped current-source updater fixture against the exact downloaded Linux executable. PowerShell 7.6.7 on Linux checks syntax, checksum rejection, preservation and cleanup; native Windows installation remains unverified.

Homebrew and Scoop recipes on main use all six published archive digests and are generated after immutable packaging, avoiding a source/checksum cycle. The final recipe/evidence commit does not change deployed application source.

## Limits

Packages remain unsigned alpha software. Cross-build metadata and checksums do not establish execution on every target. Windows Receive/Dev with Receive remain unsupported; macOS Receive requires APFS. Physical mobile background continuity and native Windows Worker/ConPTY end-to-end acceptance remain unverified. Both browser pages must stay open, sessions expire after one hour, and browsers without streaming save support have a 64 MiB download ceiling. Same-origin previews remain for trusted applications. Tailcat stays pinned at `52fbad323e9d352f1febb623e0975368e9a8cbdd`; no existing tag or asset was overwritten.
