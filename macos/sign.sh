#!/bin/bash
# 用本机持久自签身份签名 release 二进制，使 macOS TCC 授权跨重新编译保持有效。
#
# 为什么必须签名：adhoc / linker-signed 的 Mach-O 没有可用身份，codesign 的
# designated requirement 会退化成 `cdhash H"..."`，即整个文件的哈希。每次
# `cargo build --release` 都会产生新 cdhash，tccd 便把它当成另一个程序，
# 屏幕录制 / 辅助功能 / 输入监控的既有授权全部失配并重新弹窗（用户已在系统设置里
# 明确允许过也无济于事，因为那条记录绑的是旧二进制）。
#
# 用固定证书 + 固定 identifier 签名后，requirement 变为
#   identifier "com.codex-plus.launcher" and certificate leaf = H"<证书 SHA-1>"
# 与文件内容无关，因此重新编译不会影响已授予的权限。
#
# 用法：bash macos/sign.sh [二进制路径]     默认 target/release/codex-plus
# 换证书：CODEX_PLUS_SIGN_IDENTITY="别的身份" bash macos/sign.sh
#
# 本机身份为中性机器级证书 `Local Development Code Signing`，与 Sefirah 等本机项目
# 共用同一张。共用是安全的：requirement 里的 identifier 各不相同（本项目为
# com.codex-plus.launcher），所以两个项目的 TCC 授权互相独立、不会覆盖。
# 重建该身份的步骤见 ~/.agents/knowledge/macos-tcc-permissions.md。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN="${1:-$ROOT/target/release/codex-plus}"
IDENTITY="${CODEX_PLUS_SIGN_IDENTITY:-Local Development Code Signing}"
IDENTIFIER="com.codex-plus.launcher"

if [[ ! -x "$BIN" ]]; then
  echo "missing executable: $BIN" >&2
  echo "run cargo build --release first" >&2
  exit 1
fi

identity_line="$(security find-identity -v -p codesigning | grep -F -- "\"$IDENTITY\"" | head -1 || true)"
if [[ -z "$identity_line" ]]; then
  echo "code signing identity not found or not trusted: $IDENTITY" >&2
  echo "run 'security find-identity -p codesigning' to see all identities; an identity" >&2
  echo "listed with CSSMERR_TP_NOT_TRUSTED still needs its trust setting (see" >&2
  echo "~/.agents/knowledge/macos-tcc-permissions.md), or point CODEX_PLUS_SIGN_IDENTITY" >&2
  echo "at an existing identity." >&2
  exit 1
fi
# 必须比到证书指纹：只比 identifier 会把「换了证书但 identifier 相同」误判为已签。
identity_hash="$(printf '%s\n' "$identity_line" | awk '{print tolower($2)}')"

# 已经是目标身份就不要再碰文件：就地替换会让正在运行的 launcher 映射到旧 inode。
requirement="$(codesign -d -r- "$BIN" 2>&1 || true)"
if [[ "$requirement" == *"identifier \"$IDENTIFIER\""* &&
      "$requirement" == *"certificate leaf = H\"$identity_hash\""* ]] &&
   codesign --verify --strict "$BIN" >/dev/null 2>&1; then
  echo "already signed: $BIN"
  exit 0
fi

# 先在同目录签副本再原子改名：跨文件系统的 mv 是「复制 + 删除」，会就地截断目标文件。
STAGE="$BIN.signed.$$"
trap 'rm -f "$STAGE"' EXIT

cp "$BIN" "$STAGE"
chmod +x "$STAGE"
codesign --force --timestamp=none --identifier "$IDENTIFIER" --sign "$IDENTITY" "$STAGE"
codesign --verify --strict "$STAGE"
mv -f "$STAGE" "$BIN"
trap - EXIT

echo "signed $BIN"
codesign -d -r- "$BIN" 2>&1 | grep -F 'designated =>' | sed 's/^#* */  /'
