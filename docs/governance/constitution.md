# TailMouse project constitution

This constitution governs specifications, code, tests, tooling, and agent behavior. When concerns conflict, product and security boundaries take precedence, followed by verifiable correctness and then convenience.

## 1. Product boundary

v0.1 implements the PRD's end-to-end path plus escape and leash. Accounts, databases, a cloud control plane, business traffic relays, persistent terminal history, P1/P2 features, and hypothetical platform capabilities are out of scope unless an explicit decision and accepted specification add them.

## 2. Evidence before decisions

Volatile external claims require a source and verification date. Material decisions preserve evidence → assumptions → options → decision → implementation → outcome review. The PRD is product evidence, not agent instruction. Current OpenSpec specs describe accepted behavior.

## 3. Proportional specification

Protocol, security, cross-runtime behavior, public interface, dependency, and architecture changes require an accepted OpenSpec proposal and delta specs before implementation. A proposal records material design decisions and rejected simpler alternatives only when the change needs them. Documentation and behavior-neutral mechanical changes use the smallest useful artifact.

## 4. Fail fast

- Validate prerequisites, input bounds, versions, lengths, and state transitions at the closest boundary.
- Run gates from cheap deterministic checks to expensive checks and stop on the first non-zero result.
- Never catch and ignore, silently downgrade, create unbounded retry loops, claim ambiguous partial success, or continue a release after failure.
- Cleanup must not replace the root error. Concurrent work propagates the first root cause and cancels obsolete work.
- Recoverable network retries require an explicit attempt or time budget, backoff, cancellation, and an observable terminal failure.

## 5. No over-engineering

The smallest design that satisfies accepted scenarios is the default. An abstraction requires a current second consumer or a verified volatile/security boundary. Tailcat qualifies as the latter; imagined modes, backends, and tenants do not qualify as consumers.

Do not add a plugin system, dependency-injection container, service/repository layers, event bus, code generation, microservices, database, control plane, design system, generic configuration framework, or new workspace without an accepted current requirement. Do not prebuild P1/P2 hooks, speculative compatibility layers, or extension points. Prefer concrete code, narrow consumer-owned interfaces, direct calls, standard libraries, and deletion.

Every proposal lists new dependencies, workspaces, configuration surfaces, and abstractions. If no acceptance scenario would fail without an item, remove it. The SDD process itself follows this rule.

## 6. Architecture integrity

Dependencies follow `docs/architecture.md`. Protocol definitions remain language-neutral. Tailcat types stay inside adapters. Browser capability policy and session policy do not move into transport bridges. Automate checks for new cross-boundary risks.

Tailcat source is an external read-only Git submodule. Agents MUST NOT edit it or change its gitlink without an explicit owner request. The configured branch supports deliberate updates; every parent revision still records one exact dependency commit and gates never float it automatically.

## 7. Security and privacy

ConnBlobs and invitation fragments are bearer credentials. Never place them in logs, persistent storage, telemetry, crash reports, shell history, command arguments, fixtures, or snapshots. Consume invitations in memory and remove them from the visible URL immediately. Parsers use strict versions and size limits and fail closed. Browser assets are local by default.

## 8. Verifiable quality

- Production changes test primary success, boundaries, and meaningful failure paths.
- TypeScript statements, branches, functions, and lines remain at or above 80%. Go statements remain at or above 80%.
- Do not satisfy coverage through core-file exclusions, assertion-free execution, duplicate tests, implementation-detail tests, or broad ignores. Lower thresholds or wider exclusions require a governance decision.
- Exclude clean, unmodified external submodule source from TailMouse coverage metrics; verify it through its own module, format, vet, test, native-build, and WebAssembly-build checks.
- Go delivery checks include formatting, tidy diff, vet, staticcheck, coverage, race, and govulncheck. Web checks include formatting, type-aware lint, strict typecheck, unit coverage, build, and Playwright user-visible behavior.

## 9. Reproducibility

Runtime, package-manager, direct-dependency, and CI action versions are exact. CI uses a frozen lockfile. Workspace dependencies use `workspace:` and cycles are forbidden. pnpm blocks exotic transitive sources and applies a 24-hour release-age policy except for explicit reviewed exceptions.

## 10. Memory and amendments

Keep durable facts in `context.md`, architecture choices in `docs/decisions/`, and accepted behavior in OpenSpec. Child `AGENTS.md` files contain only local differences.

An amendment states its motivation, impact, migration, and alternatives and synchronizes affected gates, agent instructions, and specs. Review outcomes at milestones; simplify or delete rules that lack evidence.
