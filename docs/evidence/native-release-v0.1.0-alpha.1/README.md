# Native preview v0.1.0-alpha.1 — publication checkpoint

Observed on 2026-10-19: source `a93a5883d5eb2654cce63f8777bc9a0d3e622188` is pushed to `main` and preserved by annotated tag `v0.1.0-alpha.1`. Only documentation differs from application/build source `1d77055`. The normal tagged build, actual Worker integration, all six native archives, eight CycloneDX inventories and 55 distribution checksums pass. The extracted Linux x64 package reports `TailMouse 0.1.0-alpha.1`, the expected protocol identifiers and exact Tailcat revision; resource help commands pass.

[Build and publication record](build-and-publication.json) binds the files, source, validation log hashes and precise upload failure. [Release manifest](release-manifest.json) and [SHA256SUMS](SHA256SUMS) describe the 15 staged GitHub assets. These are verification records, not a claim that binaries are attached to GitHub.

## Current blockers

GitHub draft release ID `417417113` exists with tag `v0.1.0-alpha.1`, but has zero assets. Repository/API writes succeed; `gh release upload` and an explicit request to the official `uploads.github.com` endpoint both return HTTP 401 `Bad credentials`. The regular API host returns 404 for asset upload and is not an alternate upload endpoint. No empty release was published.

The owner explicitly authorized making the entire repository, source and history public on 2026-10-19. The authorized `PATCH /repos/lotosli/tailmouse` with `private: false` returns HTTP 403 `Resource not accessible by integration`. A subsequent read still reports a private repository. Although the account has an admin role, this integration cannot perform the visibility change. The owner can make the change in [repository settings](https://github.com/lotosli/tailmouse/settings): General → Danger Zone → Change visibility → Public. No additional owner approval is needed; the remaining prerequisite is technical access.

The owner has now saved `TAILMOUSE_GITHUB_RELEASE_TOKEN` with both `api.github.com` and `uploads.github.com` allowed. Draft revision 13 reports `has_saved_binding: true`, no binding error and no pending runtime requirements. The earlier tool attempt to extend the destination list failed, but the owner's subsequent configuration change succeeded. The requested fine-grained token permissions are Contents and Administration read/write on this repository; their actual grant remains unverified. The owner reports that saving/publishing is blocked after an `Environment changed` UI conflict. Runtime specification 4 includes the binding but reports readiness `unknown`, and the variable is absent from new shell processes. A saved binding is not proof of runtime delivery or GitHub authorization. Resolve the settings/runtime synchronization issue without recreating the token, adding a duplicate requirement or exposing its value.

## Resume

The accepted files are in `/workspace/tailmouse-release-v0.1.0-alpha.1/.artifacts/github-release`; the local tag checkout is clean. Preserve these files and the draft. Rebuild from the immutable tag with [the release instructions](../../development/releases.md) only if those outputs are unavailable; never replace a published asset or move the tag.

After the binding is ready for both official hosts, use it for the authorized visibility API operation and asset uploads through the inherited proxy, without replacing the platform's general GitHub authentication. Verify that GitHub reports `private: false` and that the repository is publicly accessible. Upload the complete verified file set into the existing draft without clobbering assets; verify asset sizes and hashes. Publish as a public prerelease only when all 15 assets are present and the repository is public. Download and compare every asset, rerun the downloaded Linux package's version/help checks, then update this record and remove the temporary README publication-pending notice.

Keep the exact Windows, signing and device limits in the release notes. The prior full/quick/native CI evidence is preserved under the resource release record; this checkpoint does not claim new all-platform runtime acceptance.
