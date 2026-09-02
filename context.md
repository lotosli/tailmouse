# TailMouse project memory

## Objective

Build and evolve TailMouse from PRD v1.0 through a small polyglot monorepo, risk-proportional OpenSpec workflow, explicit architecture boundaries, scoped agent instructions, and a fail-fast delivery gate.

## Evidence

- **Observed, 2026-09-02:** The owner requested this engineering foundation, current language practices, at least 80% test coverage, fail-fast behavior, and explicit protection against over-engineering.
- **Reported, PRD v1.0 dated 2026-02-22:** TailMouse combines an RTT-shaped cat-and-mouse game (`escape`) with controlled browser access to one launched terminal process (`leash`). See `docs/product-baseline.md`.
- **Observed online, 2026-09-02:** Tailcat `main` is ahead of its latest tagged release, remains a v0 API, and currently declares Go 1.27.0.

## Accepted decisions

- pnpm orchestrates the polyglot repository while Go retains native module and toolchain semantics.
- Product boundaries are `apps/cli`, `apps/web`, `protocol`, and `tests`; no package exists without a current build or deployment purpose.
- Tailcat is isolated because it is a verified unstable and security-sensitive boundary. Its source remains in an external read-only submodule; the parent gitlink records each selected `main` revision.
- OpenSpec is required for behavior, protocol, security, cross-runtime, dependency, and architecture changes. Mechanical edits use the smallest useful artifact.
- TypeScript enforces 80% for statements, branches, functions, and lines. Go enforces 80% statement coverage.
- The delivery gate runs sequentially and exits on the first failure without automatic mutation or silent fallback.

Rationale is recorded in `docs/decisions/2026-001-engineering-foundation.md`.

## Assumptions

- **Inferred, medium confidence:** v0.1 retains the PRD's Go/Tailcat and TypeScript/Preact/Vite direction.

## Unknowns and risks

- **Unknown:** The PRD mentions both BSD-3-Clause and Apache-2.0; the owner must choose one before release.
- **Unknown:** The production domain, static hosting provider, signing, and distribution channels are undecided.
- **Unknown:** Tailcat v0.x changes may require adapter work but must not leak upstream types into core or protocol code.
- **Risk:** Invitation material is a bearer credential. Browser history, logs, clipboard, telemetry, errors, and snapshots are leak surfaces.

## Next decisions

1. Review the constitution, current OpenSpec requirements, and decision 2026-001.
2. Select the license and remote repository.
3. Plan and implement the M0 spike as an OpenSpec change.
4. Protect the main branch with the complete `pnpm gate` matrix.

## Outcome review

The foundation is proven by repeatable `pnpm gate`, strict OpenSpec validation, Go module integrity checks that run before product source exists, and Playwright execution once the browser application exists. Add runtime evidence after M0.
