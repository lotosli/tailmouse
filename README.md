# TailMouse

Share your terminal and local development workspace through one browser link. Let someone watch a command, help in an interactive shell, preview your app or send you reproduction files. Guests need only a browser; no client installation or account is required.

[Download v1.0.0](https://github.com/lotosli/tailmouse/releases/tag/v1.0.0) · [Website and guide](https://tailmouse.com/#guide) · [Resource documentation](https://github.com/lotosli/tailmouse/blob/v1.0.0/docs/resource-sharing.md) · [Feedback](https://github.com/lotosli/tailmouse/issues/new)

## Why TailMouse instead of using Tailcat directly?

[Tailcat](https://github.com/tailscale/tailcat) provides the encrypted transport that makes TailMouse possible. TailMouse turns it into a browser workspace for terminal collaboration and debugging a local app together.

- **Bring someone into your terminal with a link.** Share an explicitly launched shell, full-screen TUI or an installed AI CLI such as Codex or Claude Code. Choose view-only access for demonstrations or enable input for assistance. Guests work in their browser without installing an SSH client or Tailcat.
- **Keep the debugging workflow together.** A Dev workspace combines a terminal, local app preview and optional upload directory in one invitation. A visitor can inspect the app, send a reproduction file and use the terminal you shared, rather than setting up the project on their own machine.
- **Keep control on the host.** Resource sessions have expiry and visitor limits; local management lets you approve visitors, grant the single remote input seat or revoke access. Read-only permissions are enforced by the host. The native executable includes hosted defaults, so starting a share needs no configuration file.

Tailcat already includes CLI port forwarding, SSH, SFTP and an experimental browser file/text demo. Browser access, account-free use and encryption are not exclusive to TailMouse. Choose Tailcat directly for networking tools, shell pipelines or embedding its Go library; choose TailMouse for the integrated browser terminal and resource workflow above. TailMouse uses its own application protocol and is not a drop-in client for arbitrary Tailcat services.

Browser traffic uses DERP relays rather than direct peer-to-peer connections. Terminal access has the launched process's user permissions; it is not an OS sandbox or desktop sharing. AI CLI examples use programs installed and configured on the host, with no AI-provider integration. See [platform status and boundaries](#platform-status-and-boundaries).

## Quick start: share a terminal

Install on the machine that will run the terminal. Guests do not install anything.

macOS / Linux, installed for your current user:

```sh
curl -fsSL https://tailmouse.com/install.sh | sh
```

Windows PowerShell:

```powershell
irm https://tailmouse.com/install.ps1 | iex
```

The [shell installer](https://tailmouse.com/install.sh) and [PowerShell installer](https://tailmouse.com/install.ps1) can be reviewed before execution. They select x64/ARM64 automatically, verify the release archive against `SHA256SUMS` and set up a user-local executable. The shell installer may add the default directory to your shell profile; open a new terminal afterward. A custom shell destination can be selected with `TAILMOUSE_INSTALL_DIR`.

On macOS/Linux, start a shell that the guest can **watch without typing**:

```sh
tailmouse cli --read-only -- sh
```

To let the guest interact with the shell instead:

```sh
tailmouse cli -- sh
```

On Windows, use an installed shell such as PowerShell:

```powershell
tailmouse cli --read-only -- powershell.exe
# Or allow terminal input:
tailmouse cli -- powershell.exe
```

Privately send the printed sharing link to the guest and keep TailMouse running. No configuration file is required. A resource session defaults to one hour and one visitor; press `Ctrl+]` in the host terminal for local management. Ending or expiring the session terminates its managed terminal process. A guest disconnect alone leaves the process running for reconnection.

Use this for a live command demonstration, terminal assistance or an installed CLI/TUI. For example, `tailmouse cli -- codex` shares Codex when it is installed and configured on the host. Writable access carries that process's filesystem and credential authority, so grant it only to people you trust. For the separate access-code-protected terminal workflow, see [protected Leash](#protected-leash-terminal-access).

## One link for a development workspace

Keep your app running on port 5173, create a destination for reproduction files, then share a terminal, preview and upload directory together (Linux/macOS):

```sh
mkdir -p ./tailmouse-uploads
tailmouse dev --web 5173 --receive ./tailmouse-uploads -- sh
```

The guest opens one link to use the terminal, view the app and upload a reproduction file. Confirmed uploads remain in the selected directory and never execute automatically. To require host approval before admission, add `--approval manual` before `-- sh` and use `Ctrl+]` to manage visitors.

Use `--cli-read-only` before `-- sh` for a view-only terminal while keeping the other resources available. On Windows, Receive is unsupported; combine the terminal and preview with `tailmouse dev --web 5173 -- powershell.exe`. On macOS, Receive requires an APFS destination. The hosted preview configuration shares an origin with the interface, so use trusted applications only.

## Preview a local app

Start your app on port 8080, then run this command from the extracted directory on the same machine:

```sh
./tailmouse web 8080
```

PowerShell, from the extracted Windows directory:

```powershell
.\tailmouse.exe web 8080
```

Open the private sharing link on a second device and keep the host terminal running. The deployed `tailmouse.com` configuration uses the same origin for the interface and previews, so use it only with applications you trust. **No configuration file is needed with v0.1.0-alpha.2 or newer.** Hosted defaults are built into the executable.

**What does `8080` mean?** It targets `127.0.0.1:8080` on the sharing machine. A service listening on `0.0.0.0:8080` usually accepts that connection; a service bound only to a LAN or public IP does not. Use an explicit address and `--allow-remote` to authorize a non-loopback target. TailMouse shares the whole configured origin, not just an initial path. Web is a browser preview; sharing links are not HTTP endpoints for curl, webhooks or OAuth callbacks.

## Protected Leash terminal access

For a terminal invitation with a separate access code, use the protected Leash workflow. It is distinct from the resource-session commands above:

```sh
# macOS/Linux: view-only terminal with a separate access code
tailmouse leash --readonly -- sh
# Or allow input:
tailmouse leash -- sh
```

Send the invitation privately and communicate the displayed access code separately. Official protected links retain their access-code page at `link.tailmouse.com`; ordinary home and guide navigation uses `tailmouse.com`. Leash uses `--readonly`, while resource CLI uses `--read-only`.

Leash waits for a valid browser connection or local Enter before launching the saved command. Its default access lifetime is host-lived, unlike the one-hour resource default; use an explicit TTL when needed. A guest disconnect normally leaves the child running, and expiry revokes browser access without killing it by default. [Protected Leash documentation and historical recordings](https://github.com/lotosli/tailmouse/blob/v1.0.0/docs/legacy-cli.md) cover its process controls, retained output and lifecycle options.

## Choose your resources

After placing TailMouse on your `PATH`, choose the resource you want to share:

| Task                             | Command                                                        |
| -------------------------------- | -------------------------------------------------------------- |
| Read-only terminal               | `tailmouse cli --read-only -- sh`                              |
| Interactive terminal             | `tailmouse cli -- sh`                                          |
| Combined workspace (Linux/macOS) | `tailmouse dev --web 5173 --receive ./tailmouse-uploads -- sh` |
| Web preview                      | `tailmouse web 8080`                                           |
| Receive files (Linux/macOS)      | `tailmouse receive ./tailmouse-uploads`                        |
| Send one file                    | `tailmouse send report.zip`                                    |
| Read-only folder                 | `tailmouse files ./dist`                                       |
| Temporary text                   | `tailmouse text "Hello from my computer"`                      |

Create the upload directory before using Receive. Dev combines at least two resources. Choose a shell installed on the host: for example, `sh` on Unix or `powershell.exe` on Windows. A Windows Dev session can combine `--web 5173` with `-- powershell.exe` without Receive. Run `tailmouse cli --help`, `tailmouse web --help`, `tailmouse receive --help` or `tailmouse dev --help` for all options.

For a first file transfer on Linux/macOS:

```sh
mkdir -p ./tailmouse-uploads
tailmouse receive ./tailmouse-uploads
```

Send a small file from the guest browser and wait for **Received by host**. Check the saved name in the receipt and host folder. End sharing on the host: access ends and the confirmed file remains. Received files never execute automatically. In Dev, explicitly inserting a received path into terminal input does not press Enter.

Sessions expire after one hour by default. Ending or expiring a resource session ends its managed terminal process; an already-running web service and confirmed files remain. Closing the guest browser only disconnects that visitor, and reconnecting does not extend expiry. The default visitor limit is one. `--open` opens an ordinary visitor; use `--max-clients 2` if the host's browser and a guest both need a slot. Press `Ctrl+]` in the host terminal to open local management.

## Share files and text from your browser

Open [browser sharing](https://tailmouse.com/#share), select files or enter text, then privately copy the link, scan its locally generated QR code or use the device sharing sheet. Selection errors identify the affected file before starting; remove, add or clear files to correct them. Neither side needs an installation or account. Keep both pages open; closing the host page ends access. Data uses encrypted Tailcat transport rather than website-server storage. Browser sessions last one hour and allow one visitor at a time. Mobile lock/background suspension can interrupt transfers.

![Actual browser file and shared-text transfer using synthetic data](docs/media/browser-sharing.gif)

The recording shows only the receiving browser; invitations and the host’s private QR code are not recorded.

## File and text sharing

`send` exposes only its selected file; `files` offers a read-only browser rooted at the selected directory. Hidden entries, symlinks and special files are omitted; traversal is rejected. Names are limited to 180 UTF-8 bytes and paths relative to the shared root to 512 bytes. Each directory can show up to 10,000 entries in pages of 40. Downloads use the same one-hour/one-visitor defaults and configurable transfer budgets as other resources: 256 MiB per file, 1 GiB cumulative downloads, 100 attempts and two simultaneous downloads. Failed/canceled attempts consume their reserved budget. File changes during a transfer fail verification instead of reporting success.

Downloads stream to an explicitly selected save file where supported. The receiving page reports its actual browser capability before a download. Other browsers use a bounded in-memory download up to 64 MiB; larger files require a browser with a streaming save picker. Every completed download verifies its length and SHA-256. Ending sharing stops further access; already downloaded files remain on the receiving device.

`text "message"` shares a bounded UTF-8 text value; `printf 'message' | tailmouse text` reads it from stdin. With a terminal, bare `tailmouse text` starts an empty text session; type a line and press Enter to update it without changing the link. Use piped stdin or the browser for multiline text. Both sides can deliberately replace the shared value, up to 16 KiB. Visitors copy explicitly; received text is never executed, inserted into a shell or written to the clipboard automatically. Native text sessions display visitor replies on their deliberate sharing surface, while JSON diagnostics omit text. Browser text refreshes every five seconds or on request, without replacing an unsent draft. The interface shows UTF-8 capacity and the last refresh time. Text and browser-host keys are cleared when their session ends; no browser-host session survives closing its page.

## Upgrade and package managers

Run `tailmouse` for guided startup, or use the resource commands above. The wizard retries invalid menu choices, offers view-only or input-enabled terminals, and omits Receive on Windows. For alpha.2 or earlier, run the installer once or replace the extracted executable. From alpha.3 onward, upgrade standalone installations with `tailmouse update`; `tailmouse update --check` only checks the current Latest release. Failed downloads or checksum verification preserve the existing executable. On Windows the running updater may retain its previous executable in the reported recovery location until it exits.

Homebrew (macOS/Linux) and Scoop (Windows) use this repository as their tap/bucket:

```sh
brew tap lotosli/tailmouse https://github.com/lotosli/tailmouse
brew install lotosli/tailmouse/tailmouse
# later: brew upgrade tailmouse
```

```powershell
scoop bucket add tailmouse https://github.com/lotosli/tailmouse
scoop install tailmouse/tailmouse
# later: scoop update tailmouse
```

Package-manager recipes pin the published archive digests. Use the relevant package manager for upgrades. Manual archives are available below.

## Download and run

**v1.0.0** Choose the archive for the machine that will host the session. Guests do not download anything.

| Host platform | Processor                    | Download                                                                                                                 |
| ------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| macOS         | Apple Silicon (M1 and newer) | [darwin_arm64.tar.gz](https://github.com/lotosli/tailmouse/releases/download/v1.0.0/tailmouse_1.0.0_darwin_arm64.tar.gz) |
| macOS         | Intel x64                    | [darwin_amd64.tar.gz](https://github.com/lotosli/tailmouse/releases/download/v1.0.0/tailmouse_1.0.0_darwin_amd64.tar.gz) |
| Linux         | x64 / AMD64                  | [linux_amd64.tar.gz](https://github.com/lotosli/tailmouse/releases/download/v1.0.0/tailmouse_1.0.0_linux_amd64.tar.gz)   |
| Linux         | ARM64 / AArch64              | [linux_arm64.tar.gz](https://github.com/lotosli/tailmouse/releases/download/v1.0.0/tailmouse_1.0.0_linux_arm64.tar.gz)   |
| Windows       | x64                          | [windows_amd64.zip](https://github.com/lotosli/tailmouse/releases/download/v1.0.0/tailmouse_1.0.0_windows_amd64.zip)     |
| Windows       | ARM64                        | [windows_arm64.zip](https://github.com/lotosli/tailmouse/releases/download/v1.0.0/tailmouse_1.0.0_windows_arm64.zip)     |

Each archive contains one executable, this README, the license and dependency notices. No Go, Node.js or Tailcat installation is needed to run it. Windows packages are experimental: **Receive, including Dev with Receive, is unsupported**. On macOS, Receive requires an APFS destination. The archives are unsigned; macOS and Windows may require approval through their normal application security controls.

Download [SHA256SUMS](https://github.com/lotosli/tailmouse/releases/download/v1.0.0/SHA256SUMS) and compare the archive's SHA-256 before extracting. The release also includes a CycloneDX SBOM for each archive and a source/asset manifest.

```sh
# Linux example; use the corresponding filename for your platform.
sha256sum tailmouse_1.0.0_linux_amd64.tar.gz
tar -xzf tailmouse_1.0.0_linux_amd64.tar.gz
./tailmouse version
```

On macOS, calculate the hash with `shasum -a 256 ARCHIVE`. On Windows, use `Get-FileHash .\ARCHIVE.zip -Algorithm SHA256`, extract the ZIP, and run `.\tailmouse.exe version` in PowerShell. The output should report `TailMouse 1.0.0` and `TMOUSE Resource protocol 2`. Put the executable in a directory on your `PATH`, or replace `tailmouse` below with `./tailmouse` or `.\tailmouse.exe`.

## Uninstall and recover

Standalone macOS/Linux: remove the installed executable with `rm "$HOME/.local/bin/tailmouse"` (or the custom `TAILMOUSE_INSTALL_DIR` path you selected). The default installer adds `export PATH="$HOME/.local/bin:$PATH"` only when needed; remove that exact line from the indicated shell profile only if you no longer use that directory for other tools. Open a new terminal after PATH changes. Run `command -v tailmouse` to check the executable your shell finds.

Standalone Windows: close TailMouse, remove `%LOCALAPPDATA%\TailMouse\bin`, and remove that exact entry from your user PATH through Windows environment settings. `Get-Command tailmouse` identifies an unexpected older installation. Homebrew: `brew uninstall tailmouse`; optionally `brew untap lotosli/tailmouse`. Scoop: `scoop uninstall tailmouse`; optionally `scoop bucket rm tailmouse`.

A failed archive download or checksum check preserves the existing executable. Retry the official installer after fixing the reported error, or download the required version and replace only your standalone executable. A Windows updater may report a retained recovery executable; stop both processes before restoring/removing that reported file. Do not copy configuration files or unrelated binaries over an installation. Package-manager installations should recover and upgrade through their manager.

## Optional configuration

Use flags for everyday changes, such as `tailmouse web 8080 --ttl 30m` or `--approval manual`. The defaults are a one-hour session, one visitor and automatic approval.

For a custom deployment or saved preferences, `--config FILE` still accepts TOML or deployment JSON. Flags override environment variables, which override configuration files, which override defaults. Supplying either deployment origin selects custom deployment validation; Web then requires the corresponding content origin. See [resource configuration](https://github.com/lotosli/tailmouse/blob/v1.0.0/docs/resource-sharing.md#native-configuration). The optional `tailmouse-config.json` asset is for explicit configuration and older clients; normal hosted use does not need it.

## Platform status and boundaries

- The resource implementation has recorded Linux/macOS full-gate and native Windows x64/ARM64 Go evidence. Current release evidence distinguishes Linux acceptance from earlier native-platform checks; the earlier platform results are not claimed as reruns of this release. The final Windows Worker fixture correction still lacks native confirmation because GitHub Actions was blocked by billing; the owner authorized direct publication with Actions skipped.
- All six archive targets have build metadata, contents, licenses and checksums verified. The extracted Linux x64 executable is run locally. Cross-compilation does not establish that every archive has run on its target OS or device. See the [release notes](https://github.com/lotosli/tailmouse/blob/v1.0.0/docs/releases/v1.0.0.md) and [acceptance evidence](https://github.com/lotosli/tailmouse/blob/main/docs/evidence/native-release-v1.0.0/README.md).
- Native Windows Receive is unsupported; macOS Receive requires APFS. Browser-to-ConPTY end-to-end acceptance, physical mobile devices and arbitrary frontend frameworks remain unverified. HTTP/WebSocket preview has documented policy and compatibility limits in the [resource guide](https://github.com/lotosli/tailmouse/blob/v1.0.0/docs/resource-sharing.md).
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

For development validation, run `pnpm gate:quick`, `pnpm gate` and `pnpm fuzz:smoke`. Leash uses four representative network profiles. Local `pnpm release:snapshot`, `pnpm release:sbom` and `pnpm release:verify` generate and verify artifacts without publishing them. [Tagged release instructions](https://github.com/lotosli/tailmouse/blob/v1.0.0/docs/development/releases.md) describe the pinned release tools and public asset publication.

TailMouse is an unofficial application built on [Tailcat](https://github.com/tailscale/tailcat), not affiliated with or endorsed by Tailscale. The host embeds Tailcat and the browser uses its Wasm transport; guests do not install the Tailcat CLI.

The minigame was removed in 1.0 at the owner’s request. Older release artifacts remain immutable historical versions.
