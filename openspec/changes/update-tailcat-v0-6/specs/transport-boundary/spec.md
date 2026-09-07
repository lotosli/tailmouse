## MODIFIED Requirements

### Requirement: Connection credentials remain ephemeral

Tailcat addresses, including any embedded WireGuard pre-shared key, and invitation fragment material MUST remain in memory for the minimum required lifetime and MUST NOT enter logs, errors, metrics, command arguments, persistent browser storage, snapshots, or fixtures. The complete address MUST be treated as secret even when individual public-key or relay fields are otherwise non-secret.

#### Scenario: Dial fails with an upstream error

- **WHEN** Tailcat returns an error containing an address, pre-shared key, or other credential-shaped data
- **THEN** the adapter returns a classified redacted error with no original secret material

#### Scenario: A share is closed

- **WHEN** the Host reaches its terminal cleanup outcome
- **THEN** its retained Tailcat address and embedded pre-shared-key material are erased with the existing invitation state

### Requirement: Explicit upstream upgrades

The Tailcat v0.6 update MUST advance the parent repository's exact submodule gitlink from `4a25a91e0337252a4d16e097b03cf3cbb92c20cd` to signed release commit `790406204c002a6f109ef7c6a30a436601a1f6a8`, leave the upstream checkout clean, and pass adapter contract, Native/Wasm integration, release-identity, and full repository gates. Builds MUST NOT select the later `main` head or float a future tag automatically.

#### Scenario: The dependency update is inspected

- **WHEN** the parent diff, submodule state, and built artifact identities are compared
- **THEN** exactly the v0.6.0 release commit is recorded for both Native and Wasm and no Tailcat source modification is present

#### Scenario: A later upstream commit exists

- **WHEN** Tailcat `main` or another tag advances after v0.6.0
- **THEN** the current build remains on `790406204c002a6f109ef7c6a30a436601a1f6a8` until another explicit reviewed dependency change

#### Scenario: A new Tailcat release is available

- **WHEN** dependency maintenance discovers a later release
- **THEN** no source automatically floats to it and an explicit reviewed change is required

### Requirement: Native Tailcat server adapter

The native adapter SHALL create and own a Tailcat v0.6 server, preserve the default nonzero WireGuard pre-shared key, expose only a TailMouse-owned start/address/relay/close/drain contract, accept application connections only on virtual TCP port 44321, and convert the selected full-region Tailcat address into invitation input without exposing Tailcat types elsewhere. It MUST NOT disable the pre-shared key or expose an address-format downgrade setting.

#### Scenario: Tailcat server starts successfully

- **WHEN** valid official or custom relay configuration is supplied
- **THEN** the adapter returns a PSK-bearing safe address value and relay description, dispatches only accepted application connections, and keeps keys and upstream types private

#### Scenario: The random pre-shared-key source fails

- **WHEN** Tailcat cannot create the required ephemeral pre-shared key
- **THEN** startup fails before an invitation or application stream is produced and TailMouse does not retry with PSK disabled

#### Scenario: User cancels during relay selection

- **WHEN** cancellation or the caller's deadline occurs while an official or custom map is being fetched or its region is being selected
- **THEN** the adapter returns a redacted cancellation category, creates no usable session credential, and leaves no detached startup work

### Requirement: Same-revision native and Wasm transport

Native Tailcat imports and browser Tailcat Wasm MUST build from exact v0.6.0 commit `790406204c002a6f109ef7c6a30a436601a1f6a8`. The build SHALL record that revision and the resulting dependency identity in both artifacts and MUST NOT consume an independently downloaded or floating Wasm.

#### Scenario: Web build cannot identify the submodule revision

- **WHEN** dependency metadata, initialized submodule state, compiled module identity, or Native/Wasm revision agreement is missing or differs
- **THEN** the build fails before producing distributable Web or release assets

#### Scenario: Native and browser use the recorded v0.6 revision

- **WHEN** Native and browser artifacts built from the recorded v0.6.0 gitlink connect through official or controlled DERP
- **THEN** they use the PSK-bearing address and preserve existing Escape and Leash application behavior
