# TailMouse

Share a terminal, preview a local web app, and receive files through one browser link. The host runs TailMouse; guests need only a browser. No account or guest installation is required. The Escape minigame remains available.

[Releases](https://github.com/lotosli/tailmouse/releases) · [Website and guide](https://tailmouse.com/#guide) · [Resource documentation](https://github.com/lotosli/tailmouse/blob/v0.1.0-alpha.1/docs/resource-sharing.md) · [Feedback](https://github.com/lotosli/tailmouse/issues/new)

## Download and run

**Publication pending:** the six v0.1.0-alpha.1 packages are built and verified. Public downloads are planned, but repository visibility and release uploads are still blocked by GitHub permissions. The repository remains private and the release remains a draft; the links below will work after publication.

**v0.1.0-alpha.1 is a preview release.** Choose the archive for the machine that will host the session. Guests do not download anything.

| Host platform | Processor                    | Download                                                                                                                                 |
| ------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| macOS         | Apple Silicon (M1 and newer) | [darwin_arm64.tar.gz](https://github.com/lotosli/tailmouse/releases/download/v0.1.0-alpha.1/tailmouse_0.1.0-alpha.1_darwin_arm64.tar.gz) |
| macOS         | Intel x64                    | [darwin_amd64.tar.gz](https://github.com/lotosli/tailmouse/releases/download/v0.1.0-alpha.1/tailmouse_0.1.0-alpha.1_darwin_amd64.tar.gz) |
| Linux         | x64 / AMD64                  | [linux_amd64.tar.gz](https://github.com/lotosli/tailmouse/releases/download/v0.1.0-alpha.1/tailmouse_0.1.0-alpha.1_linux_amd64.tar.gz)   |
| Linux         | ARM64 / AArch64              | [linux_arm64.tar.gz](https://github.com/lotosli/tailmouse/releases/download/v0.1.0-alpha.1/tailmouse_0.1.0-alpha.1_linux_arm64.tar.gz)   |
| Windows       | x64                          | [windows_amd64.zip](https://github.com/lotosli/tailmouse/releases/download/v0.1.0-alpha.1/tailmouse_0.1.0-alpha.1_windows_amd64.zip)     |
| Windows       | ARM64                        | [windows_arm64.zip](https://github.com/lotosli/tailmouse/releases/download/v0.1.0-alpha.1/tailmouse_0.1.0-alpha.1_windows_arm64.zip)     |

Each archive contains one executable, this README, the license and dependency notices. No Go, Node.js or Tailcat installation is needed to run it. Windows packages are experimental: **Receive, including Dev with Receive, is unsupported**. On macOS, Receive requires an APFS destination. The archives are unsigned; macOS and Windows may require approval through their normal application security controls.

Download [SHA256SUMS](https://github.com/lotosli/tailmouse/releases/download/v0.1.0-alpha.1/SHA256SUMS) and compare the archive's SHA-256 before extracting. The release also includes a CycloneDX SBOM for each archive and a source/asset manifest.

```sh
# Linux example; use the corresponding filename for your platform.
sha256sum tailmouse_0.1.0-alpha.1_linux_amd64.tar.gz
tar -xzf tailmouse_0.1.0-alpha.1_linux_amd64.tar.gz
./tailmouse version
```

On macOS, calculate the hash with `shasum -a 256 ARCHIVE`. On Windows, use `Get-FileHash .\ARCHIVE.zip -Algorithm SHA256`, extract the ZIP, and run `.\tailmouse.exe version` in PowerShell. The output should report `TailMouse 0.1.0-alpha.1` and `TMOUSE Resource protocol 2`. Put the executable in a directory on your `PATH`, or replace `tailmouse` below with `./tailmouse` or `.\tailmouse.exe`.

## First share: preview a local app

Start your app on port 8080, then run these commands on the same machine:

```sh
curl -fSso ./tailmouse-config.json https://tailmouse.com/tailmouse-config.json
tailmouse web --config ./tailmouse-config.json 8080
```

PowerShell, from the extracted Windows directory:

```powershell
Invoke-WebRequest https://tailmouse.com/tailmouse-config.json -OutFile .\tailmouse-config.json
.\tailmouse.exe web --config .\tailmouse-config.json 8080
```

Open the private sharing link on a second device and keep the host terminal running. The deployed `tailmouse.com` configuration uses the same origin for the interface and previews, so use it only with applications you trust. The same public configuration is also attached to the release as `tailmouse-config.json`.

**What does `8080` mean?** It targets `127.0.0.1:8080` on the sharing machine. A service listening on `0.0.0.0:8080` usually accepts that connection; a service bound only to a LAN or public IP does not. Use an explicit address and `--allow-remote` to authorize a non-loopback target. TailMouse shares the whole configured origin, not just an initial path. Web is a browser preview; sharing links are not HTTP endpoints for curl, webhooks or OAuth callbacks.

## Choose your resources

The examples below use the downloaded configuration file:

| Task                             | Command                                                                                         |
| -------------------------------- | ----------------------------------------------------------------------------------------------- |
| Web preview                      | `tailmouse web --config ./tailmouse-config.json 8080`                                           |
| Read-only terminal               | `tailmouse cli --config ./tailmouse-config.json --read-only -- sh`                              |
| Interactive terminal             | `tailmouse cli --config ./tailmouse-config.json -- sh`                                          |
| Receive files (Linux/macOS)      | `tailmouse receive --config ./tailmouse-config.json ./tailmouse-uploads`                        |
| Combined workspace (Linux/macOS) | `tailmouse dev --config ./tailmouse-config.json --web 5173 --receive ./tailmouse-uploads -- sh` |

Create the upload directory before using Receive. Dev combines at least two resources. Choose a shell installed on the host: for example, `sh` on Unix or `powershell.exe` on Windows. A Windows Dev session can combine `--web 5173` with `-- powershell.exe` without Receive. Run `tailmouse cli --help`, `tailmouse web --help`, `tailmouse receive --help` or `tailmouse dev --help` for all options.

For a first file transfer on Linux/macOS:

```sh
mkdir -p ./tailmouse-uploads
tailmouse receive --config ./tailmouse-config.json ./tailmouse-uploads
```

Send a small file from the guest browser and wait for **Received by host**. Check the saved name in the receipt and host folder. End sharing on the host: access ends and the confirmed file remains. Received files never execute automatically. In Dev, explicitly inserting a received path into terminal input does not press Enter.

Sessions expire after one hour by default. Ending or expiring a resource session ends its managed terminal process; an already-running web service and confirmed files remain. Closing the guest browser only disconnects that visitor, and reconnecting does not extend expiry. The default visitor limit is one. `--open` opens an ordinary visitor; use `--max-clients 2` if the host's browser and a guest both need a slot. Press `Ctrl+]` in the host terminal to open local management.

## Escape and legacy Leash

Run `tailmouse escape` and open its invitation to play. Legacy `tailmouse leash` is also retained. [Legacy CLI documentation and recordings](https://github.com/lotosli/tailmouse/blob/v0.1.0-alpha.1/docs/legacy-cli.md) describe its protected invitations, terminal controls and options separately from resource sharing.

## Preview status and boundaries

- Linux and macOS full gates have passed on the application source included in this release. Native Windows x64 and ARM64 Go tests and the 80% coverage gate have passed. The final Windows Worker fixture correction still lacks native confirmation because GitHub Actions was blocked by billing; the owner authorized direct publication with Actions skipped.
- All six archive targets have build metadata, contents, licenses and checksums verified. The extracted Linux x64 executable is run locally. Cross-compilation does not establish that every archive has run on its target OS or device. See the [release notes](https://github.com/lotosli/tailmouse/blob/v0.1.0-alpha.1/docs/releases/v0.1.0-alpha.1.md) and [acceptance evidence](https://github.com/lotosli/tailmouse/blob/v0.1.0-alpha.1/docs/evidence/resource-release-2026-10-19/README.md).
- Native Windows Receive is unsupported; macOS Receive requires APFS. Browser-to-ConPTY end-to-end acceptance, physical mobile devices and arbitrary frontend frameworks remain unverified. HTTP/WebSocket preview has documented policy and compatibility limits in the [resource guide](https://github.com/lotosli/tailmouse/blob/v0.1.0-alpha.1/docs/resource-sharing.md).
- Terminal access carries the selected process's user permissions. It is not an OS sandbox. Treat invitation links as credentials. The current same-origin test deployment does not isolate hostile preview scripts; self-hosted untrusted previews require the documented separate-origin configuration.

The browser's **Help & feedback** panel prepares an inspectable, manually copied report with build, protocol, browser family and coarse stage. Nothing is sent automatically. Do not include invitations, terminal contents, private addresses or file names in public issues.

## Build from source

Use Go 1.27.2, Node 26.8.1 and pnpm 11.25.0:

```sh
git clone --recurse-submodules https://github.com/lotosli/tailmouse.git
cd tailmouse
pnpm install --frozen-lockfile
pnpm build
```

The normal build produces `.artifacts/native/tailmouse` (`tailmouse.exe` on Windows), both source-built Wasm transports, the preview bootstrap and the browser assets in `apps/web/dist`. Tailcat is pinned to `52fbad323e9d352f1febb623e0975368e9a8cbdd`. Recovery archives are historical provenance and are not build inputs.

For development validation, run `pnpm gate:quick`, `pnpm gate` and `pnpm fuzz:smoke`. Escape and Leash each use four representative network profiles. Local `pnpm release:snapshot`, `pnpm release:sbom` and `pnpm release:verify` generate and verify artifacts without publishing them. [Tagged release instructions](https://github.com/lotosli/tailmouse/blob/v0.1.0-alpha.1/docs/development/releases.md) describe the pinned release tools and public asset publication.

TailMouse is an unofficial application built on [Tailcat](https://github.com/tailscale/tailcat), not affiliated with or endorsed by Tailscale. The host embeds Tailcat and the browser uses its Wasm transport; guests do not install the Tailcat CLI.
