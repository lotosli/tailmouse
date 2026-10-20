# Complete simple sharing without guest installation

Status: accepted by owner, 2026-10-20.

Evidence: upstream Tailcat main is `52fbad323e9d352f1febb623e0975368e9a8cbdd`, identical to the existing gitlink. Its documented browser listener/dialer, text/file example and read-only file service establish the underlying capabilities. Browser traffic remains DERP-relayed. TailMouse currently implements native Receive but no download, text or browser-host journey.

Decision: implement the six owner-approved journeys in the existing resource architecture, with concrete optional resources rather than a new service. The [accepted proposal](../../openspec/changes/complete-simple-sharing/proposal.md) records protocol, lifetime, filesystem and installation boundaries. Using raw SFTP/forward commands would require guest tooling; a cloud file service would add persistence and operational scope. Neither satisfies the intended browser-only flow as directly as the existing Wasm transport.

Outcome: implementation and complete Linux gate accepted on `b84ffc7`; a separately recorded UI-only supplement passes focused checks and real transfer acceptance. Immutable tagged packaging, public download verification, generated recipes and deployment are the remaining release steps. Preserve actual source bindings in the alpha.3 evidence.
