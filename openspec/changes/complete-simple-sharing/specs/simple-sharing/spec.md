## ADDED Requirements

### Requirement: Offer files and text without a guest installation

The CLI MUST provide `send FILE`, `files DIRECTORY` and `text [TEXT]`, using hosted defaults and existing explicit configuration precedence. Downloads MUST be read-only, authenticated and confined to the selected content. Text MUST be bounded valid UTF-8, transferred only on explicit intent and never executed or logged.

#### Scenario: Download a selected file or browse a directory

- **WHEN** a visitor opens a valid sharing link
- **THEN** they can browse allowed directory entries and download regular files with size/hash verification
- **AND** traversal, symlink escapes, hidden/special entries, quota overflow and revoked access fail without a successful receipt.

#### Scenario: Exchange temporary text

- **WHEN** a participant deliberately sends text
- **THEN** the other participant can view and explicitly copy it
- **AND** bounded text remains in session memory and is erased when the session closes.

### Requirement: Initiate an ephemeral transfer from a browser

The website MUST let a user select local files or text, start an ephemeral encrypted sharing session and share its link without installing either endpoint. The hosting page MUST remain open, expose progress/end controls and enforce expiry, authenticated-peer grant binding, stream limits and bounded memory.

#### Scenario: Two browser devices exchange data

- **WHEN** the host selects a file and a visitor joins its link
- **THEN** the visitor can download and verify that file and exchange text
- **AND** ending the host session closes active streams and prevents further downloads without sending business data through the static website server.

### Requirement: Accessible startup and installation

Interactive no-argument startup MUST guide the user to an explicit resource and target. Noninteractive invocations MUST remain deterministic. Official user-local installers, Homebrew/Scoop recipes and an explicit native updater MUST select the proper release target, verify checksums and preserve the existing executable on failed downloads or validation.

#### Scenario: First installation and later update

- **WHEN** a user runs the documented installation or upgrade command
- **THEN** the correct executable is installed without a separate Tailcat, Go or Node installation
- **AND** unsupported platforms, invalid archives and digest mismatches fail visibly before replacing an existing executable.
