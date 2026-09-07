#!/bin/bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
INSTALL_ROOT="$PROJECT_ROOT/.tools/tunnel-client"
CLIENT="$INSTALL_ROOT/tunnel-client"
if [[ -x "$CLIENT" ]]; then
  exec "$CLIENT" -v
fi
ARCH="$(uname -m)"
case "$ARCH" in
  arm64) ASSET_ARCH=arm64 ;;
  x86_64) ASSET_ARCH=amd64 ;;
  *) echo "unsupported architecture: $ARCH" >&2; exit 1 ;;
esac
TMP="$(mktemp -d "${TMPDIR:-/tmp}/codex-plus-tunnel.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
JSON="$TMP/release.json"
curl -fsSL -H 'User-Agent: codex-chat-local-tools' https://api.github.com/repos/openai/tunnel-client/releases/latest -o "$JSON"
URL="$(/usr/bin/python3 - "$JSON" "$ASSET_ARCH" <<'PY'
import json, sys
p, arch = sys.argv[1:]
d = json.load(open(p))
needle = f"darwin-{arch}.zip"
for a in d.get("assets", []):
    if a.get("name", "").startswith("tunnel-client-v") and a.get("name", "").endswith(needle):
        print(a["browser_download_url"])
        break
PY
)"
if [[ -z "$URL" ]]; then
  echo "latest tunnel-client release has no darwin-$ASSET_ARCH zip" >&2
  exit 1
fi
mkdir -p "$INSTALL_ROOT"
curl -fL -H 'User-Agent: codex-chat-local-tools' "$URL" -o "$TMP/tunnel.zip"
ditto -x -k "$TMP/tunnel.zip" "$TMP/unpacked"
FOUND=""
while IFS= read -r candidate; do
  chmod 755 "$candidate"
  if "$candidate" runtimes --help >/dev/null 2>&1; then
    FOUND="$candidate"
    break
  fi
done < <(find "$TMP/unpacked" -type f -name 'tunnel-client*')
if [[ -z "$FOUND" ]]; then
  echo "archive did not contain a tunnel-client binary with runtimes support" >&2
  exit 1
fi
cp "$FOUND" "$CLIENT"
chmod 755 "$CLIENT"
exec "$CLIENT" -v
