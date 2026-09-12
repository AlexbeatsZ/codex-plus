#!/bin/bash
# macOS release 构建入口：构建 + 签名一步完成。
#
# 为什么不直接用 `cargo build --release`：链接器给二进制打的是 adhoc 签名，而
# adhoc 签名的 designated requirement 退化成 `cdhash H"..."`。重新链接后哈希就变，
# TCC 认为换了程序，于是重新索要屏幕录制 / 辅助功能等权限——而系统设置里那条
# 记录绑的是旧二进制，用户怎么点都没用。所以 macOS 上构建 release 一律走这个脚本。
#
# 用法：bash macos/release.sh [额外的 cargo 参数...]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# 该环境里的 shell 可能跑在 Rosetta 下，必须显式指定 arm64，
# 否则链接阶段 xcrun 会失败。
export PATH="$HOME/.cargo/bin:$PATH"

arch -arm64 cargo build --release "$@"
bash "$ROOT/macos/sign.sh"
