# Native preview v0.1.0-alpha.1 — publication verified

Observed on 2026-10-19: source `a93a5883d5eb2654cce63f8777bc9a0d3e622188` is pushed to `main` and preserved by annotated tag `v0.1.0-alpha.1`. Only documentation differs from application/build source `1d77055`. The normal tagged build, actual Worker integration, all six native archives, eight CycloneDX inventories and 55 distribution checksums pass. The extracted Linux x64 package reports `TailMouse 0.1.0-alpha.1`, the expected protocol identifiers and exact Tailcat revision; resource help commands pass.

[Build and publication record](build-and-publication.json) binds the files, source, validation log hashes and publication outcome. [Release manifest](release-manifest.json) and [SHA256SUMS](SHA256SUMS) describe the 15 published GitHub assets.

## Public release

[TailMouse v0.1.0-alpha.1](https://github.com/lotosli/tailmouse/releases/tag/v0.1.0-alpha.1), release ID `417417113`, was published as a prerelease at `2026-10-19T16:02:20Z`. The repository is public, and all six archives, six CycloneDX inventories, public configuration, source manifest and checksum file are attached. Every GitHub asset digest and size matches the accepted staged file.

On 2026-10-20 (Asia/Shanghai), the owner explicitly requested removing the prerelease flag and setting this release as Latest. Both the update and `/releases/latest` confirm release `417417113` with `prerelease: false`. All 15 asset IDs, sizes and SHA-256 digests and the release notes remain unchanged. The version is still `v0.1.0-alpha.1`, with the existing preview/platform limits.

[Public download verification](public-downloads.json) records fresh downloads of all 15 assets without supplying an Authorization header or GitHub cookies. Each file matches its byte length and SHA-256. The downloaded Linux x64 executable reports the expected release/protocol/Tailcat identity and passes CLI, Web, Receive and Dev help checks. No native execution claim is added for the other cross-built targets.

The owner made the repository public after administration API requests returned HTTP 403. Their screenshot showed Administration and Contents read/write selected; the API authentication-routing cause was not established. The scoped release credential subsequently reached runtime state `ready` and successfully uploaded every asset to the official endpoint. The earlier cloud environment publication UI failure is distinct from this verified runtime credential delivery.

## Reproducibility and limits

The immutable release tag remains at `a93a5883d5eb2654cce63f8777bc9a0d3e622188`. Follow [the release instructions](../../development/releases.md) to rebuild it; never replace a published asset or move this tag. Subsequent homepage and documentation changes do not alter the release source or its archives.

Keep the exact Windows, signing and device limits in the release notes. Prior full/quick/native CI evidence is preserved under the resource release record. The six packages remain unsigned previews; Windows Receive is unsupported and final native Windows Worker confirmation remains deferred.
