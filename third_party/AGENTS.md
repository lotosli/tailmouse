# Third-party dependency instructions

`tailcat/` is an external Git submodule. Its source is owned by the upstream Tailcat repository, not by TailMouse.

- Never edit, format, generate into, patch, commit within, or otherwise modify `tailcat/` unless the user explicitly requests a Tailcat source change.
- Never advance or rewind the Tailcat gitlink unless the user explicitly requests a dependency update.
- Read-only inspection, builds, and tests are allowed. Write generated artifacts only under the TailMouse root `.artifacts/` directory.
- On an explicit update, require a clean submodule, inspect the upstream commit range, update the gitlink from the configured branch, and run `pnpm tailcat:check` followed by `pnpm gate`.
- Keep TailMouse adapters, patches, metadata, and instructions outside the submodule. Do not hide local source changes in the dependency checkout.
