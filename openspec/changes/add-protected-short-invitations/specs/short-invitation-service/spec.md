## Purpose

Define the bounded official mapping that turns a protected Leash invitation into a memorable locator without storing its separate access code or relaying terminal traffic.

## HTTP contract

The official origin is `https://link.tailmouse.com`. Request and JSON response bodies are at most 2048 bytes. Redirects are forbidden. JSON objects have exactly the listed fields; unknown fields are rejected. Times are safe integer Unix milliseconds. Every API success and failure uses `Cache-Control: no-store`, no-referrer, and the standard static security headers. Errors contain only one stable `error` classification; a random request identifier may appear in a response header.

| Operation | Request                                                                                    | Successful response                           |
| --------- | ------------------------------------------------------------------------------------------ | --------------------------------------------- |
| Create    | `POST /api/v1/short-invitations`, JSON `{invitation, access: "code"}`                      | 201 JSON `{code, managementToken, expiresAt}` |
| Resolve   | `GET /api/v1/short-invitations/<code>`, no body                                            | 200 JSON `{invitation, expiresAt}`            |
| Renew     | `PUT /api/v1/short-invitations/<code>`, no body; `Authorization: Bearer <managementToken>` | 200 JSON `{expiresAt}`                        |
| Delete    | `DELETE /api/v1/short-invitations/<code>`, no body; same authorization header              | 204, no body                                  |

`invitation` is the complete canonical official URL, shorter than 1400 bytes. `code` is exactly six Base62 characters. `managementToken` is canonical unpadded Base64url encoding of 32 random bytes. The service checks the declared `access: "code"` and strict identifier-2 Leash MouseCard. Because the existing MouseCard deliberately has no authentication field, this declaration is not remote proof of Host policy: the official CLI publishes only protected shares, and the browser MUST require protected Host authentication for a resolved short invitation. No access code or proof enters this HTTP API.

Each API request has a ten-second work deadline, at most eight collision attempts, and at most 64 in-flight API operations per isolate with no waiting queue. Platform rate bindings limit creates to 5 per minute per source IP and 100 per minute per edge location, and reads/management to 60 per minute per source IP and 1000 per minute per edge location. Rate keys contain no locator, invitation, or management token. Platform counters are local and eventually consistent, so these are abuse controls, not strict global quotas or billing caps. Exceeding a limit returns 429 with `Retry-After: 60`; required binding failures fail closed.

## ADDED Requirements

### Requirement: Six-character locator allocation

The official service SHALL allocate an exactly six-character, case-sensitive Base62 locator for a valid protected-Leash invitation and SHALL return a separate cryptographically random management capability. The locator MUST NOT be described or accepted as authentication, and the service MUST reject malformed, oversized, non-Leash, or unsupported-protocol invitations before retaining them.

#### Scenario: A protected Leash invitation is published

- **WHEN** the Host submits a valid bounded identifier-2 protected-Leash invitation without an access code
- **THEN** the service atomically claims one six-character `[0-9A-Za-z]` locator and returns its short URL, management capability, and current lease expiry
- **AND** possession of the locator alone grants no Host authentication or management authority

#### Scenario: An invalid invitation is submitted

- **WHEN** a create request is malformed, exceeds the invitation limit, selects Escape or link-only access, or carries an access code field
- **THEN** the service rejects it without allocating a locator or retaining any request body

### Requirement: Explicit plaintext trust boundary

The service MAY retain the complete invitation in its active plaintext mapping only for the mapping lease. It MUST never accept or store an access code, authentication proof, terminal data, process metadata, or command data, and MUST exclude invitations and management capabilities from logs, analytics, traces, metrics labels, errors, cache keys, and cache values. Product disclosure SHALL state that the official short-link operator can read the invitation while it is leased. TailMouse MUST maintain no invitation archive or recovery API. Cloudflare's documented SQLite point-in-time recovery window is separate from active mapping lifetime; the product MUST NOT claim verified physical or recovery-copy erasure within 15 minutes. Operators MUST NOT restore invitation storage from historical backups.

#### Scenario: An operator inspects retained mapping data

- **WHEN** a mapping is active
- **THEN** its bounded invitation, locator, lease metadata, and one-way management-capability verifier are the only session-specific retained fields
- **AND** no access code or terminal/session payload is available from the service

#### Scenario: A service error occurs

- **WHEN** create, resolve, renew, or delete fails
- **THEN** the response and operational output contain only a stable non-secret classification and request correlation value independent of the invitation and management capability

### Requirement: Finite lease and authoritative deletion

Every mapping SHALL have a 15-minute lease. Only a valid management capability MAY renew it, and each successful renewal SHALL set expiry to 15 minutes after that renewal. A Host SHOULD renew every five minutes while the share remains active. Host revocation, configured session expiry, completion of post-exit retention, and Host shutdown MUST request immediate deletion. Browser resolution MUST NOT renew the lease. Every authoritative read and renewal MUST reject an expired lease even if alarm execution is delayed. Active-state deletion runs through the scheduled alarm and on detection of expiry; cleanup failure preserves a future alarm attempt and a non-secret failure.

#### Scenario: The Host exits normally

- **WHEN** an active Host revokes or ends its share
- **THEN** it sends one bounded authenticated deletion request and the service makes subsequent resolution fail immediately

#### Scenario: The Host crashes or loses the network

- **WHEN** no valid renewal reaches the service before lease expiry
- **THEN** resolution and renewal reject the expired mapping immediately, and the scheduled alarm deletes active mapping state without requiring browser traffic or a Host shutdown callback

#### Scenario: A browser repeatedly opens the short URL

- **WHEN** one or more browsers resolve a mapping without a Host renewal
- **THEN** the lease expiry remains unchanged and the mapping becomes unavailable at its original deadline

### Requirement: Strongly consistent management

Create, resolve, renew, delete, and expiry for one locator MUST observe one authoritative order. A valid management capability SHALL be required for renewal and deletion, MUST be compared without storing its plaintext value, and MUST NOT be replaceable by the locator or access code.

#### Scenario: Delete races with resolve

- **WHEN** an authenticated delete is ordered before a resolution request for the same locator
- **THEN** resolution returns the same generic unavailable result as an unknown or expired locator and never returns the invitation

#### Scenario: A locator holder attempts management

- **WHEN** a caller supplies the short locator without the valid management capability to renew or delete
- **THEN** the operation fails without revealing whether another management capability was close or valid

### Requirement: Non-cacheable bounded resolution

The same-origin resolution API SHALL accept only one canonical six-character locator, return at most one bounded invitation for an unexpired mapping, and mark every success and failure response as non-cacheable. Unknown, expired, malformed, and deleted locators MUST share a generic user-visible result and MUST NOT expose storage or Host state.

#### Scenario: A valid short path is resolved

- **WHEN** the browser requests an active locator from the official origin
- **THEN** it receives the bounded invitation with `no-store` semantics and no access code, redirect containing the invitation, or lease extension

#### Scenario: A code is unavailable

- **WHEN** a locator is unknown, expired, deleted, malformed, or has no separately allocated exact-case match
- **THEN** the service returns the same bounded unavailable classification without distinguishing those unavailable reasons

### Requirement: Collision and abuse bounds

Locator generation MUST use a cryptographically secure random source, skip manifest-listed static filenames such as `NOTICE`, claim codes atomically, retry collisions within a fixed attempt limit, and fail without replacing another mapping when exhausted. Create and resolve operations SHALL have explicit body, time, concurrency, and rate bounds so enumerating six-character locators cannot become an unbounded workload.

#### Scenario: A generated locator already exists

- **WHEN** allocation collides with an active mapping
- **THEN** the service leaves the existing mapping unchanged and retries with fresh randomness only within its fixed attempt budget

#### Scenario: A caller exceeds an abuse bound

- **WHEN** create or resolve traffic exceeds the configured limit
- **THEN** the service rejects the excess with a non-secret retry boundary and does not perform an unbounded scan or allocation loop
