# Browser onboarding delta

## ADDED Requirements

### Requirement: Actionable resource-sharing onboarding

The browser MUST provide the following onboarding, lifecycle and privacy behaviors.

The resource-sharing browser client implements the owner's 2026-10-16 PRD with the retained Escape and same-origin test exceptions. Recovered behavior is an existing deployment baseline; its original tests and native sources remain a separate recovery requirement.

1. A visitor can reach acquisition instructions, the first Receive task, an example Dev workflow, permission/lifecycle guidance and feedback from the homepage. Commands identify prerequisites and successful outcomes. No unsupported platform or unavailable download is presented as verified.
2. Port-only Web targets refer to 127.0.0.1 on the sharing machine. Web is a browser preview of the entire configured origin, not a general public HTTP tunnel or a path access restriction.
3. The workspace distinguishes runtime loading, network connection and host approval using actual events. Invalid/expired invitations direct visitors to the host; version and connection failures have actionable help. A preview-only fault does not imply that other resources failed.
4. Leaving is described as ending this visitor's access. Expiry/host termination explain that managed CLI processes end, existing Web servers continue and confirmed files remain. Terminal input permission is visible and never inferred from a read-only view.
5. Only a validated host receipt marks a file received. Progress at 100% still requires verification. Receipt names and paths reflect the host's result; insertion prepares input without sending Enter. Failed/canceled traffic consumes quota; reconnect does not promise upload resumption. Global remaining quota may only be displayed from authoritative host data.
6. Feedback contains only an explicit allowlist of build/protocol identifiers, browser family and coarse phase. The user can inspect it before manually copying it. Nothing is sent automatically.
7. Public homepage anchors work on initial load and reload without being interpreted as invitations. Unknown fragments still follow strict invitation parsing and erasure. Escape and Leash retain their existing paths.

#### Scenario: First successful file transfer

- **WHEN** a new host follows the Receive guide with a matching build and a second device
- **THEN** the guide identifies prerequisites, the receiving folder, the confirmed-receipt success condition and how access ends
- **AND** an unavailable public download is not advertised as ready.

#### Scenario: Visitor needs help

- **WHEN** connection, authorization, preview or upload cannot complete
- **THEN** the browser identifies an actionable next step without inventing success or exposing credentials in feedback.

#### Scenario: Public sections are opened directly

- **WHEN** a visitor opens or reloads a known homepage section anchor
- **THEN** the homepage remains visible and legacy invitation fragments still follow their original parser.

## Recovery boundary

The resource PRD permits bounded per-tab sessionStorage recovery on the trusted frontend; this is a narrow exception to the legacy in-memory-only rule. Preserve the recovered validation, TTL, erasure and origin checks. Do not extend it to localStorage, logs, analytics, previews or legacy invitations.
