# Integrate the recovered resource release

Status: accepted by the owner's 2026-10-19 instruction to integrate the normal build, complete tests and release acceptance, push source and redeploy.

## Why

The recovered native source builds and interoperates with the deployed browser, but the normal checkout still builds the legacy product. A recovery archive cannot produce a reproducible matching native/browser release. Truncated historical tests leave resource lifecycle and permission failures insufficiently checked.

## What Changes

- Restore CLI, Web, Receive and Dev from the reviewed recovery candidate and the 2026-10-16 resource PRD, preserving Escape and legacy protected Leash.
- Apply the previously authorized Tailcat update to exact upstream main `52fbad323e9d352f1febb623e0975368e9a8cbdd`, observed still current on 2026-10-19. Use Go 1.27.2 and its compatible pinned analysis dependencies.
- Build native, both Wasm transports, preview bootstrap, inventories and deployment assets from owned source. Retain recovery archives as provenance, not build inputs.
- Complete missing permission, lifecycle, terminal, configuration, HTTP and upload failure tests. Keep existing quality floors and fail-fast gates. Use exactly four representative network profiles.
- Use an init-like descendant reaper in Linux containers without a functioning PID 1 reaper, preserving production process cleanup and test assertions.
- Deploy the existing static-only Worker on tailmouse.com after local acceptance. Preserve the explicitly authorized trusted-app same-origin test configuration; it does not isolate hostile previews.

## Impact and simplicity

No new service, account system, telemetry, workspace, generic abstraction or dependency beyond the restored resource implementation and upstream-required module graph. Resource policy stays in the existing Go application; Tailcat types remain inside adapters. Preview bootstrap uses platform APIs. Existing release and Cloudflare resources are reused. Publishing browser-only recovery assets or legacy native binaries was rejected because it cannot satisfy matching release acceptance.

## Verification

Run focused tests, normal build, quick/full gates, native package and dependency-inventory verification, local DERP/browser resource acceptance and four impairment profiles. Verify remote commit reachability before deployment, then compare public manifests, asset bytes and headers with the accepted candidate. Record actual platform evidence; cross-compilation alone does not establish macOS/Windows runtime acceptance.
