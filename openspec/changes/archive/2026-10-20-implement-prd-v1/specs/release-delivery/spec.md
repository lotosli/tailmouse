## Purpose

Define reproducible native and static Web release artifacts, compatibility metadata, notices, and evidence required for a complete v0.1 delivery.

## ADDED Requirements

### Requirement: Native platform artifacts

The release pipeline SHALL build the single `tailmouse` executable for macOS 13+ arm64/amd64, Linux glibc arm64/amd64, and Windows 11 arm64/amd64, and MUST attach SHA-256 checksums and an SBOM for every distributed archive.

#### Scenario: Release matrix completes

- **WHEN** a versioned release candidate is built
- **THEN** every required OS/architecture artifact, checksum, and SBOM is present and traceable to one source revision or the release fails

### Requirement: Static Web distribution

The Web release SHALL contain only static self-hostable assets with content-hashed scripts/styles/Wasm, compressed Wasm variants, correct `application/wasm` serving guidance, immutable caching for hashed assets, no-cache HTML, and a minimal container/static-server example with no application backend.

#### Scenario: Static bundle is served independently

- **WHEN** an operator serves the documented output from a conforming static host
- **THEN** invitation parsing, Wasm loading, Tailcat dialing, and both mode UIs require no TailMouse server API

### Requirement: Release identity and compatibility

Native and Web artifacts MUST embed TailMouse build version, exact Tailcat gitlink, and supported TMOUSE min/max. An official release SHALL build native and Wasm from the same gitlink and reject an unsupported protocol range with `PROTOCOL_MISMATCH`.

#### Scenario: Native and Web dependency revisions differ

- **WHEN** release inspection finds different Tailcat gitlinks in the two artifact sets
- **THEN** packaging fails before publication

### Requirement: Initial and rolling protocol compatibility

Wire identifier 1 SHALL denote the initial TMOUSE/1.0 contract. Browser releases SHALL support the latest two actually available same-major minor contracts, or the sole initial minor when no predecessor exists. Any later minor MUST have a documented wire identifier, explicit negotiation and cross-version conformance evidence before its identifier enters build metadata. The initial release SHALL declare only `1..1`; a wider invitation range MUST NOT imply implementation of another codec or relax strict decoding of the selected contract.

#### Scenario: Initial release has no preceding minor

- **WHEN** the first TMOUSE/1.0 candidate is verified
- **THEN** both artifacts declare identifier 1, compatible wider invitations negotiate only identifier 1, and non-overlapping peers fail closed
- **AND** no fictional second minor, speculative codec or fabricated backward-compatibility result is required

### Requirement: Notices and disclosures

Release source and artifacts SHALL include the complete Apache-2.0 project license, TailMouse notice, required third-party license/notice material, and README disclosures that TailMouse is unofficial, invitation links are passwords, DERP observes metadata, browser transport is DERP-only, and leash does not stream native GUI windows.

#### Scenario: License inventory is incomplete

- **WHEN** a release lacks the project license or required Tailcat/Tailscale notices
- **THEN** the delivery gate fails and no release is declared complete

#### Scenario: Dependency notices drift after an update

- **WHEN** an installed production dependency version, source notice or recorded Tailcat revision differs from the checked-in notice inventory
- **THEN** notice verification fails until an explicit reviewed regeneration preserves the new source material
- **AND** release verification rejects an artifact dependency absent from the inventory or archive/Web notice bytes that differ from the verified source text

#### Scenario: A module contains separately attributed subcomponents

- **WHEN** a selected dependency contains nested license, notice, copying, copyright, patent or author files
- **THEN** the notice bundle preserves their source paths and original text without assigning the project's Apache-2.0 license to them
- **AND** conservative inclusion of additional source-subtree notices is identified as such rather than claimed as proof of linked code

### Requirement: Demonstration and device evidence

A release candidate MUST include an Escape demonstration followed by a Leash terminal/TUI demonstration and SHALL record real-device acceptance for native macOS, Linux, and Windows plus iPhone Safari and Android Chrome.

#### Scenario: Only simulated browser tests exist

- **WHEN** automated browser tests pass but either required mobile browser has no recorded real-device result
- **THEN** the candidate remains unverified for release and the PRD completion audit reports the missing evidence

### Requirement: Reproducible publication boundary

Repository automation SHALL generate and verify publishable artifacts without embedding release credentials. Actual publication, signing identity, production domain, and external account operations MUST require explicit owner configuration.

#### Scenario: Release credentials are absent

- **WHEN** an unprivileged contributor builds a release candidate
- **THEN** all local artifacts and verification complete without attempting or claiming external publication
