## ADDED Requirements

### Requirement: Official protected Leash publishes a short invitation

Protected Leash SHALL use the official same-origin short-invitation service when its effective Web base URL is `https://link.tailmouse.com/`. Escape, explicit `--no-password`, and any other valid self-hosted Web base SHALL retain the self-contained fragment invitation. This selection MUST NOT change the MouseCard, Tailcat address, TMOUSE protocol, or separate access-code authentication.

#### Scenario: Default protected Leash starts

- **WHEN** the user starts protected Leash with the official Web base URL
- **THEN** the Host publishes only the full invitation to the short service, presents the returned short URL and compact QR, and presents the access code only through the existing controlling-terminal boundary

#### Scenario: A non-protected or self-hosted mode starts

- **WHEN** the user starts Escape, explicitly selects `--no-password`, or configures a non-official Web base URL
- **THEN** TailMouse creates the existing fragment invitation and does not call the official short service

### Requirement: Publication and renewal fail closed

An official protected-Leash launch MUST NOT start the selected child or display a usable invitation unless short publication succeeds within a bounded request deadline. It MUST retain the returned management capability only in memory, renew the mapping on the specified schedule while the share is active, and request deletion during every terminal share-ending path. It MUST NOT silently fall back to a full invitation, pass the access code to the service, or hide a renewal failure.

#### Scenario: Initial short publication fails

- **WHEN** the service is unavailable, returns an invalid response, or exceeds its request deadline
- **THEN** TailMouse releases initialized transport and credential state, starts no child, emits one redacted invitation-publication error, and exits with invitation failure code 3

#### Scenario: Renewal cannot preserve the current lease

- **WHEN** bounded renewal attempts cannot succeed before the active mapping reaches its safety deadline
- **THEN** the Host visibly revokes the share and stops accepting new streams before the mapping expires, while retaining the first renewal failure as the root cause

#### Scenario: Cleanup request fails after local revocation

- **WHEN** the Host has already revoked local access but the bounded delete request fails
- **THEN** local shutdown completes with the original outcome, reports the redacted cleanup failure without the capability, and relies on the already scheduled service expiry rather than retrying indefinitely
