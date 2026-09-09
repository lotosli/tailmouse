# Decision 2026-006: V4 remote work scope and interaction draft

- Status: owner-requested product scope; interaction and implementation design pending review
- Recorded: 2026-09-07
- Scope: product evidence and planning only; no active runtime, protocol, dependency, or deployment change

## Evidence and assumptions

- **Reported, 2026-09-07:** The owner requested a V4 PRD covering native receiving with attempted direct connectivity, file upload/download, and explicitly selected port forwarding. The owner then required a complete user interaction journey before documenting the requirements.
- **Reported, 2026-09-07:** The owner clarified that files should support sharing one file and a browsable download directory resembling Nginx directory indexing. File sharing therefore cannot require a terminal task.
- **Observed, 2026-09-07:** V3 already defines a native Leash receiver with direct/DERP behavior. The current production CLI remains a Host; Tailcat v0.6.0 supplies native dialing, path observation, and file/port primitives behind the existing adapter boundary.
- **Observed, 2026-09-07:** V2 supplies separate access-code authentication, one active remote, Host-owned task lifetime, bounded history/results, and a narrowly scoped official short-invitation service. These are the shared product foundation, not permission to expose unauthenticated upstream file or TCP services.
- **Observed, 2026-09-07:** The official Nginx autoindex documentation describes directory listings and file metadata presentation, not an upload workflow. This is a UI reference rather than a runtime dependency.
- **Inferred:** Single-file shares, directory shares with explicit read/write modes, and optional Leash file access satisfy the clarified file workflows. Named Host-loopback TCP services remain Leash-only. Standalone file shares can have bounded independent receiver leases without widening Leash's one-remote rule.
- **Inferred:** Browser and Native should both transfer files, while local TCP listeners belong to Native. Browser public preview links need a separate product and architecture decision.
- **Unknown:** Real direct-path rates, cross-platform terminal/menu behavior, mobile file saving, mixed-load responsiveness, and implementation resource bounds require measurement.

## Options and product direction

1. Retain terminal-only access and ask users to assemble independent file and networking tools.
2. Add native receiving and named TCP services to authorized Leash, and offer both standalone file/directory shares and a Leash file area, with explicit grants and complete create, authenticate, browse, transfer, leave, cancel, reconnect, and revoke journeys.
3. Pursue full Tailcat feature parity immediately, including SOCKS, exit-node access, arbitrary network targets, and system networking changes.

Use option 2 as the V4 product draft. Option 1 leaves material handoff and service access outside the requested workflow; option 3 exceeds the owner's selected scope. The precise first-release limits, proposed CLI flags, local menu key, and interaction details remain draft recommendations rather than separately approved implementation decisions.

The [V4 PRD](../evidence/TailMouse_PRD_v4.zh-CN.md) is the product source for complete journeys, capability boundaries, proposed defaults, requirements, and acceptance scenarios. V4 inherits the V3 Native requirements: reuse an earlier V3 implementation if available, or include it in V4 delivery if still absent. Do not build two native clients. V3 website planning remains independent.

File operations and TCP connections must share the corresponding admitted receiver's authentication and revocation boundary. Standalone shares have no PTY, task generation, or process control; their proposed four-receiver limit is a reviewable default, not a Leash concurrency change. Files intentionally selected for upload/download may be persisted at their authorized destinations; credentials and automatic terminal/session histories retain their existing restrictions. The existing Leash-only short-link service must not become file storage or an application traffic proxy; standalone file shares initially use full invitations and QR codes.

This records a product direction, not a final channel protocol, file-transfer implementation, service topology, or dependency selection. Those decisions belong in later accepted OpenSpec changes and must explain their alternatives and compatibility impact before implementation.

## Implementation and outcome review

This change creates the V4 PRD, records the direction, and adds a scoped entry to `context.md`. It does not authorize runtime implementation, new infrastructure, a Tailcat edit/gitlink update, or changes to active accepted specifications.

Document validation and any repository-gate result must be recorded separately from V4 product acceptance. Native Linux/Windows and real mobile/network evidence cannot be inferred from cross-builds, existing V2 tests, or the creation of this PRD.

- **Observed, 2026-09-07:** Scoped document validation passed for 16 requirement groups, 10 complete user journeys, 47 sequential acceptance scenarios, all 16 local links across the PRD and this decision, balanced code fences, formatting, and whitespace. Under pinned Node 26.8.1, both `pnpm gate:quick` and `pnpm gate` passed architecture and all 16 OpenSpec items plus the schema, then stopped at formatting errors in 12 files belonging to the ongoing short-invitation work. Neither gate reached runtime verification; those files were not changed by this documentation task. Tailcat remained clean with no gitlink delta. These results establish document consistency, not implementation or V4 product acceptance.
- **Observed, 2026-09-09:** The collaborator handoff review preserves draft status and clarifies that V4 does not revoke or expand V2's accepted lease-bounded plaintext invitation exception. All 16 local PRD/decision links resolve, the requirement/journey/acceptance identifiers remain complete, and document formatting, architecture checks, all 16 strict OpenSpec items and the schema pass. The README now links the draft and current task ledgers and documents cloning, the recorded submodule, frozen installation and browser prerequisites. Source inspection finds no required private credentials or previous contributor's ignored build output for local builds. This documentation review is not a new full runtime gate or V4 acceptance result.
- **Observed, 2026-09-09:** An independent local Git clone fetched the recorded Tailcat submodule and installed the frozen lockfile. Its first build stopped because a nested command found global pnpm 11.21.0 despite Corepack selecting 11.25.0 for the parent. The README now requires enabling the Corepack pnpm shim and selecting it on PATH. With that shim generated in an isolated temporary tools directory, the same checkout passes frozen installation and the Native, Tailcat Wasm, Web and edge dry-run builds; the Native version reports the expected source and Tailcat identities, and both Git worktrees remain clean. This uses the existing pinned macOS toolchain and package caches, not an unconfigured machine. No deployment, global package-manager change or Tailcat source modification was performed.
