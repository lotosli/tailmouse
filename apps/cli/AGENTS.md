# Go CLI instructions

These rules apply below `apps/cli/` in addition to the repository instructions.

- Keep this subtree one deployable Go application with one composition root. Do not turn internal domains into modules or workspace packages.
- Put product policy in testable core code and platform/Tailcat details behind narrow interfaces owned by their consumers. Add an interface only for a real second implementation/test boundary or a verified volatile boundary.
- Every blocking or long-lived operation accepts `context.Context`, propagates cancellation, bounds queues/buffers, and returns the root error. No process-wide mutable state or hidden background goroutines.
- Wrap errors only with useful operation context and preserve inspectable causes. Validate protocol version, lengths and state before allocation or side effects; fail closed on malformed/security-sensitive input.
- Keep ConnBlobs and invitation fragments out of logs, errors, metrics, command arguments, fixtures and snapshots. Use explicit redacted value types at diagnostic boundaries.
- Prefer the standard library. A dependency needs an accepted OpenSpec justification, pinned version and tests at its boundary.
- Tests use table cases for state and parsing, deterministic clocks/randomness, cancellation/leak checks, race coverage for concurrency, and fuzz targets for untrusted decoders. Production statements remain at least 80% covered.
- Run `pnpm gate:quick` while iterating and the repository `pnpm gate` before handoff.
