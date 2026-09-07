# Decision 2026-004: V3 native receiving client

- Status: native support requested by the owner; scoped product draft, implementation design pending
- Verified: 2026-09-03
- Scope: future V3 product evidence; no amendment to the v0.1 baseline, phase-two requirements, active OpenSpec change or production architecture

## Evidence

- **Reported, 2026-09-03:** After discussing Tailcat native-to-native connectivity, the owner requested a V3 PRD adding native support.
- **Observed, 2026-09-03:** TailMouse currently exposes native Host commands and a browser receiving client. Its native help has no receiving command, and its Host accepts TMOUSE on virtual TCP port 44321.
- **Observed, 2026-09-03:** The pinned Tailcat source provides `Client.DialTCPPort` and path-discovery APIs. The [upstream connection flow](https://github.com/tailscale/tailcat#connection-flow) bootstraps over DERP, attempts native UDP traversal and retains relay fallback. Its [browser documentation](https://github.com/tailscale/tailcat#tailcat) still describes DERP-only browser traffic pending WebRTC.
- **Reported:** The phase-two product direction includes a browser entry point, independent temporary access codes with an explicit Host-only password opt-out, one active remote, reusable invitations and bounded result retention.
- **Observed, 2026-09-03:** [XTerm control sequences](https://invisible-island.net/xterm/ctlseqs/ctlseqs.html) include OSC 52 selection queries and writes. Forwarding output into a native terminal introduces local effects that differ from the existing browser display boundary.

## Assumptions

- **Inferred:** A desktop Go CLI receiving role in the existing executable is the smallest useful interpretation of native support for the discussed Leash workflow. Desktop GUI and native mobile applications are not included in this draft.
- **Inferred:** V3 follows delivery of the current and phase-two scopes, inheriting the final accepted phase-two authentication protocol rather than implementing a parallel authentication scheme now.
- **Unknown:** Native connection latency, real direct-path success rates, terminal compatibility and resource usage require implementation and measurement.

## Options

1. Keep browser-only access and wait for upstream WebRTC. This preserves the installation-free flow but does not deliver the requested native client.
2. Add a desktop native Leash client to the existing executable. It reuses native Tailcat transport and the application protocol, while requiring client-side terminal, authentication and lifecycle work.
3. Add a native GUI/mobile app or a local browser gateway. These add packaging, UI or service boundaries without a current requirement for this V3 slice.
4. Replace browser Go/Wasm with Rust or introduce cgo optimization. Neither supplies a native receiving workflow by itself, and no measured hotspot justifies either change here.

## Product planning decision

Use option 2 as the concrete V3 draft in [the V3 PRD](../evidence/TailMouse_PRD_v3.zh-CN.md). Preserve Browser access as a peer receiving option.

- Propose `tailmouse connect` as an interactive desktop Leash client within the existing Go executable and six-target native release matrix. It is not an available command yet.
- Accept invitations and access codes through hidden interactive input, never process arguments, environment variables, files or an automatic recent-session store. Do not fetch the invitation's web URL.
- Apply the same Host authentication, capabilities, process generation and one-active-remote rule to Browser and Native. Switching clients requires the previous remote to leave or be cleaned up.
- Use Tailcat's existing encrypted native direct/relay behavior. Actual path status requires evidence, can be unknown, and cannot imply that DERP bootstrap dependencies have disappeared.
- Preserve bounded history, result retention and explicit process policies from phase two. Connection loss never authorizes input replay or automatic process creation.
- Treat terminal cleanup, local escape/control UI, clipboard-related control sequences and input leakage into the local shell as explicit native-client acceptance boundaries.
- Retain browser transport and Escape behavior. Native Escape, native mobile apps, a local gateway, new services, a transport rewrite and cgo are outside this draft.

The detailed command exit contract, escape/control UI, terminal extension policy, path-observation freshness and version negotiation remain design work for a later accepted OpenSpec proposal. The new client must not be implemented merely because this product draft exists.

## Implementation and validation status

This decision adds product documentation and project memory only. No Native Client, new protocol message, runtime, dependency, deployment or Tailcat modification is introduced.

The PRD defines acceptance for real direct and relayed connections, Browser/Native handoff, authentication, terminal side effects, bounded resources and the full desktop platform matrix. Current macOS-first verification preferences do not establish Linux or Windows acceptance.

- **Observed, 2026-09-03:** Documentation checks verified local links, 12 unique requirement IDs, 30 sequential acceptance IDs, explicit draft boundaries and formatting. Both `pnpm gate:quick` and `pnpm gate` stopped before running their pipelines because the active Node version is 26.7.0 while the repository requires 26.8.1. No runtime tests or successful full-gate result are claimed for this documentation change.

## Outcome review

The owner-requested native direction now has a scoped V3 draft. Runtime behavior, cross-platform evidence and performance remain unverified until a later implementation change passes its acceptance checks.
