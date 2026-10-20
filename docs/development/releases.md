# Publishing a native preview release

Use a clean source commit already preserved on `main`. Native archives must contain the updated README and notices from that commit. Keep the existing release checks; skipped Actions are not passing CI. The owner explicitly authorized direct commits and public preview downloads on 2026-10-19 with `[skip ci]` messages.

## Build a tagged version

Use the exact versions in `tooling/versions.json`, including GoReleaser and CycloneDX CLI. Create an annotated version tag locally and build in a clean, separate checkout of it with the recorded Tailcat submodule initialized. Never move an existing release tag or overwrite a published asset to repair a release; use a new version.

For `v0.1.0-alpha.3`, from that clean checkout:

```sh
export TAILMOUSE_BUILD_VERSION=0.1.0-alpha.3
export TAILMOUSE_TAILCAT_REVISION="$(git rev-parse HEAD:third_party/tailcat)"
pnpm install --frozen-lockfile
pnpm build
node tools/resource-integration.mjs
goreleaser check --config .goreleaser.yaml
goreleaser release --config .goreleaser.yaml --skip=publish --parallelism=1 --fail-fast --timeout=15m
pnpm release:sbom
pnpm release:verify
(cd .artifacts/distribution && sha256sum --check --strict checksums.txt)
```

The tagged GoReleaser invocation uses the real release version. `pnpm release:snapshot` intentionally stamps a development revision and is not the tagged release command. `.goreleaser.yaml` has publication disabled; this build cannot create a public GitHub Release. A preexisting output directory must be preserved; use a fresh checkout instead of cleaning unrelated outputs.

Check the extracted Linux x64 executable's `version` and resource help commands. Inspect all six binaries' source/toolchain/target identities through the normal release verifier. Record the source revision, tag, toolchain versions, validation log hashes and native execution limits.

## Stage and publish

1. In a new owned directory, copy the six verified native archives and their six `.cdx.json` files from `.artifacts/distribution`. Add the reviewed `deploy/resource/tailmouse-config.test.json` as `tailmouse-config.json`. Include the tagged `apps/web/public/install.sh` and `install.ps1` files: the complete release has 17 assets including its manifest and checksum list.
2. Generate `release-manifest.json` with the version, exact source revision, Tailcat pin, toolchains, known platform limits and byte length/SHA-256 for each of those files. Generate a flat `SHA256SUMS` covering every staged file except itself. Do not publish the distribution's broader checksum list without its Web/edge files.
3. Verify the local tag points to the accepted commit, then push that tag. The existing workflow only runs for `main` pushes and pull requests; keep `[skip ci]` on owner-authorized main commits.
4. Create a draft GitHub release with `--verify-tag`, a title and the reviewed release notes from `docs/releases/`. Upload the complete staged asset list without `--clobber` and compare GitHub's asset inventory and available SHA-256 digests with the local files.
5. Publish with `prerelease: false` and `make_latest: true`, following the owner's 2026-10-20 Latest preference. Verify every public download's bytes against `SHA256SUMS`, rerun the extracted Linux package's version/help checks, and record the actual release URL and asset identities in project memory.

Publication is explicitly authorized for this task; a draft is only an upload staging step. Keep alpha version names and precise failed/deferred outcomes until the remaining platform acceptance is complete. GitHub's Latest label does not establish stability, signing, notarization or all-platform execution.

After public download verification, generate the same-repository Homebrew and Scoop recipes with `node tools/install-recipes.mjs PATH/TO/release-manifest.json .`. Commit the recipes and evidence separately from the immutable release tag; generating archive digests before the archives exist creates a source/checksum cycle. Verify the generated recipes against the public manifest.
