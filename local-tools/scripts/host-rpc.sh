#!/bin/bash
set -euo pipefail
ROOT="${1:?workspace root is required}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ENTRY="$PROJECT_ROOT/dist/host-rpc.js"

if [[ ! -f "$ENTRY" ]]; then
  echo "dist/host-rpc.js is missing. Run npm install and npm run build first." >&2
  exit 1
fi

if [[ -z "${CODEX_PLUS_RG:-}" && -x /Applications/ChatGPT.app/Contents/Resources/rg ]]; then
  export CODEX_PLUS_RG=/Applications/ChatGPT.app/Contents/Resources/rg
fi

if command -v node >/dev/null 2>&1; then
  NODE="$(command -v node)"
elif [[ -x /opt/homebrew/bin/node ]]; then
  NODE=/opt/homebrew/bin/node
elif [[ -x /usr/local/bin/node ]]; then
  NODE=/usr/local/bin/node
elif [[ -x /Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node ]]; then
  NODE=/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node
else
  echo "node is required" >&2
  exit 1
fi

exec "$NODE" "$ENTRY" --root "$ROOT"