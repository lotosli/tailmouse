# Native source recovery investigation

Verification date: 2026-10-17. This is a recovery record, not a declaration that native source is permanently lost or that recovery is complete.

The [redacted observations](recovery-observations.json) retain deployment times, the complete project R2 inventory, asset hashes and distinct environment-version fingerprints. Full private environment locators remain in the local recovery packet.

## Findings

**Observed:** the running environment's `source_config_version_id` differs from the configuration reader's published `base_version_id`. The latter has `draft_id: null` and `revision: null`. A fresh environment-status read repeated the same running version and reported current observations. The opaque identifiers and current thread locator are retained in the local recovery packet, outside the public repository.

**Observed:** the published startup instructions describe completed protected-Leash fixes, a four-profile network gate, and local working-tree changes that must be preserved. They reference `leash-followup.md`, `leash-followup-gate-full-11.log` and its status under `/workspace/.tailmouse-environment`. Those files are absent from this executor. Saved instructions are evidence of a recorded workflow; they do not prove what files a snapshot currently contains.

**Inferred:** the current executor may have restored an older filesystem state or remained attached to an earlier environment version. This is a stronger recovery lead than assuming someone deleted individual source files. The version mismatch alone does not establish which snapshot was mounted or whether a later snapshot retains the resource implementation.

**Unknown:** the precise transition that removed the working-tree state, the contents of earlier/provider-retained snapshots, and whether the original resource source can still be retrieved from them. No available tool can enumerate or restore those snapshots. Thread listing, archived-thread listing and reading this thread's history return that these app tools are unavailable through dynamic tools. There is no usable local conversation transcript in the inspected user history locations.

## Timeline (UTC)

| Time                             | Evidence                                                                                                                                             | Scope                                                          |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| 2026-10-16 01:55:39              | Last checkout/reset records before the recovery work, all at `13440a5c97b15fb1a01aafd93f874ee18e0e35b9`; `go.mod` retains the same modification time | Current filesystem only; not the complete earlier task history |
| 2026-10-16 08:36:03              | First `tailmouse-resource-test` Worker version                                                                                                       | Confirms a deployment existed after that checkout state        |
| 2026-10-16 09:54:33 and 11:54:03 | Two further Worker versions                                                                                                                          | Provider deployment metadata                                   |
| 2026-10-16 17:25:24              | Version `a5b25814-193f-460e-813d-569bb1e6f4e2`, deployed at 100%                                                                                     | Matches the preserved public resource deployment               |
| 2026-10-17 04:03:14              | Earliest connection entry in the available executor log                                                                                              | Connection evidence, not proof of a specific snapshot restore  |
| 2026-10-17 10:38–10:40           | Browser recovery commits `a2b2458` and `8240130`, pushed to the task branch                                                                          | Durable recovered frontend; no recovered native implementation |

The deployed manifest reports `0.0.0-dev.13440a5c97b1.dirty`. Its resource Wasm source hash is `5c4c0109ac7851cd5b1b6cedaa8acff0f724f2b696e0e868f87bbd7638009b87`; Tailcat is `52fbad323e9d352f1febb623e0975368e9a8cbdd`. This is not a matching committed resource source revision. Failing to establish a verified remote source checkpoint left the native implementation dependent on local environment state.

## Searches and limits

| Recovery location                                                                                                                                | Observed result                                                                                                                                                                                                              |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Local Git refs, stash, reflog, worktrees and `fsck --full --no-reflogs --unreachable`                                                            | No resource native source commit, stash, extra worktree or unreachable object; current task recovery commits are present                                                                                                     |
| `/workspace`, `/tmp`, user download/history/cache locations, shared downloads, `/var/tmp`, `/srv`, `/usr/local/src`, mounted workspace locations | No reported October 16 source archives or source patch; no additional project volume visible in the mount inventory                                                                                                          |
| Accessible deleted project file handles                                                                                                          | No matching source/archive handles; this is not a disk-level undelete or provider snapshot search                                                                                                                            |
| Current Go build cache                                                                                                                           | 6,715 files inspected; none predates October 17; no earlier build cache available for recovery                                                                                                                               |
| GitHub refs and public repository events                                                                                                         | Only the old `main` and the new recovery branch/PR refs; no earlier resource commit discovered; event retention is limited                                                                                                   |
| GitHub releases, Actions artifacts and runs                                                                                                      | Zero releases and artifacts. Nine available runs use known old/recovery commits. The sole Actions cache was created October 5, before the missing implementation                                                             |
| TailMouse R2 bucket                                                                                                                              | All 28 objects across two pages inspected; all last modified September 7–8, with no source/native archive                                                                                                                    |
| Cloudflare Pages                                                                                                                                 | No TailMouse-named Pages project found; unrelated projects were not inspected                                                                                                                                                |
| Resource Worker versions                                                                                                                         | Four versions listed. Initial/latest version metadata show an assets binding and the same Worker script ETag. Version-preview manifest requests return 404; historical asset inventories have not been recovered             |
| Current deployed assets                                                                                                                          | All 31 preserved files reverified against the pinned SHA-256/length manifest. Both source maps contain zero Go source entries                                                                                                |
| Resource Wasm                                                                                                                                    | Custom sections are `go:buildid` and `producers`; binary strings identify `apps/cli/internal/flow/scheduler.go` and `apps/cli/internal/transport/tailcat/wasm/main_js.go`. These are location hints, not recovered Go source |
| Codex task attachments/history                                                                                                                   | Current attachment is recovery PR #1. History tools are unavailable; no accessible archived-worktree attachment or local session transcript was found                                                                        |

Cloudflare checks were read-only. No snapshot was republished, no deployment was replaced, and no live invitation storage was read or restored.

## Concrete recovery targets

The earlier conversation reported these locations; their existence and contents could not be reverified on this machine:

- `/workspace/.tailmouse-environment/resource-sharing-wip-2026-10-16.tar.gz` — reported 468 files and 4,333,642 bytes.
- `/workspace/.tailmouse-environment/tailcat-update-verification-2026-10-16.tar.gz` — reported 108 files and 189,482 bytes.
- `/workspace/.tailmouse-environment/tailcat-update-baseline/`.
- `/workspace/.tailmouse-environment/tailcat-update-owned-source.diff`.
- The original `/workspace/tailmouse` working tree after the resource PRD implementation and Tailcat update, including untracked source, tests, build scripts and dependency metadata.

The next recovery action requires access to the published environment snapshot or the earlier task's filesystem/tool transcript. Preserve both reported environment versions. Copy a recovered snapshot into a separate location, inspect archive entries before extracting, compare against the deployed source identities, and create a remote source checkpoint before integrating it. Do not republish the present legacy native tree over the only potentially useful snapshot.

If original source cannot be retrieved, implementing the missing native behavior from the PRD would be a reconstruction with new tests and acceptance evidence. It must not be labeled recovery of the original source or inherit the old test results.

## Preservation now

Recovered browser source and review evidence are committed on `codex/product-onboarding-2026-10` in [draft PR #1](https://github.com/lotosli/tailmouse/pull/1). Repository instructions now require a verified remote source checkpoint before an environment transition or substantive handoff, and prohibit treating a local-only archive as a durable backup. These measures preserve current work; they do not recover the missing native source.
