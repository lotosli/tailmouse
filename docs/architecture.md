# TailMouse code architecture

## Repository shape

```text
TailMouse/
├── apps/
│   ├── cli/                              # Go composition root and native runtime
│   │   └── internal/transport/tailcat/  # only native Tailcat import boundary
│   └── web/                              # Preact/Vite browser client
│       └── src/transport/tailcat/       # only browser Tailcat bridge boundary
├── protocol/                             # language-neutral TMOUSE/1 contract
├── tests/                                # cross-runtime and system tests
├── third_party/
│   └── tailcat/                          # external read-only Git submodule
├── openspec/                             # current specs and proposed changes
├── docs/                                 # context, governance, practices, decisions
├── tools/                                # fail-fast policy and gate scripts
├── go.mod                                # native Go module
├── go.work                               # local Go module composition
└── pnpm-workspace.yaml                   # JS workspace and orchestration
```

Directories appear with accepted changes; empty placeholder layers are not architecture.

## Dependency direction

```text
apps/cli composition
  -> native application/core contracts
  -> protocol concepts
  -> internal/transport/tailcat adapter -> local Tailcat submodule module
  -> internal/platform adapters -> operating-system APIs

apps/web composition
  -> UI/session state
  -> protocol concepts
  -> src/transport/tailcat adapter -> Tailcat Go/Wasm bridge
  -> browser capability adapters -> browser APIs

protocol specs and fixtures <- Go and TypeScript conformance tests
system tests                <- packaged native app and built static web app
```

Core logic does not import Tailcat, DOM, Node, PTY, or operating-system implementations. External capabilities enter through narrow interfaces owned by consumers. Create an interface for a real test/second implementation or a verified volatile boundary, not to reproduce textbook layers.

## Runtime boundaries

### Native Go application

`apps/cli` is the executable composition root. Protocol state, session policy, and flow control remain independent of Tailcat. PTY, clipboard, and controlled input are platform boundaries with cancellation, bounded buffers, and explicit error propagation. Unix PTY and Windows ConPTY differences stay in platform adapters.

### Tailcat adapters

Only `apps/cli/internal/transport/tailcat` imports the native Tailcat module. It translates upstream connection, credential, identity, and version details into a minimal TailMouse-owned transport contract and redacts sensitive values. Only `apps/web/src/transport/tailcat` calls the browser Go/Wasm bridge. Upstream types do not escape either adapter.

`third_party/tailcat` is an external Git submodule tracking `main` for explicit updates. The parent gitlink pins the exact revision used by each TailMouse commit without copying upstream source into TailMouse history. Agents and normal TailMouse changes treat the checkout as read-only. Source changes or gitlink updates require an explicit owner request; gates never update it automatically.

### Browser client

The web client is a static mobile-first PWA using Preact and the PRD's xterm Canvas path. Small capability adapters centralize permission, degradation, and testing. The client uses no remote scripts, fonts, analytics, or server runtime. It consumes an invitation fragment once, immediately removes it from the address bar, and never persists it.

### Protocol

`protocol/` owns TMOUSE/1 frames, state transitions, limits, capability negotiation, and golden fixtures. Implementation types are not protocol definitions. A breaking framing or state change increments the protocol version and updates Go, TypeScript, and cross-language conformance tests together.

## Monorepo mechanics

pnpm orchestrates JavaScript workspaces and cross-language commands; Go remains native. `go.work` composes the TailMouse module with the checked-out Tailcat module so adapter development uses the recorded local dependency. The root lockfile is the only JavaScript resolution record, local packages use `workspace:`, and cycles are rejected. Only an actual independently built unit becomes a package.

## Test topology

- Unit tests stay next to owned logic and cover success, boundaries, and failures.
- One golden fixture corpus drives Go and TypeScript protocol conformance.
- Integration tests use local, controlled, credential-free Tailcat/DERP infrastructure.
- Playwright verifies user-visible connection, degradation, and mobile behavior.
- Impairment and security tests cover reconnect, loss, reorder, latency, backpressure, oversized input, and credential leakage.

Coverage is measured only when TailMouse-owned production source exists. No source reports a skip, not 100%. Source below the constitution threshold fails the gate. Unmodified external submodule source is outside the TailMouse coverage denominator and instead runs Tailcat's build, test, vet, module-integrity, and WebAssembly checks.

## Change rule

A change that adds a cross-boundary dependency, runtime, workspace, or public protocol surface updates OpenSpec and this document first. A rename or formatting-only correction needs no additional planning artifact.
