# Make hosted resource sharing work without a configuration file

Status: accepted by the owner's 2026-10-20 request to use defaults without a configuration file and lower the entry barrier.

## Evidence and outcome

The current resource parser defaults to the legacy `link.tailmouse.com` frontend and no content origin. The README and website require a separate configuration download before ordinary sharing. The supported hosted resource deployment is already `https://tailmouse.com` with the owner's trusted-app same-origin exception.

After this change, `tailmouse web 8080`, `tailmouse cli -- PROGRAM`, `tailmouse receive DIRECTORY` and valid combined `dev` commands use that existing deployment without downloading or creating a local configuration file. Existing session limits and command prerequisites stay the same. Homepage, help, README and the next downloadable release explain these commands.

## Decision and alternatives

Use an embedded hosted frontend default. When neither frontend nor content origin is explicitly configured, supply the hosted content origin and same-origin test mode; an explicitly configured test-mode value still wins. Any custom origin disables this implicit hosted pairing. Custom Web deployments continue to require a content origin and either distinct registrable domains or explicit test mode. Preserve CLI > environment > file > default precedence, strict configuration validation and explicit missing-file errors.

Reject fetching a configuration file automatically: it introduces an unnecessary network prerequisite and mutable startup behavior. Merely abbreviating the documentation cannot make the currently published executable accept the short commands. Do not infer unsafe same-origin permission for custom deployments, change protocol or session authority, add installers or dependencies, or alter legacy Escape/Leash defaults. The existing trusted-app notice remains applicable.

No dependency, workspace, service, configuration flag or abstraction is added. Publish a new immutable version rather than replacing the prior release's binaries. Keep the owner's Latest and `[skip ci]` preferences.

## Validation

Verify all four commands without a file, limits-only configuration, explicit origin/test-mode overrides across existing sources, malformed/missing explicit files, and a runtime startup producing the hosted workspace invitation without exposing it in logs. Run the existing gates and four representative network profiles, native release verification and public website/download checks. Preserve platform execution limits.
