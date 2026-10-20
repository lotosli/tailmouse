# Hosted resource defaults

Status: accepted by the owner's 2026-10-20 instruction to remove the configuration-file prerequisite and lower the entry barrier.

Observed: resource commands select a legacy frontend by default, and Web fails without a content origin. The supported tailmouse.com resource deployment already provides the owner-approved same-origin trusted-app configuration.

Decision: embed that deployment as one default pair when neither origin has been configured. Preserve explicit test-mode values and all existing configuration precedence and failure rules. Custom origins do not inherit implicit same-origin permission. No automatic configuration download, new service, installer, dependency or protocol change is needed. Session limits and legacy command defaults stay unchanged.

The simpler documentation-only alternative does not make `tailmouse web 8080` work. Automatically fetching the JSON would add a mutable network prerequisite. The accepted [proposal](../../openspec/changes/default-hosted-resource-config/proposal.md) records the bounded behavior and verification. Outcome: focused defaults/override/startup tests, seven workspace browser cases and the complete Linux gate pass. Native publication remains pending; its result is recorded in project memory and release evidence.
