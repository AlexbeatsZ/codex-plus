#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="com.codex-plus.launcher"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
BIN="$ROOT/target/release/codex-plus"
LOG="$HOME/Library/Logs/codex-plus-launchagent.log"

if [[ ! -x "$BIN" ]]; then
  echo "missing executable: $BIN" >&2
  echo "run cargo build --release first" >&2
  exit 1
fi

mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
launchctl bootout "gui/$UID" "$PLIST" >/dev/null 2>&1 || true

cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$BIN</string>
    <string>--login-startup</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>CODEX_PLUS_LOCAL_TOOLS_ROOT</key>
    <string>$ROOT/local-tools</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <false/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>AbandonProcessGroup</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$LOG</string>
  <key>StandardErrorPath</key>
  <string>$LOG</string>
</dict>
</plist>
PLIST

plutil -lint "$PLIST" >/dev/null
launchctl bootstrap "gui/$UID" "$PLIST"
echo "installed $LABEL"