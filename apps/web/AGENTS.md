# Web client instructions

These rules apply below `apps/web/` in addition to the repository instructions.

- Use strict TypeScript and Preact function components. Keep session/protocol state independent from DOM rendering and Tailcat bridge values.
- Only `src/transport/tailcat/` may call or type against the Go/Wasm Tailcat bridge. Convert at the boundary to TailMouse-owned types.
- Prefer browser APIs, small local modules and direct imports. Do not add a router, state framework, component library, CSS framework, barrel hierarchy or generic hook layer without a present accepted requirement.
- Treat the host/session state machine as authority. UI components emit intent and render observable state; they do not invent protocol transitions.
- Read the invitation fragment once, validate bounds/version, replace the visible URL immediately, and keep it out of storage, logs, analytics, errors, DOM attributes and snapshots.
- The resource PRD permits bounded, expiry-checked per-tab `sessionStorage` recovery on the trusted resource frontend. Preserve its erasure and origin checks; this exception does not apply to legacy invitations, `localStorage`, preview frames, logs or reports.
- Bundle all scripts, styles, fonts and assets locally. No analytics, remote CDN assets, third-party test targets or network access in unit tests.
- Test user-visible behavior with semantic queries and accessible names. Unit tests cover state/edge cases; Playwright uses isolated contexts, web-first assertions, no automatic reruns, and retained failure traces containing only synthetic fixtures.
- Maintain at least 80% for statements, branches, functions and lines; do not exclude core state, protocol or credential code.
