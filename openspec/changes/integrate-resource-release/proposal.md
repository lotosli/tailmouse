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
- Repair native Windows failures found by release CI: explicitly initialize ConPTY standard handles under parent redirection, and reject implicit batch-script dispatch before allocation. Keep native x64/ARM64 tests and run the inexpensive terminal boundary before the full CI build.

### Windows acceptance evidence and decision

Observed on 2026-10-19: both Windows CI architectures emit child readiness into the parent test log, while ConPTY reads time out or reach EOF. Microsoft documents the same redirected-parent behavior in [terminal issue 11276](https://github.com/microsoft/terminal/issues/11276#issuecomment-923207186): `STARTF_USESTDHANDLES` with null handles prevents default parent-handle duplication. CI also observes that `CreateProcessW` accepts a batch script despite the existing no-implicit-shell test. Use the native startup flag and a case-insensitive resolved-extension check before allocation. Reject skipping native tests, changing readiness deadlines, or wrapping commands in a shell because those would violate existing terminal and literal-command requirements. No dependency, helper process or configuration surface is added. Cross-compilation is only a prerequisite; the existing native tests must verify the correction on both Windows runners.

Subsequent native execution exposes two cleanup races. A canceled job observer must leave console closure to the forced-cleanup owner, preventing a competing console-close exit status. Job accounting can also reach zero before a detached member's process handle signals complete exit. Forced cleanup therefore prevents further child creation with the job's active-process limit, retains a bounded list of identity-checked member handles, terminates the job and waits for those actual handles under the caller's existing deadline. The PID observation budget is 64 KiB; enumeration failures still force the job and return an error. Normal execution and graceful termination keep their existing limits. Reject an extra sleep or relaxed descendant assertion: neither proves cleanup. No persistent monitor, background worker, global process scan or dependency is introduced.

## Impact and simplicity

No new service, account system, telemetry, workspace, generic abstraction or dependency beyond the restored resource implementation and upstream-required module graph. Resource policy stays in the existing Go application; Tailcat types remain inside adapters. Preview bootstrap uses platform APIs. Existing release and Cloudflare resources are reused. Publishing browser-only recovery assets or legacy native binaries was rejected because it cannot satisfy matching release acceptance.

## Verification

Run focused tests, normal build, quick/full gates, native package and dependency-inventory verification, local DERP/browser resource acceptance and four impairment profiles. Verify remote commit reachability before deployment, then compare public manifests, asset bytes and headers with the accepted candidate. Record actual platform evidence; cross-compilation alone does not establish macOS/Windows runtime acceptance.
