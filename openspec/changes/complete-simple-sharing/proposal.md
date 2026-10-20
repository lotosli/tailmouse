# Complete simple sharing

Status: accepted by the owner's 2026-10-20 instruction to implement all six reviewed suggestions, commit and deploy them.

## Why

The hosted defaults remove configuration, but hosts cannot offer downloads or text, browser users cannot initiate a transfer, and installation still requires archive selection. Complete these concrete journeys without accounts or a business-data server.

## Decisions

- Extend TMOUSE/2 with optional `files` and `text` resources and authenticated `download` and `text` streams. Old frontends reject unknown resources rather than weakening authorization. Preserve all legacy resources and Tailcat pin.
- `send FILE` offers one file; `files DIRECTORY` offers a bounded, read-only directory browser. Anchor native access with `os.Root`, omit hidden/special/symlink entries, reject traversal and non-regular files, and bound listing, downloads, concurrent work and cumulative bytes. No SFTP client is needed.
- `text` offers UTF-8 text from explicit arguments or bounded stdin. Visitors can read/copy and deliberately send a replacement. No automatic clipboard access, shell execution, telemetry or persisted text.
- A browser can host selected File objects and text using an ephemeral Tailcat listener in the existing Worker/Wasm adapter. Reuse invitation, framing and receiving UI; bind grants to authenticated transport peers, heartbeat controls, close all streams on leave/end/expiry, and expire after one hour. Keep invitation/key material in memory on the browser host. No server-side transfer storage.
- Browser downloads stream to an explicitly selected save handle where available, and use a bounded Blob fallback up to 64 MiB otherwise. Never silently buffer unbounded files. Verify streamed SHA-256 before reporting completion; abort and discard partial output on failure. Mobile background continuity is not promised.
- No-argument interactive startup asks for the resource and literal target, never shell-splits a supplied program or launches a terminal without confirmation. Noninteractive startup retains help.
- Publish checksum-verified POSIX/PowerShell user-local installers, same-repository Homebrew Formula and Scoop bucket, and a bounded native `update` command. Update is explicit, uses official GitHub HTTPS, validates release/archive checksums, preserves failures and avoids overwriting unrelated files. Recipes are generated from final published asset digests to avoid checksum/revision cycles.

## Simplicity and scope

No new dependencies, workspace, service, database, account system, analytics, generic transport framework or upstream edits. Existing CLI composition, concrete Go resource types, Preact components and Tailcat adapter own the work. Raw TCP/SSH/exit nodes and browser WebRTC are not part of this change. Native Receive's existing platform restrictions remain documented.

## Acceptance

Exercise native-to-browser downloads, nested read-only directories, text round trips, browser-to-browser file/text transfers, cancellation/expiry/revocation/authentication/limits, startup navigation, installer platform/checksum failures and safe update replacement. Complete quick/full gates and package six targets, then publish a new immutable Latest release and deploy matching website assets. Verify public downloads and live UI; do not claim cross-built targets have all executed.
