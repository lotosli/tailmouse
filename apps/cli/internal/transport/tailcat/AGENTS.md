# Native Tailcat adapter instructions

This is the only native subtree allowed to import `github.com/tailscale/tailcat`.

- Translate Tailcat v0.x values into the smallest TailMouse-owned transport contract. Never return or embed upstream types in core, protocol, CLI flags or public APIs.
- Resolve Tailcat through the recorded local submodule module. A gitlink update is a dedicated, explicitly requested change with upstream diff review, adapter tests, compatibility notes and full gate evidence.
- Treat ConnBlob as a bearer credential: keep it in memory for the minimum lifetime, redact all formatting/error paths, never use it as a map key or diagnostic field, and zero disposable byte buffers when practical.
- Keep retry, timeout and connectivity mechanics here only when they are Tailcat-specific. Product reconnect policy remains outside the adapter.
- Write contract tests around dial/listen/cancel/error translation and integration tests against a local hermetic harness. Never make the default test suite depend on public relays or real credentials.
- Do not build a generic transport plugin framework. A second real transport and accepted design are required before generalizing this boundary.
