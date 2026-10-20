#!/bin/sh
# Install the official TailMouse executable for the current user.
set -eu
version=0.1.0-alpha.3
case "$(uname -s)" in
  Linux) platform=linux ;;
  Darwin) platform=darwin ;;
  *) printf '%s\n' 'Unsupported system. Windows users: use https://tailmouse.com/install.ps1' >&2; exit 1 ;;
esac
case "$(uname -m)" in
  x86_64|amd64) arch=amd64 ;;
  aarch64|arm64) arch=arm64 ;;
  *) printf '%s\n' 'Supported processors: x64 and ARM64.' >&2; exit 1 ;;
esac
for required in curl tar mktemp; do
  command -v "$required" >/dev/null 2>&1 || { printf 'Missing required tool: %s\n' "$required" >&2; exit 1; }
done
if command -v sha256sum >/dev/null 2>&1; then hash_command=sha256sum
elif command -v shasum >/dev/null 2>&1; then hash_command=shasum
else printf '%s\n' 'A SHA-256 tool (sha256sum or shasum) is required.' >&2; exit 1
fi
directory=${TAILMOUSE_INSTALL_DIR:-"$HOME/.local/bin"}
mkdir -p "$directory"
temporary=$(mktemp -d "$directory/.tailmouse-install.XXXXXXXX")
trap 'rm -rf "$temporary"' EXIT HUP INT TERM
archive="tailmouse_${version}_${platform}_${arch}.tar.gz"
base="https://github.com/lotosli/tailmouse/releases/download/v$version"
curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --connect-timeout 15 --max-time 120 "$base/SHA256SUMS" -o "$temporary/SHA256SUMS"
curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --connect-timeout 15 --max-time 120 "$base/$archive" -o "$temporary/archive"
expected=$(awk -v name="$archive" '$2 == name { print $1; count++ } END { if (count != 1) exit 1 }' "$temporary/SHA256SUMS")
case "$expected" in *[!0-9a-f]*|'') printf '%s\n' 'Invalid release checksum.' >&2; exit 1 ;; esac
[ "${#expected}" -eq 64 ] || { printf '%s\n' 'Invalid release checksum length.' >&2; exit 1; }
if [ "$hash_command" = sha256sum ]; then actual=$(sha256sum "$temporary/archive" | awk '{print $1}')
else actual=$(shasum -a 256 "$temporary/archive" | awk '{print $1}')
fi
[ "$actual" = "$expected" ] || { printf '%s\n' 'Checksum mismatch; existing installation was preserved.' >&2; exit 1; }
# Extract only the expected regular executable, never arbitrary archive paths.
tar -xOf "$temporary/archive" tailmouse > "$temporary/tailmouse"
[ -s "$temporary/tailmouse" ] || { printf '%s\n' 'Release executable is empty.' >&2; exit 1; }
chmod 755 "$temporary/tailmouse"
"$temporary/tailmouse" version
[ ! -L "$directory/tailmouse" ] || { printf '%s\n' 'Refusing to replace a symlink. Use its package manager or another install directory.' >&2; exit 1; }
mv -f "$temporary/tailmouse" "$directory/tailmouse"
printf 'Installed TailMouse %s in %s\n' "$version" "$directory"
if [ "$directory" = "$HOME/.local/bin" ]; then
  case ":$PATH:" in
    *":$directory:"*) ;;
    *)
      case "${SHELL:-}" in */zsh) profile="$HOME/.zshrc" ;; */bash) profile="$HOME/.bashrc" ;; *) profile="$HOME/.profile" ;; esac
      line='export PATH="$HOME/.local/bin:$PATH"'
      if [ ! -f "$profile" ] || ! grep -Fqx "$line" "$profile"; then printf '\n%s\n' "$line" >> "$profile"; fi
      printf '%s\n' 'Open a new terminal to use tailmouse by name.'
      ;;
  esac
fi
printf '%s\n' 'Run tailmouse for guided startup, or tailmouse web 8080. Upgrade later with tailmouse update.'
