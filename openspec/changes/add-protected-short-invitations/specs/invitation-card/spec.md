## MODIFIED Requirements

### Requirement: Fragment-only full invitation

A self-contained invitation SHALL continue to use `/#/v1/<base64url-cbor>` and MUST place ConnBlob material only in the URL fragment. An official protected-Leash short URL MAY instead contain one six-character path locator whose server-side mapping yields that same complete invitation; neither locator nor mapping may contain the access code. The browser MUST reject an oversized or malformed fragment or resolved invitation before unbounded decode, consume valid material into memory, immediately remove fragment or short path from visible history, and never write it to browser storage, static caches, referrers, analytics, or error reports.

#### Scenario: Static host receives a full invitation request

- **WHEN** a browser navigates to a complete fragment invitation URL
- **THEN** the HTTP request contains no fragment or ConnBlob and uses a no-referrer policy

#### Scenario: Official host receives a short invitation request

- **WHEN** a browser navigates to `https://link.tailmouse.com/<code>`
- **THEN** the path contains only the exact six-character locator and neither the ConnBlob nor access code
- **AND** the resolved full invitation enters only page memory before the visible URL is replaced with the origin root

#### Scenario: User reloads after invitation removal

- **WHEN** the page reloads after the one-time in-memory invitation was consumed
- **THEN** no credential is recovered from storage and the page requests that the original full or short invitation be opened again

### Requirement: Bounded URL and compact QR rendering

An encoded full invitation MUST be shorter than 1400 bytes. Terminal QR output SHALL encode the URL actually presented to the user at error correction level M using the smallest version required by that payload, a four-module quiet zone, and at most one terminal column by two terminal rows per QR module pair. The presented URL SHALL appear only in the QR area and one explicit `Open:` line unless QR output is suppressed.

#### Scenario: Invitation exceeds the full-URL budget

- **WHEN** a self-contained MouseCard produces a URL of 1400 bytes or more
- **THEN** TailMouse emits no partial QR, reports invitation construction failure without the credential, and exits with code 3

#### Scenario: A protected official short URL is rendered

- **WHEN** publication returns a valid six-character locator
- **THEN** the QR encodes exactly the short HTTPS URL rather than the full invitation and the `Open:` line displays the same short URL

#### Scenario: QR encoder or renderer changes

- **WHEN** a supported synthetic full or short invitation is rendered using a replacement encoder or terminal renderer with an explicit license grant
- **THEN** an independent decoder recovers exactly the presented URL, error-correction format remains M, the encoder-selected symbol is no larger than the payload requires, and the four-module quiet zone is intact
- **AND** alternate valid QR masks are allowed without changing invitation bytes, display permissions, or size rejection
