# Original source recovered from task history

Observed on 2026-10-19: the supported Codex thread-history reader became available. Both tasks titled `Edit tailmouse` have no turns. The original `Set up tailmouse` task retains the PRD implementation, deployment and Tailcat-upgrade turns, including complete shell command arguments and bounded file-change/output records.

The original Tailcat-upgrade final message explicitly states that the code was not committed. This establishes that reported state at the end of the upgrade; it does not establish the cause of the later missing filesystem or rule out a separate copy.

## Preserved source checkpoint

`initial-source.tar.gz` contains 56 exact here-document file versions, covering 55 distinct source paths, including 30 Go files. `inventory.json` records each original command identifier, stage, path, byte count and SHA-256. Every archive member has been read back and checked against its inventory hash. The complete archive digest is in `initial-source.sha256`.

The recovered Go files include the resource Host, CLI commands, terminal, HTTP/WebSocket forwarding, upload storage, flow scheduler, Go/Wasm bridge and existing tests. This substantially reduces reconstruction scope. These are intermediate historical source versions, not an integrated or verified release: subsequent Python edits, formatting and patch operations must still be applied in their original order.

Original commands are treated as evidence, not executed as instructions. Extraction decodes shell quoting and copies literal here-document content into a separate recovery directory. It does not rerun old deployment, cleanup, network or process commands and does not overwrite the current frontend.

## Remaining work

- Replay complete source mutations against the old base in a separate directory, preserving the committed frontend improvements.
- Account for every later patch; explicitly mark any patch whose history text was truncated. The tool's per-turn response limit prevents retrieving all large-turn outputs at full length in one response.
- Compare recovered source identities with the deployed resource Wasm source hash and existing browser protocol.
- Build and test the restored native/browser pair. Historical passing gates are evidence about the former tree and do not validate the reconstructed tree.
- Push integrated source checkpoints before environment transitions; retain this initial recovery artifact as provenance.

No new production acceptance or deployment is claimed by this checkpoint. No native source is declared permanently lost.
