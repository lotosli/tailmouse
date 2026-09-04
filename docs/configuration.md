# TailMouse configuration

Use `tailmouse config path` to locate the file. Defaults are the OS user configuration directory plus `tailmouse/config.toml`: `$HOME/Library/Application Support/tailmouse/config.toml` on macOS, `$XDG_CONFIG_HOME/tailmouse/config.toml` (otherwise `$HOME/.config/tailmouse/config.toml`) on Linux, and `%AppData%\tailmouse\config.toml` on Windows.

The default file may be absent. An explicitly selected missing/unreadable file, unknown field, unsupported version or invalid value is an error before network or child startup. The file must be a regular file no larger than 64 KiB. Flags override environment, which overrides TOML, which overrides built-in defaults, independently for each field.

## Version 1 TOML

The following is the complete file schema with default session/terminal values and an illustrative Web origin. Replace that origin with your own trusted HTTPS deployment; it is not a running service. CLI-only settings such as readonly, command, title and environment overrides are not TOML keys.

```toml
version = 1

[web]
base_url = "https://web.example.invalid/"

[derp]
mode = "official"
hosts = []
map_url = ""
derp_port = 443
stun_port = 3478
region_id = 900
region_code = "mouse"
region_name = "TailMouse Custom DERP"

[session]
escape_ttl = "10m"
leash_ttl = "4h"
reconnect_grace = "30s"

[leash]
scrollback_bytes = 1048576
post_exit_ttl = "10m"
start_on = "connect-or-enter"
local_input = true
```

For custom-host mode, set `mode = "custom-host"` and a nonempty `hosts` list; leave `map_url` empty. For custom-map mode, set `mode = "custom-map"` and an HTTPS `map_url`; leave `hosts` empty. If mode is omitted, a provided host list or map selects its corresponding mode. Multiple effective relay sources are rejected, including conflicts across different precedence levels. See [custom DERP](custom-derp.md).

## Environment and flags

| Environment variable     | Corresponding flag or meaning                                     |
| ------------------------ | ----------------------------------------------------------------- |
| `TAILMOUSE_CONFIG`       | `--config`: explicit file path                                    |
| `TAILMOUSE_WEB_BASE_URL` | `--web-base-url`: trusted static Web base URL                     |
| `TAILMOUSE_DERP_HOST`    | `--derp-host`: comma-separated hostnames, not URLs or IP literals |
| `TAILMOUSE_DERP_MAP_URL` | `--derp-map-url`: HTTPS DERP map URL                              |
| `TAILMOUSE_TTL`          | `--ttl`: session lifetime, overriding the selected mode's default |
| `TAILMOUSE_NO_QR`        | `--no-qr`: boolean, retaining the explicit invitation URL         |
| `TAILMOUSE_LOG`          | `info`, `quiet`, `verbose`, `debug` (verbose alias), or `json`    |

`--squeak` aliases `--verbose`. Quiet conflicts with verbose and JSON; verbose plus JSON is supported. JSON events go to stderr, with stdout retained for invitation/command output. Do not capture stdout into a shareable log: it can contain the invitation and child output. Additional diagnostics remain redacted, but are not permission to disclose terminal contents.

Use `tailmouse escape --help` or `tailmouse leash --help` for the flag inventory. A boolean can be explicitly disabled with `--flag=false`. CLI `--derp-host=` or `--derp-map-url=` can clear a lower-precedence source. The Web URL must be HTTPS except for local loopback HTTP; no credentials, query or fragment are accepted in the base URL. A public DERP map must always use HTTPS.

Durations use Go duration syntax such as `30s`, `10m` and `4h`. Escape rounds are 30-45 seconds. Session TTL zero means until host exit or mode completion; it is not an expiring invitation. Post-exit TTL zero ends retention immediately. Scrollback is 65,536-16,777,216 bytes; terminal size is bounded to 20x5-500x200. Custom region IDs are 900-999. Invalid values fail, rather than being silently clamped.

Leash's default start policy is `connect-or-enter`; `connect` waits for an accepted browser and `now` starts after invitation display. `--cwd` and repeatable `--env KEY=VALUE` apply to the original immutable command snapshot; restart does not inherit later host changes. Shell expansion is never implicit. Consult the README's current process-tree and platform limitations before using lifecycle controls.

## Exit status

| Code | Host classification                 |
| ---- | ----------------------------------- |
| 0    | Normal completion                   |
| 2    | Command or configuration error      |
| 3    | Invitation creation failure         |
| 4    | Tailcat/DERP initialization failure |
| 5    | Protocol failure                    |
| 6    | PTY/ConPTY initialization failure   |
| 7    | Child start failure                 |
| 8    | Expiry or revocation                |
| 125  | Internal/required cleanup failure   |
| 126  | Command is not executable           |
| 127  | Command was not found               |

An otherwise normal Leash completion returns the last child's exit status. A child can itself return a number in this table; inspect the redacted host diagnostic to distinguish it from a TailMouse failure. A required host cleanup failure takes precedence over a child result, without replacing an earlier host root cause. Native Windows result fields preserve unsigned 32-bit values; this is not a claim that Windows Leash is currently usable.
