# Native preview v0.1.0-alpha.1 — publication checkpoint

Observed on 2026-10-19: source `a93a5883d5eb2654cce63f8777bc9a0d3e622188` is pushed to `main` and preserved by annotated tag `v0.1.0-alpha.1`. Only documentation differs from application/build source `1d77055`. The normal tagged build, actual Worker integration, all six native archives, eight CycloneDX inventories and 55 distribution checksums pass. The extracted Linux x64 package reports `TailMouse 0.1.0-alpha.1`, the expected protocol identifiers and exact Tailcat revision; resource help commands pass.

[Build and publication record](build-and-publication.json) binds the files, source, validation log hashes and precise upload failure. [Release manifest](release-manifest.json) and [SHA256SUMS](SHA256SUMS) describe the 15 staged GitHub assets. These are verification records, not a claim that binaries are attached to GitHub.

## Current blocker

GitHub draft release ID `417417113` exists with tag `v0.1.0-alpha.1`, but has zero assets. Repository/API writes succeed; `gh release upload` and an explicit request to the official `uploads.github.com` endpoint both return HTTP 401 `Bad credentials`. The regular API host returns 404 for asset upload and is not an alternate upload endpoint. No empty release was published.

The repository is private. The owner has been asked whether downloads should remain limited to authorized repository users, whether the entire repository should become public, or whether a separate public download repository is wanted. No visibility change is authorized or performed at this checkpoint.

A missing-upload secret requirement, `TAILMOUSE_GITHUB_RELEASE_TOKEN`, is saved in the Codex environment draft with delivery scoped to `uploads.github.com`. It needs a GitHub token with Contents read/write on this repository. Do not put its value in chat or source. Saving the requirement does not supply the credential or prove upload access; the runtime change still requires environment publication and a successful upload check.

## Resume

The accepted files are in `/workspace/tailmouse-release-v0.1.0-alpha.1/.artifacts/github-release`; the local tag checkout is clean. Preserve these files and the draft. Rebuild from the immutable tag with [the release instructions](../../development/releases.md) only if those outputs are unavailable; never replace a published asset or move the tag.

After the upload binding is ready, use the configured secret only for the official upload destination, retaining the platform's existing GitHub API authentication for metadata. Upload the complete verified file set into the existing draft without clobbering assets; verify asset sizes and hashes. Publish as a prerelease only when all 15 assets are present. Download and compare every asset, rerun the downloaded Linux package's version/help checks, then update this record and remove the temporary README publication-pending notice.

Keep the exact Windows, signing and device limits in the release notes. The prior full/quick/native CI evidence is preserved under the resource release record; this checkpoint does not claim new all-platform runtime acceptance.
