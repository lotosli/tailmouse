## Purpose

Define equivalent official and self-hosted DERP configuration paths while keeping browser invitations self-contained and TLS-safe.

## ADDED Requirements

### Requirement: Official relay mode

With no DERP override, TailMouse SHALL use Tailcat's zero-value server behavior and official relay map, select a region through Tailcat, generate an ephemeral key, and produce a ConnBlob containing the complete selected region needed by the browser.

#### Scenario: User starts with default configuration

- **WHEN** no host, map URL, environment override, or file override is set
- **THEN** the server reaches listening state in official mode and the browser needs no separate relay configuration

### Requirement: Custom-host relay mode

Custom-host mode SHALL build one local DERP region with stable ID 900 through 999, default ID 900, all supplied hostnames as nodes, DERP port 443, STUN port 3478, default code `mouse`, and default name `TailMouse Custom DERP`. The full node hostname data MUST be embedded in the ConnBlob.

#### Scenario: Multiple custom hosts are configured

- **WHEN** the user supplies a valid comma-separated or TOML host list
- **THEN** each normalized hostname appears once in the selected embedded region and the browser dials without a DERP map URL

#### Scenario: Custom hostname is invalid

- **WHEN** a host contains a scheme, path, credential, invalid DNS syntax, or empty list element
- **THEN** validation exits with code 2 before any network request

### Requirement: Custom-map relay mode

Custom-map mode SHALL pass an absolute HTTPS map URL to Tailcat, allow Tailcat to select a region, and embed the selected region in the resulting ConnBlob so the browser does not refetch the map. Plain HTTP MUST be rejected except under an explicit development-only option unavailable to production builds.

#### Scenario: Production receives an HTTP map URL

- **WHEN** configuration uses `http://` without the development-only build and flag
- **THEN** TailMouse rejects it with exit code 2 and performs no insecure fetch

### Requirement: Relay modes are exclusive

Host and map configuration MUST be mutually exclusive after all precedence layers are resolved, including conflicts originating within environment or TOML sources.

#### Scenario: Both relay sources remain configured

- **WHEN** effective configuration contains both custom hosts and a custom map URL
- **THEN** TailMouse names the conflicting settings, emits no secret, and exits with code 2

### Requirement: Self-hosted DERP documentation boundary

TailMouse SHALL document but MUST NOT automate DERP deployment. Documentation SHALL state direct public DNS and TLS requirements, TCP 80/443, UDP 3478, ICMP, DNS-only proxying, updates and monitoring, and incompatibility with `derper --verify-clients` for unaffiliated Tailcat clients.

#### Scenario: Operator enables client verification

- **WHEN** a self-hosted DERP requires tailnet client verification
- **THEN** documentation and integration evidence identify that TailMouse connections are expected to fail rather than suggesting a bypass
