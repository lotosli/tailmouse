# TailMouse fail-fast quality gates

## Commands

- `pnpm gate:quick`: architecture, OpenSpec, format, lint, typecheck, Go static checks, unit tests, Web/Go coverage, build, and browser end-to-end tests.
- `pnpm gate`: the delivery gate; adds Go race and govulncheck after the quick sequence.
- `pnpm coverage`: reruns workspace and Go coverage only.
- `pnpm fuzz:smoke`: runs bounded Go fuzz smoke tests.
- `pnpm tailcat:check`: verifies the clean Tailcat submodule and runs its module, format, vet, test, native-build, and WebAssembly-build checks.

## Ordered pipeline

1. Architecture and version invariants.
2. Strict OpenSpec and schema validation.
3. Formatting.
4. Type-aware lint.
5. Strict typecheck.
6. Go module verification, tidy diff, formatting, vet, and staticcheck.
7. Tailcat module integrity, formatting, and vet without modifying upstream source.
8. Unit tests, including Tailcat's upstream Go suite.
9. Web and TailMouse-owned Go coverage.
10. Product builds plus Tailcat native and WebAssembly builds.
11. Playwright user-visible browser tests against the built application.
12. TailMouse-owned Go race and vulnerability checks in the delivery gate.

The orchestrator runs synchronously and propagates the first non-zero status. It does not auto-format, update the lockfile, edit specs, or continue into noisy secondary failures.

## Coverage policy

- TypeScript/TSX: global statements, branches, functions, and lines are each at least 80%.
- Go: module-wide statements are at least 80% using an atomic profile.
- Protocol parsers, security checks, state transitions, and credential paths require the stronger evidence named by their change tasks; 80% is not a target ceiling.
- A wider ignore, coverage exclusion, generated classification, or lower threshold requires a reviewed governance decision.
- Tests assert behavior. Execution without meaningful assertions does not satisfy the policy.
- Clean external Tailcat source is not TailMouse-owned production code and is excluded from TailMouse's coverage denominator. It must remain unmodified and pass the upstream-oriented checks above.

A workspace with no coverable production source explicitly reports a skip. The first production source activates the hard coverage gate. Go module verification and tidy checks run even before the first Go source file exists.

## CI policy

The workflow uses exact Node, pnpm, Go, and action revisions on Linux, macOS, and Windows. Checkout initializes the recorded Tailcat gitlink; no CI step follows the remote branch. It installs from the frozen lockfile, installs the matching Playwright browsers, and runs the delivery gate. Matrix failure cancels remaining matrix work, and fuzzing runs only after the main matrix succeeds. Each fuzz target runs separately because Go fuzz mode accepts one package and one matching target per invocation. Branch protection requires the complete matrix.

## Failure handling

Keep the earliest failing command and exit status. Cleanup errors are additional evidence, not a replacement root cause. Do not hide flaky tests behind unbounded retries; isolate the cause and time-bound any reviewed temporary retry. Security failures fail closed.
