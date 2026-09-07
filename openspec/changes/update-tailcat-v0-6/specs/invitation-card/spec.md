## ADDED Requirements

### Requirement: PSK-bearing Tailcat addresses remain opaque and bounded

A MouseCard carrying a Tailcat v0.6 full-region address with its default WireGuard pre-shared key MUST preserve that address as one opaque credential, remain below the existing 1400-byte invitation limit, and satisfy the existing URL-fragment, QR, parsing, erasure, and diagnostic-redaction requirements. No PSK field or compatibility selector SHALL be added to MouseCard or TMOUSE messages.

#### Scenario: Updated Host creates an invitation

- **WHEN** Tailcat v0.6 returns a full-region address containing its default pre-shared key
- **THEN** TailMouse produces a decodable invitation and QR within the existing limits without inspecting, splitting, logging, or persisting the embedded key

#### Scenario: The expanded address exceeds an existing bound

- **WHEN** the v0.6 address causes the MouseCard, encoded URL, or QR input to reach an existing maximum
- **THEN** invitation construction fails before displaying partial credential material and no larger or alternate format is enabled implicitly

#### Scenario: The browser consumes an updated invitation

- **WHEN** the browser accepts a MouseCard containing a PSK-bearing address
- **THEN** it passes the opaque address only to the Tailcat adapter, removes the fragment from visible history, and erases the retained address under the existing terminal cleanup rules
