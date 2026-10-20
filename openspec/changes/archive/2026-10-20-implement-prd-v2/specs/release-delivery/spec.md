## MODIFIED Requirements

### Requirement: Static Web distribution

The Web release SHALL contain only static self-hostable assets with content-hashed scripts/styles/Wasm, compressed Wasm variants, correct `application/wasm` serving metadata, immutable caching for hashed assets, no-cache HTML, security headers, and a minimal container/static-server example with no application backend. The official phase-two deployment SHALL serve the same verified assets from a Cloudflare R2 bucket bound to `https://link.tailmouse.com/`, using static object metadata plus URL-rewrite, cache, and response-header rules and no Worker or application service.

#### Scenario: Static bundle is served independently

- **WHEN** an operator serves the documented output from a conforming static host
- **THEN** invitation parsing, Wasm loading, Tailcat dialing, access authentication, and both mode UIs require no TailMouse server API

#### Scenario: Official root URL is requested

- **WHEN** a browser requests `https://link.tailmouse.com/`
- **THEN** the external static configuration resolves the request to the verified entry document with HTTPS, no-cache HTML, required security headers, and no redirect that exposes invitation fragments

### Requirement: Initial and rolling protocol compatibility

Wire identifier 1 SHALL denote TMOUSE/1.0 and remain the Escape contract. Wire identifier 2 SHALL denote TMOUSE/1.1 and be the phase-two Leash contract. Phase-two browser releases MUST support identifier 1 for Escape and identifier 2 for Leash, report compatibility by mode rather than implying one shared continuous range, and pass cross-version fail-closed evidence before publication. A phase-two Leash invitation SHALL declare only `2..2`; neither old Host nor old browser compatibility may bypass access authentication.

#### Scenario: Phase-two artifacts are compared

- **WHEN** native and Web release metadata is inspected
- **THEN** both identify Escape `1` and Leash `2`, share the same exact Tailcat gitlink, and reject unsupported mode/identifier pairs without automatic downgrade

#### Scenario: Initial release has no preceding minor

- **WHEN** the historical TMOUSE/1.0 artifact is inspected
- **THEN** it remains identifier 1-only and is not rewritten to claim implementation of identifier 2 or phase-two Leash authentication

#### Scenario: An old Leash peer is tested

- **WHEN** identifier-1-only Leash and identifier-2 Leash artifacts are paired in either direction
- **THEN** the pair fails with `PROTOCOL_MISMATCH` before terminal disclosure, startup, or control, and release evidence does not describe that result as compatibility

### Requirement: Notices and disclosures

Release source and artifacts SHALL include the complete Apache-2.0 project license, TailMouse notice, required third-party license/notice material, and README disclosures that TailMouse is unofficial, invitations and access codes are credentials, link-only invitations grant access, DERP observes metadata, browser transport is DERP-only, Leash targets standards-based terminal CLI/TUI programs, and native GUI windows are not streamed.

#### Scenario: License inventory is incomplete

- **WHEN** a release lacks the project license or required Tailcat/Tailscale notices
- **THEN** the delivery gate fails and no release is declared complete

#### Scenario: Dependency notices drift after an update

- **WHEN** an installed production dependency version, source notice, or recorded Tailcat revision differs from the checked-in notice inventory
- **THEN** notice verification fails until an explicit reviewed regeneration preserves the new source material
- **AND** release verification rejects an artifact dependency absent from the inventory or archive/Web notice bytes that differ from the verified source text

#### Scenario: A module contains separately attributed subcomponents

- **WHEN** a selected dependency contains nested license, notice, copying, copyright, patent, or author files
- **THEN** the notice bundle preserves their source paths and original text without assigning the project's Apache-2.0 license to them
- **AND** conservative inclusion of additional source-subtree notices is identified as such rather than claimed as proof of linked code

### Requirement: Demonstration and device evidence

A phase-two candidate SHALL include macOS demonstrations of protected and link-only Leash covering a shell, a full-screen TUI, a short command, and one AI CLI example, plus leave-and-return and retained-result flows. Native Linux and Windows execution are owner-deferred and SHALL be recorded as `deferred / not verified` until matching environments are provided; cross-compilation, static analysis, packaging, or simulated browser tests MUST NOT be relabeled as native runtime acceptance or support. Physical iPhone Safari, Android Chrome, target-network, and target-program results MUST likewise be reported by the environment actually exercised.

#### Scenario: Current macOS development evidence is complete

- **WHEN** deterministic gates and the specified macOS real-runtime scenarios pass but Linux and Windows environments have not been supplied
- **THEN** the current development cycle may complete with both platforms explicitly marked `deferred / not verified`, without a Linux or Windows runtime-support claim

#### Scenario: Only simulated browser tests exist

- **WHEN** automated browser tests pass but a claimed physical mobile environment has no recorded real-device result
- **THEN** that device remains unverified and the completion audit reports the missing evidence

#### Scenario: A deferred environment becomes available

- **WHEN** the owner later provides a matching Linux, Windows, or physical mobile environment
- **THEN** its native acceptance scenarios run and produce dated observed evidence without rewriting prior deferred evidence as a historical pass

## ADDED Requirements

### Requirement: Official static publication is independently verified

Publication at `https://link.tailmouse.com/` MUST use the exact gate-approved static manifest, preserve content encodings and MIME, apply the required cache/security headers, disable the non-production R2 development URL, and record DNS/custom-domain status, TLS, object sizes, actual transfer size, cold/warm startup stages, and a real Host-to-browser official-DERP connection. Missing account or DNS authority SHALL leave publication pending rather than trigger an alternate server or an unverified completion claim.

#### Scenario: The raw Wasm exceeds the Pages asset limit

- **WHEN** release inspection observes the current Wasm above Cloudflare Pages' per-file maximum
- **THEN** the artifact remains unchanged and is delivered from the selected R2 static bucket; the release MUST NOT silently omit it, split it, add a Worker, or modify Tailcat to fit Pages

#### Scenario: Public credentials are unavailable

- **WHEN** local release verification passes but R2, custom-domain, or DNS credentials are absent
- **THEN** publish automation performs no external mutation and reports public-hosting acceptance as pending
