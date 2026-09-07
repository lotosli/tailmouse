## MODIFIED Requirements

### Requirement: Static Web distribution and official edge composition

The Web release SHALL retain static self-hostable assets with content-hashed scripts/styles/Wasm, compressed Wasm variants, correct `application/wasm` metadata, immutable caching for hashed assets, no-cache HTML, and the documented static-server example. The official deployment SHALL serve those exact verified assets and add only the same-origin bounded short-invitation API and short-path routing required for protected Leash. The edge service MUST NOT relay terminal traffic, authenticate access codes, change static asset bytes, or become required by full self-hosted fragment invitations.

#### Scenario: Static bundle is served independently

- **WHEN** an operator serves the documented output from a conforming static host
- **THEN** full invitation parsing, Wasm loading, Tailcat dialing, access authentication, and both mode UIs require no TailMouse server API

#### Scenario: Official short path is requested

- **WHEN** a browser requests a canonical six-character path from `https://link.tailmouse.com/`
- **THEN** the official edge serves the verified application entry with required security headers and permits only the bounded same-origin resolver to supply invitation material to page memory

## ADDED Requirements

### Requirement: Short-service publication is independently verified

Official publication MUST deploy the reviewed short-link runtime and strongly consistent expiring storage configuration before switching short-path traffic, while preserving the gate-approved static manifest, encodings, MIME, cache/security headers, TLS policy, unknown-path 404 behavior, and disabled non-production object URL. Publication SHALL verify create, case-sensitive resolve, wrong-case rejection, renewal, immediate delete, alarm expiry, no-cache behavior, redacted logs, static-byte identity, and a real protected Host-to-browser connection.

Credential-free local workerd/SQLite checks and clean release verification MUST precede the official route cutover. Public checks then run within that cutover window without enabling preview endpoints or another origin. The new official protected-Leash CLI default MUST NOT be delivered until every public check passes; any failed publication check MUST immediately restore the preceding verified static deployment.

#### Scenario: Service deployment is incomplete

- **WHEN** runtime, storage migration, rate limits, route, static binding, deletion alarm, or public verification is missing or fails
- **THEN** the deployment does not switch the official protected-Leash default and does not claim short-link availability

#### Scenario: Static delivery changes during cutover

- **WHEN** any manifest-listed public asset differs in bytes, encoding, MIME, cache policy, or security headers after the edge cutover
- **THEN** publication fails and the previous verified static deployment remains or is restored without publishing a partial short-link release

#### Scenario: Production deletion is exercised

- **WHEN** a synthetic protected invitation is created and then deleted through its management capability
- **THEN** the exact short path becomes unavailable immediately in a separate request context and no invitation or access code appears in retained operational evidence
