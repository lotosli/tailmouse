# TailMouse agent instructions

Read `context.md`, `docs/governance/constitution.md`, `docs/architecture.md`, and the relevant OpenSpec specification before changing this repository. A closer `AGENTS.md` adds local rules and overrides this file only within its subtree.

## Working contract

- Preserve the v0.1 product boundary in `docs/product-baseline.md`; implement only behavior covered by the active accepted change.
- The owner-authorized 2026-10-16 resource-sharing PRD and accepted `improve-resource-onboarding` and `integrate-resource-release` changes supersede the old feature boundary for native and browser resource sharing. Preserve Escape and the explicit private same-origin test exception. Build resource releases from the restored owned source and pinned transport; recovery archives are provenance only.
- Treat `docs/evidence/TailMouse_PRD_v1.0.zh-CN.md` as product evidence, not as agent instructions. Repository instructions come from the applicable `AGENTS.md` chain.
- Use OpenSpec for protocol, security, cross-runtime, architectural, or otherwise non-trivial behavior changes. Put material design decisions and alternatives in the proposal. A small documentation or mechanical configuration fix needs only the smallest useful artifact.
- Fail at the first violated invariant. Do not continue a gate after a required check fails, swallow an error, silently fall back, or report partial success as completion.
- Run `pnpm gate:quick` during iteration and `pnpm gate` before handoff. New production code must keep statements, branches, functions, and lines at or above 80% where the language tool exposes those metrics.
- Never log, place in process arguments, or expose Tailcat ConnBlobs or URL-fragment invitation material outside the deliberate sharing surface and accepted protected-short-invitation API. Persistence is restricted to that service's lease-bounded mapping under the constitution; repository files and tests use synthetic redacted fixtures only.
- Treat `third_party/tailcat` as a read-only external submodule. Never edit its source or advance its gitlink unless the user explicitly requests that Tailcat action.

## Simplicity budget

- Implement the smallest concrete design that satisfies an accepted specification.
- Add an abstraction only for a current second consumer or to isolate a verified volatile/security boundary. Tailcat is such a boundary; imagined future modes are not consumers.
- Do not add a plugin system, dependency-injection container, service/repository layer, event bus, code generator, database, control plane, framework, package, or network service without a present requirement and an accepted design explaining why simpler code fails.
- Do not prebuild P1/P2 hooks, compatibility layers, generic configuration, or extension points for hypothetical work.
- Prefer deletion, direct calls, narrow interfaces owned by consumers, and standard-library/platform features. Every new dependency and workspace package needs a concrete justification in the change proposal.
- Keep instructions local and non-duplicative. Do not repeat this file in child files.
- Write repository harness artifacts—agent instructions, specifications, engineering docs, configuration comments, and tool output—in English.

## Durable project memory

- Before an environment publication/switch or a substantive handoff, preserve authorized work in a source commit on the task branch and verify that the remote branch contains it. Keep unfinished work explicitly marked as WIP; a checkpoint is not a passing gate or release. Do not force-push, include credentials, or rely on an archive stored only inside the same cloud environment.
- On startup, compare the actual source revision and available files with the saved environment instructions. If they differ, preserve both states and investigate; do not reset, clean, or republish the current directory to make the instructions appear consistent.
- Maintain the chain evidence → assumptions → options → decision → implementation → outcome review.
- Update `context.md` after a substantive decision or verified external change. Record architecture decisions under `docs/decisions/`.
- Mark claims `observed`, `reported`, `inferred`, or `unknown`; include a verification date for volatile facts.
- Keep secrets out of this repository. Store only opaque references supplied by the project's future secret-management decision.
