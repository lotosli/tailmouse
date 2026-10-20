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

Custom-map mode SHALL fetch the configured absolute HTTPS map URL through the native TailMouse adapter, pass the validated map to Tailcat for region selection, and embed the selected region in the resulting ConnBlob so the browser does not refetch the map. Official-map acquisition SHALL use the same security checks with Tailcat's official source. Plain HTTP MUST be rejected; controlled integration fixtures MUST NOT expose an insecure production option.

#### Scenario: Production receives an HTTP map URL

- **WHEN** production configuration uses `http://`
- **THEN** TailMouse rejects it with exit code 2 and performs no insecure fetch

### Requirement: Secure bounded map acquisition

Map acquisition MUST validate the initial URL and every redirect before issuing that request, require HTTPS with normal certificate verification, reject user information or fragments, and bound the chain to ten requests, ten seconds and eight MiB. Invalid status, body, structure or TLS policy MUST fail with a redacted category without retry or stale-cache fallback. Before Tailcat probes any map node, the complete decoded map MUST reject nil or inconsistent region/node entries, `InsecureForTests` and raw self-signed-certificate overrides. TailMouse MUST NOT change process-wide HTTP clients or certificate trust to implement this boundary.

#### Scenario: HTTPS map redirects to HTTP

- **WHEN** an otherwise trusted HTTPS map returns a redirect to plaintext HTTP
- **THEN** acquisition fails before any request reaches the HTTP destination and no relay selection or Host credential creation occurs

#### Scenario: Map attempts to bypass relay certificate verification

- **WHEN** any region contains an insecure-test flag or a raw self-signed-certificate override
- **THEN** the entire map is rejected before probing any region, including when the unsafe region would not have been selected

#### Scenario: Valid map is acquired or acquisition is canceled

- **WHEN** a valid map is fetched over trusted HTTPS within the bounds
- **THEN** its region data passes to Tailcat unchanged for selection and full-region invitation creation; invalid certificates, oversize bodies and caller cancellation instead stop acquisition without leaking URL or response contents

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
