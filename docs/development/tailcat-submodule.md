# Tailcat submodule policy

Tailcat is an external dependency at `third_party/tailcat`. The parent repository stores only a gitlink; Tailcat source objects remain in the upstream repository. The committed gitlink makes every TailMouse revision reproducible, while `.gitmodules` names `main` as the source branch for explicit updates.

## Initialize

After cloning TailMouse, initialize the recorded dependency revision:

```sh
git submodule update --init -- third_party/tailcat
```

Normal builds and gates use that recorded revision. They never fetch or advance Tailcat automatically.

## Update

Only update Tailcat when the owner explicitly requests it. Start from clean parent and submodule worktrees, inspect the incoming commit range, then update from the configured branch:

```sh
git submodule update --remote --checkout -- third_party/tailcat
git diff --submodule=log -- third_party/tailcat
pnpm tailcat:check
pnpm gate
git add -- third_party/tailcat
```

The parent commit records the resulting exact gitlink. A newer upstream tag is not required; the requested update follows `main`. Never edit files within the submodule as part of an ordinary TailMouse change. An explicitly requested Tailcat source change belongs to its own upstream or fork commit before TailMouse advances its gitlink.
