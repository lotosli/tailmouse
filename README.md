# TailMouse

Let colleagues test your work without setting up your environment. One link brings a browser preview, reproduction files and an authorized terminal together. The host runs TailMouse; guests use a browser. No account is required.

[Website and guide](https://tailmouse.com/#guide) · [Release availability](https://github.com/lotosli/tailmouse/releases) · [Feedback](https://github.com/lotosli/tailmouse/issues/new)

## Private alpha status

Public resource-sharing CLI downloads are not yet available. Use the matching test build supplied by the host. A CLI that lists only `escape` and `leash` cannot run the four resource commands below.

**Source recovery in progress (17 October 2026):** this branch recovers the deployed browser from verified source maps and preserves its immutable Tailcat `52fbad323e9d352f1febb623e0975368e9a8cbdd` binaries. The corresponding resource native source, Go/Wasm bridge source, native tests and release packages are still missing from the current environment and public Git history. The native files in this checkout remain the older Escape/Leash implementation. Do not publish them as a matching resource CLI. See [recovery evidence](docs/evidence/web-recovery-2026-10-17/README.md).

## First successful share

On a machine with the matching test CLI:

```sh
tailmouse version
tailmouse receive --help
mkdir -p ./tailmouse-uploads
tailmouse receive ./tailmouse-uploads
```

Keep the host terminal running. Open its private sharing link on a second device, send one small non-sensitive file, and wait for **Received by host**. Check the saved name in the receipt and in the host folder. End sharing on the host: access ends and the confirmed file remains. Leaving the browser only disconnects that visitor.

## Choose the resources for the task

| Task                        | Command                                                        | Prerequisite                                                 |
| --------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------ |
| Browser development preview | `tailmouse web 8080`                                           | Service reachable at `127.0.0.1:8080` on the sharing machine |
| Read-only terminal          | `tailmouse cli --read-only -- sh`                              | Unix shell installed                                         |
| Interactive terminal        | `tailmouse cli -- sh`                                          | Trust the visitor with the process's user permissions        |
| Receive files               | `tailmouse receive ./tailmouse-uploads`                        | Existing writable folder                                     |
| Combined Dev workspace      | `tailmouse dev --web 5173 --receive ./tailmouse-uploads -- sh` | Running app, existing folder and Unix shell                  |

Dev combines at least two resources. A useful collaboration flow is preview → send a reproduction → explicitly insert the received path into terminal input → verify the fix in preview → end sharing. Received files never execute automatically; insertion does not press Enter.

`8080` refers to the sharing machine's loopback address. A listener on `0.0.0.0:8080` usually accepts that connection; one bound only to a LAN/public interface does not. An explicit non-loopback target requires `--allow-remote`. The whole configured origin is shared, not just an initial path. Web is a browser preview, not a public HTTP tunnel for curl, webhooks or OAuth callbacks.

Terminal access is not an OS sandbox. Sessions expire after one hour by default. Ending or expiring a resource session ends its managed terminal process; an already-running Web service and confirmed files remain. Reconnecting does not extend expiry. The default visitor limit is one; `--open` opens an ordinary visitor. Use `--max-clients 2` when both the host's browser and a guest need a slot.

## Escape remains available

Run `tailmouse escape` and open its invitation to play. Existing Escape/Leash invitations retain their browser entry. [Legacy CLI documentation and recordings](docs/legacy-cli.md) describe those older commands separately from resource sharing.

## Compatibility and feedback

The private test uses `tailmouse.com` for both interface and preview, as requested by the owner. Open only trusted apps; this configuration is not isolation for arbitrary untrusted pages. Native Linux/macOS packages and framework combinations need matching release evidence; native Windows is outside the current resource Alpha platform promise.

The browser's **Help & feedback** panel prepares an inspectable, manually copied report with build, protocol, browser family and coarse stage. Nothing is sent automatically. Do not include invitations, terminal contents, private addresses, project names or file names in public issues. [Pilot plan](docs/operations/private-alpha-pilot.md) records real task outcomes without adding telemetry.

## Work on the recovered frontend

Use the repository's pinned Node and pnpm versions, then:

```sh
pnpm install --frozen-lockfile
pnpm web:recovery-build
node tools/verify-recovery-web.mjs
```

The recovery builder verifies every reused asset against the checked-in deployment manifest and emits `.artifacts/web-recovery`. It deliberately reports that resource Wasm has not been rebuilt from source. This browser-only path does not replace `pnpm gate:quick`, `pnpm gate`, or native release acceptance. The normal source release remains blocked until the missing implementation is restored.

TailMouse is an unofficial application built on [Tailcat](https://github.com/tailscale/tailcat), not affiliated with or endorsed by Tailscale. The host embeds Tailcat and the browser uses its Wasm transport; guests do not install the Tailcat CLI. Treat invitation links as credentials.
