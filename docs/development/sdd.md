# TailMouse spec-driven development harness

OpenSpec records what the system promises now and what a proposed change would alter. It protects high-risk boundaries without turning routine edits into document production.

## When a change is required

Create an OpenSpec change before work that:

- changes a TMOUSE/1 frame, state, capability, limit, or compatibility rule;
- touches ConnBlobs, invitations, authorization, logging/storage, or controlled input;
- changes user-visible behavior or crosses Go and browser boundaries;
- adds a public interface, runtime, workspace, direct dependency, or architecture abstraction.

Spelling, links, formatting, behavior-neutral mechanical configuration, and direct tightening of an existing rule use the smallest relevant edit and gate. Use explore to resolve uncertainty; do not create artifacts automatically.

## Minimal lifecycle

1. `$openspec-explore`: inspect evidence, unknowns, risks, and the simplest viable design.
2. `$openspec-propose <change>`: create a proposal, delta specs, and tasks. Put necessary design decisions and alternatives in the proposal.
3. Review scope, non-goals, security impact, simpler alternatives, and dependency/abstraction cost.
4. `$openspec-apply-change <change>`: implement only accepted tasks and stop at the first failure.
5. Use `pnpm gate:quick` during work and `pnpm gate` before completion.
6. `$openspec-sync-specs <change>`: merge verified deltas into current specs.
7. `$openspec-archive-change <change>`: archive and update project memory or decisions when facts changed.

An unreviewed proposal is not implementation authority. New scope returns to the proposal.

## Artifact contract

The required path is `proposal -> specs -> tasks`:

- `proposal.md`: problem, outcomes, non-goals, evidence, risks, a simplicity budget, and material design decisions when needed.
- `specs/**/spec.md`: observable SHALL/MUST requirements with testable scenarios.
- `tasks.md`: small dependency-ordered work items; each names its test or inspection evidence.

## Requirement quality

Requirements are observable and singular. Avoid untestable adjectives such as robust, elegant, or extensible. Give failure, cancellation, oversized input, concurrency, and degradation the same precision as success. Current specs describe behavior; decisions explain why.

## Fail-fast checkpoints

- Missing outcome, non-goal, or current necessity: do not write specs.
- Missing failure scenario or bound: do not write tasks.
- Missing evidence in tasks: do not implement.
- Unaccepted dependency or abstraction: stop and revise the proposal.
- Failed gate: do not sync, archive, or release.
