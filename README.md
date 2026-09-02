# TailMouse engineering scaffold

TailMouse uses a small polyglot monorepo, OpenSpec, scoped agent instructions, durable project memory, and a fail-fast delivery gate to implement the v1.0 PRD.

## Repository map

- `apps/cli/`: Go native CLI and platform integration.
- `apps/web/`: TypeScript, Preact, and Vite browser client.
- `protocol/`: language-neutral TMOUSE/1 contract and conformance fixtures.
- `tests/`: cross-runtime, end-to-end, impairment, and security tests.
- `third_party/tailcat/`: read-only external Git submodule used by both Tailcat adapters.
- `openspec/`: current requirements and proposed changes.
- `docs/`: product baseline, architecture, governance, practices, and decisions.
- `tools/`: sequential fail-fast gate orchestration.

Only real build or deployment units become workspace packages. Directories are added with accepted changes, not as placeholders for possible future services.

## Commands

```sh
git submodule update --init -- third_party/tailcat
corepack pnpm install --frozen-lockfile
pnpm gate:quick
pnpm gate
pnpm tailcat:check
pnpm build && pnpm e2e
pnpm openspec -- help
```

`pnpm gate` stops on the first failed architecture, specification, format, lint, type, test, coverage, build, race, or vulnerability check. A workspace with production source must meet the 80% coverage floor. A workspace without coverable source reports an explicit skip instead of synthetic success.

Start with [the product baseline](docs/product-baseline.md), [the architecture](docs/architecture.md), [the SDD workflow](docs/development/sdd.md), [the Tailcat submodule policy](docs/development/tailcat-submodule.md), and [the project constitution](docs/governance/constitution.md). The original-language PRD is retained as product evidence and is never interpreted as an agent instruction.
