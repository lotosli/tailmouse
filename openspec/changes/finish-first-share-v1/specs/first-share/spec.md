## ADDED Requirements

### Requirement: Start with the user's task

The homepage and guide MUST distinguish browser file/text sharing from native app/terminal sharing, present installation commands directly, and show current platform capabilities without directing Windows users into unsupported Receive.

#### Scenario: Complete a first browser transfer

- **WHEN** a new user chooses file/text sharing
- **THEN** they reach selection without installing a client or reading the native workflow
- **AND** selected-file errors can be corrected before starting a session.

### Requirement: Make transfer state understandable

The browser MUST show runtime download progress, persistent connection/expiry state, local QR and explicit native sharing where supported. Transient action feedback MUST NOT hide connection failures. Receiving browsers MUST disclose actual download limits before an attempt and verify files before confirming successful transfer to their download mechanism. Shared text MUST explicitly replace one value and preserve unsent edits.

#### Scenario: Correct a file and recover from a failed transfer

- **WHEN** a selection or download is invalid or canceled
- **THEN** the interface identifies the relevant file and actionable reason
- **AND** the user can correct selection or deliberately retry without automatic replay or false delivery claims.

### Requirement: Guide platform-appropriate native startup

The native wizard MUST allow invalid-choice correction, expose read-only versus interactive terminal intent, hide unsupported platform choices, and explain local management after startup.

#### Scenario: Correct startup input

- **WHEN** a user selects an invalid menu choice or declines unsupported behavior
- **THEN** they can choose again or quit under the existing cancellation context
- **AND** no terminal launches without explicit confirmation.

### Requirement: Publish an evidence-bound 1.0 release

The project MUST publish v1.0.0 from preserved accepted source, verify all six archive targets and public assets, update package recipes and deploy the same source. Documentation MUST include installation, uninstall/recovery and actual validation limits.

#### Scenario: Install the published version

- **WHEN** a user follows the documented installer or package-manager path
- **THEN** the recipe matches published version/checksums and hosted commands need no configuration file
- **AND** unavailable signing identities or native-platform evidence are not represented as completed validation.

### Requirement: Remove the minigame from the current product

The current source, CLI, browser, build and tests MUST no longer include the Escape game. Historical immutable releases and provenance records MAY remain.

#### Scenario: Use the 1.0 application

- **WHEN** a user opens the homepage or lists CLI commands
- **THEN** only supported sharing journeys and protected legacy terminal access are offered
- **AND** no game runtime, assets or game-specific tests ship in the current build.

### Requirement: Retire the old game frontend at every official entry

The existing official legacy origin MUST serve the game-free release frontend while retaining its protected short-invitation API and storage bindings. Ordinary homepage and resource-hosting anchor navigation at that origin MUST use the canonical tailmouse.com product site. Credential-bearing fragments, short locator paths and self-hosted origins MUST NOT be redirected or forwarded by this convenience rule.

#### Scenario: Open the previous official homepage

- **WHEN** a visitor opens an ordinary homepage or hosting guide anchor at link.tailmouse.com
- **THEN** the browser replaces that navigation with the same known anchor at tailmouse.com without forwarding query parameters
- **AND** a legacy full invitation or protected short locator remains on its original authentication origin and can use the matching game-free frontend.
