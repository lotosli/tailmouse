# Resource onboarding and source recovery

Status: accepted by the owner's 2026-10-17 instruction to implement the product and operations review.

Recovery update, observed 2026-10-19: supported task history yielded original native and Go/Wasm source records. The bridge now rebuilds byte-identically to the deployed Wasm. A separately preserved native candidate builds and passes the focused resource browser journey plus native race tests with the container's required descendant reaper. This supersedes the earlier missing-source observation below; normal source/release integration and complete resource test recovery remain pending. See `docs/evidence/native-source-recovery-2026-10-19/README.md` for archive hashes and evidence limits. The normal source release guard remains in place.

## Evidence and scope

The 2026-10-17 review observed a four-command public frontend without installation, tutorial or support actions. The owner authorizes improving this path, preserving Escape, four representative network profiles, and the existing same-origin private test deployment.

The current checkout is 13440a5 and does not contain the previously deployed resource-sharing implementation. The public manifest, source maps and immutable transport artifacts are recoverable and hash-verifiable. Native resource source, its tests and its release binaries have not been recovered. This is a release blocker, not evidence that an older CLI supports the new site. Preserve that distinction in all build and download claims.

## Decisions

- Recover owned browser sources from the exact published source maps and preserve their provenance. Keep the existing deployed transport binaries immutable. Provide an explicit recovery build, separate from the normal source release gate, while native sources are missing. Do not relabel this as a reproducible full release or publish old native binaries as matching downloads.
- Add an actionable homepage, a low-dependency Receive walkthrough, a Dev collaboration story, explicit permission examples, port semantics, lifecycle guidance, compatibility evidence, and GitHub/support links. Show honest download availability rather than a broken or fictional installer.
- Improve missing-invitation, connection, approval, capacity, readonly, preview and expiry guidance using observable events. Visitor departure does not end the host's session. Do not infer protocol success from timers or presentation state.
- Call the visitor upload action “Send files to host”; distinguish transfer, verification and confirmed receipt. Show the actual saved name and explicit copy/insert actions without executing terminal input. Do not present a locally estimated session quota as an authoritative remaining budget.
- Feedback is manually copied, locally generated and allowlisted. It must never contain URLs, invitations, private addresses, resource/project/file names, terminal contents or arbitrary error text. No telemetry, external message, new service, dependency or workspace.
- Website metadata stays generic. Only known public section anchors bypass invitation parsing. Existing game/protected-invitation behavior is retained.

## Alternatives

Reconstructing the native protocol implementation from a frontend is not source recovery and would require separate implementation and acceptance evidence. Advertising a CLI built from the available old tree would mislead users. Waiting for that missing source before doing independent browser work would leave authorized improvements undone. The recovery build makes the useful work reviewable without weakening the full release gate.

## Verification

Verify source-map and immutable artifact hashes; strict typecheck; meaningful browser and unit tests for changed behavior; desktop/mobile navigation, copy actions, upload receipts and error recovery; metadata and feedback privacy. Run the repository's required gates and report the first blocker without treating partial checks as a full pass. Do not publish a native Alpha without matching source and native integration evidence.
