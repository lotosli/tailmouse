# 2026-001: Establish a minimal polyglot engineering foundation

## Decision

Define the repository boundary, specification workflow, quality gate, and agent instructions for TailMouse v0.1. License, hosting, and later product features remain separate decisions.

## Outcomes

- Go, Web, protocol, and test ownership is explicit and mechanically checked.
- Material changes are specified before implementation; simple changes avoid ceremony.
- Failures stop early and production coverage remains at least 80%.
- Tailcat's unstable API and credential boundary are isolated.
- Tailcat source remains external in a read-only submodule whose exact gitlink can be deliberately advanced from `main`.
- Agent instructions are sufficient, local, and biased against speculative design.

## Evidence

- **Reported:** PRD v1.0 specifies Go, Tailcat, TypeScript/Preact/Vite, TMOUSE/1, two modes, and multi-platform verification.
- **Observed online, 2026-09-02:** Tailcat `main` remains a v0 API, is ahead of its latest tag, and currently requires Go 1.27.0.
- **Observed online, 2026-09-02:** OpenSpec supports Codex skills, custom schemas, current specs, and a change lifecycle.
- **Reported:** The owner requires 80% coverage, fail-fast behavior, scoped AGENTS.md files, current engineering practice, and protection against over-engineering.

## Assumptions

- **Inferred:** One repository must coordinate two build systems without turning Go into a Node package.
- **Inferred:** Protocol, security, and cross-runtime changes justify SDD; spelling and mechanical configuration do not.
- **Inferred:** Directories represent real build or deployment units, not hypothetical services.

## Options

### A. Keep the PRD's flat layout without a shared harness

Lowest setup cost, but Go/Web ownership, cross-language gates, and local agent rules remain unclear.

### B. Minimal polyglot monorepo — selected

Use only `apps/cli`, `apps/web`, `protocol`, `tests`, and engineering support. pnpm orchestrates; Go stays native; OpenSpec is risk-triggered. This is reversible and creates no imaginary service.

### C. Platform-style monorepo

Precreate shared SDKs, services, a control plane, plugins, publishing infrastructure, and generation. No v0.1 scenario requires them, so they are maintenance debt.

## Consequences

Select B. Use only the OpenSpec path proposal → specs → tasks; put necessary design decisions in the proposal instead of requiring another artifact. Run a sequential pnpm gate across Web and Go and enforce 80% coverage on TailMouse-owned code. Tailcat is the one justified early adapter because its upstream API is explicitly unstable and carries the credential/transport boundary. Keep it as a read-only external submodule: `main` is the explicit update source and each parent commit records an exact reproducible gitlink without copying upstream source into TailMouse history.

Product directories evolve with accepted changes rather than placeholder layers. Dependency upgrades are exact, explicit, and gated. Review this decision at the M0 proposal and simplify any rule that does not protect a demonstrated risk.
