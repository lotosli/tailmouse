# Link edge instructions

These rules apply below `apps/link-edge/` in addition to the repository instructions.

- Keep this workspace limited to the official static edge and the four accepted protected-short-invitation operations. Do not add accounts, session discovery, terminal relaying, a general API framework, or V3 hooks.
- Runtime infrastructure uses Cloudflare platform APIs directly; invitation parsing reuses the accepted `cborg` codec. Do not add another runtime dependency, ORM, router, queue, repository/service layer, or alternate storage backend without a new accepted design.
- Treat every invitation and management capability as sensitive. Never log, trace, cache, persist in fixtures, include in thrown text, or expose either value beyond its accepted response. The separate access code must never enter this workspace.
- Persist only the bounded plaintext invitation, lease metadata, locator, and a one-way management-capability verifier. Delete all mapping state on authenticated deletion or alarm expiry.
- Parse methods, paths, content types, bodies, versions, modes, and sizes strictly. Use stable generic failures and fail at the first invalid boundary.
- Tests use synthetic recognizable credentials, deterministic clocks/randomness, and local bindings only. Never use a Cloudflare account credential in a test.
- Maintain at least 80% coverage for statements, branches, functions, and lines without excluding credential or lifecycle code.
