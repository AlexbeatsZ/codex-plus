#!/bin/bash
set -euo pipefail
ROOT="${1:?workspace root is required}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ENTRY="$PROJECT_ROOT/dist/cli.js"
if [[ ! -f "$ENTRY" ]]; then
  echo "dist/cli.js is missing. Run npm install and npm run build first." >&2
  exit 1
fi
unset CONTROL_PLANE_API_KEY OPENAI_API_KEY HTTPS_PROXY
ENV_FILE="$PROJECT_ROOT/.env.local"
if [[ -f "$ENV_FILE" ]]; then
  while IFS='=' read -r key value || [[ -n "${key:-}${value:-}" ]]; do
    key="${key//[[:space:]]/}"
    if [[ "$key" != "CODEX_PLUS_MCP_APPROVAL_MODE" ]]; then
      continue
    fi
    value="${value%$'\r'}"
    value="${value#"${value%%[![:space:]]*}"}"
    value="${value%"${value##*[![:space:]]}"}"
    if [[ ${#value} -ge 2 && (( "$value" == \"*\" ) || ( "$value" == \'*\' )) ]]; then
      value="${value:1:${#value}-2}"
    fi
    if [[ -n "$value" ]]; then
      export CODEX_PLUS_MCP_APPROVAL_MODE="$value"
    else
      unset CODEX_PLUS_MCP_APPROVAL_MODE
    fi
  done < "$ENV_FILE"
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
exec "$NODE" "$ENTRY" --root "$ROOT" --stdio
