# Resource sharing release

## ADDED Requirements

### Requirement: Matching source-built resource products

TailMouse MUST implement the owner's resource PRD using native `cli`, `web`, `receive` and combined `dev` resources, and MUST retain Escape. The normal build MUST produce matching native/browser protocol identities and both transport artifacts from pinned source without recovery archives. Port-only Web arguments MUST target 127.0.0.1 on the host. Unknown or incompatible protocol inputs MUST fail closed.

#### Scenario: Build a resource release

- **WHEN** the normal build runs from a clean recorded revision
- **THEN** native and Web artifacts identify that revision and exact Tailcat gitlink
- **AND** manifests, checksums, licenses and dependency inventories describe the actual shipped artifacts.

### Requirement: Bounded resource authority and lifecycle

The Host MUST authorize each member and resource stream, enforce approval, read-only and controller grants, session/member expiry, capacity and upload limits, and cancel work on revocation or termination. A terminal MUST retain its process during authorized reconnect and terminate its process group when the host ends. Upload success MUST follow hash/size validation and a no-overwrite committed file receipt. Web and WebSocket traffic MUST stay within the configured origin and preserve streaming cancellation and backpressure.

#### Scenario: Revocation and failed transfer

- **WHEN** a member is revoked or a transfer is malformed, canceled or over quota
- **THEN** no unauthorized work or successful receipt is produced
- **AND** resources and partial files are released without refunding consumed quota or deleting confirmed files.

### Requirement: Reviewed deployment and proportionate acceptance

The release MUST pass meaningful native/browser checks and four representative impairment profiles. The owner's private same-origin test exception MUST remain explicit. The static deployment MUST NOT proxy business traffic. Source MUST be committed and verified on the remote branch before handoff or deployment.

#### Scenario: Publish to the private test hostname

- **WHEN** the accepted candidate is deployed to tailmouse.com
- **THEN** public asset identities and hosting headers match the candidate
- **AND** trusted same-origin mode is identified without claiming hostile-preview isolation.
