# Decision 2026-005: V3 official website technology stack

- Status: owner-selected planning direction; implementation design pending
- Recorded: 2026-09-04
- Scope: V3 product website planning; no current runtime or dependency migration

## Evidence and assumptions

- **Reported, 2026-09-04:** The owner supplied the website stack recorded in [V3 PRD section 9.2](../evidence/TailMouse_PRD_v3.zh-CN.md#92-%E5%AE%98%E7%BD%91%E6%8A%80%E6%9C%AF%E6%A0%88), including explicit versions, optional Radix usage, no Redux/Zustand initially, and Manifest before Service Worker.
- **Reported, 2026-09-03:** The phase-two direction reserves `tailmouse.com` for the product site and `link.tailmouse.com` for browser terminal access; see [decision 2026-003](2026-003-phase2-browser-cli-direction.md).
- **Observed, 2026-09-04:** The current browser architecture uses Preact, Tailcat Go/Wasm and a static-asset service worker. The active browser specification requires a static self-contained terminal client.
- **Unknown:** Website page/API scope, dependency compatibility, exact patch versions, the OpenAPI generator and WebSocket cursor contract remain unverified or undefined.

## Options and decision

1. Record the supplied stack as the V3 website direction and resolve concrete implementation boundaries in a later OpenSpec.
2. Immediately migrate the existing terminal client or add backend services merely to exercise the selected libraries.

Use option 1. The request supplies a website stack, not a current terminal-client migration or new service contract. The PRD is the single source for the selection table.

Rust-produced OpenAPI will supply generated website API types. Native WebSocket with cursor catch-up applies to website data updates; neither selection replaces the Tailcat/TMOUSE terminal transport or rewrites the Go Host. A later accepted proposal must define actual API/event needs, generation and compatibility, cursor ordering/deduplication/expiry, bounded recovery, deployment boundaries and dependency justifications before implementation.

Manifest-first delivery applies to the planned website. Existing terminal-client caching requirements remain in force. Any later website service worker must define cache/update scope and exclude invitations, access codes, session responses and terminal data.

## Implementation and outcome review

This change records the owner selection in V3 PRD revision 0.2 and `context.md`. It installs no dependencies and changes no runtime, active OpenSpec requirement, Tailcat source or gitlink. Website delivery and compatibility are not claimed as verified.

- **Observed, 2026-09-04:** Documentation checks passed for all 14 supplied selections, local links, and preservation of the 12 Native requirement groups and 30 acceptance scenarios. Harness-document formatting and `git diff --check` passed. Both `pnpm gate:quick` and `pnpm gate` stopped before pipeline execution with `ERR_PNPM_UNSUPPORTED_ENGINE`: the active Node version is 26.7.0, while the repository requires 26.8.1. No successful runtime or full-gate result is claimed.
