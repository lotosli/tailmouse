# TailMouse engineering practices baseline

This baseline turns authoritative material verified on 2026-09-02 into repository rules. Exact tool versions live only in configuration and lockfiles.

## Simplicity and agent behavior

Agile principles make working software the primary progress measure and describe simplicity as maximizing work not done. TailMouse therefore favors the smallest design, short feedback, and deletion over architectural volume. [Agile Manifesto principles](https://agilemanifesto.org/principles)

OpenAI's model guidance reports directional gains from leaner prompts: state instructions once, keep tools relevant, and define autonomy and success boundaries. Root AGENTS.md holds shared policy; nested files contain only local differences. This reduces conflicting context and Codex-driven process expansion. [OpenAI latest model guide](https://developers.openai.com/api/docs/guides/latest-model)

Codex combines AGENTS.md files from repository root to the working directory, with closer files taking precedence and a default combined size limit. The independent AGENTS.md specification uses the same nearest-file model. Keep the chain small and non-duplicative. [OpenAI AGENTS.md guide](https://developers.openai.com/codex/agent-configuration/agents-md) [AGENTS.md specification](https://agents.md/)

Public Codex issue reports describe scope creep, speculative fixes before evidence, invented process, and completion claims that do not match repository rules. These are user reports rather than established product guarantees, but they justify mechanical guardrails: accepted scope, evidence before diagnosis, explicit completion criteria, a first-failure gate, and a simplicity budget. [Evidence-before-fix report](https://github.com/openai/codex/issues/14197) [Scope-creep report](https://github.com/openai/codex/issues/8644) [Excessive-process report](https://github.com/openai/codex/issues/34705)

Repository rule: an abstraction needs a current second consumer or verified boundary; each proposal enumerates added dependencies, packages, configuration, and abstractions; unverifiable future extension points are removed.

## Go

- Use the module-declared toolchain and upgrade it explicitly.
- Require gofmt, tidy diff, vet, staticcheck, race, coverage, and govulncheck.
- Use table tests and fuzzing for parsers and state machines with synthetic corpora.
- Define narrow interfaces at consumers, preserve error causes, pass context to blocking work, and bound queues and goroutines.
- Interpret govulncheck by reachable call paths rather than equating a dependency name with exploitability.

These follow Go's official security, fuzzing, race, and integration-coverage guidance. [Go security best practices](https://go.dev/doc/security/best-practices) [Go fuzzing](https://go.dev/doc/security/fuzz/) [Go integration coverage](https://go.dev/doc/build-cover)

## TypeScript, Preact, Vite, and browser

- Use strict TypeScript and let pnpm express workspace build order. Add TypeScript project references only when a real second TypeScript package needs them.
- Use type-aware Oxlint, whose stable engine tracks the configured TypeScript generation, without an incompatible typescript-eslint peer range. [Oxlint type-aware linting](https://oxc.rs/docs/guide/usage/linter/type-aware) [Oxlint type-aware stable](https://oxc.rs/blog/2026-07-22-type-aware-linting-stable)
- Prefer Preact function components and browser capabilities. Add no general component or state framework until measured repetition requires it.
- Test user-visible behavior with isolated contexts, semantic locators, web-first assertions, and traces; do not test third-party sites. [Playwright best practices](https://playwright.dev/docs/best-practices)
- Enforce positive 80% statements, branches, functions, and lines thresholds through Vitest/V8. [Vitest coverage configuration](https://vitest.dev/config/coverage)
- Load no remote scripts, styles, fonts, or analytics. Keep invitation material out of storage, telemetry, snapshots, and logs.

## Monorepo and supply chain

The root `pnpm-workspace.yaml` defines workspaces, local dependencies use `workspace:`, one lockfile records resolution, and cycles fail. CI uses the frozen lockfile. [pnpm workspaces](https://pnpm.io/workspaces) [pnpm CI](https://pnpm.io/continuous-integration)

Tailcat is a Git submodule because its source belongs upstream while TailMouse needs an inspectable local module. The parent gitlink supplies reproducibility; the configured `main` branch supplies an explicit update target. Gates initialize and validate the recorded commit but never float it. Ordinary work cannot modify the submodule, and third-party source does not distort TailMouse-owned coverage. [Git submodules](https://git-scm.com/book/en/v2/Git-Tools-Submodules) [Tailcat repository](https://github.com/tailscale/tailcat)

Direct versions are exact. pnpm blocks exotic transitive sources and enforces a 24-hour release-age delay except for explicit narrow exceptions. Lifecycle scripts require explicit approval. The lockfile is reviewable input, not proof of safety. [pnpm supply-chain security](https://pnpm.io/supply-chain-security)

## Security, releases, and decisions

NIST SSDF is outcome- and risk-based, not a mandate to install every control. TailMouse maps current risks to preparation, protection, secure production, and response, and adds only controls that lower a present risk. [NIST SSDF](https://csrc.nist.gov/projects/ssdf)

Public protocol and CLI behavior declare versions. SemVer `0.y.z` communicates instability but does not remove the need to record breaking changes. [Semantic Versioning 2.0.0](https://semver.org/)

Commit messages use Conventional Commits `feat`, `fix`, and `BREAKING CHANGE` semantics for readable history; commits do not replace specifications or release review. [Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/)

## Review questions

Does the change satisfy accepted scenarios? Are failure, cancellation, concurrency, and limits explicit? Does security fail closed? Is every dependency and abstraction necessary now? Can tests fail on a real regression? Does documentation link instead of repeat? What can be deleted while preserving the requirement?
