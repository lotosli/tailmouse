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

### Requirement: Notices and disclosures

Release source and artifacts SHALL include the selected project license, required third-party license/notice material, and README disclosures that TailMouse is unofficial, invitation links are passwords, DERP observes metadata, browser transport is DERP-only, and leash does not stream native GUI windows.

#### Scenario: License inventory is incomplete

- **WHEN** a release lacks the project license or required Tailcat/Tailscale notices
- **THEN** the delivery gate fails and no release is declared complete

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
