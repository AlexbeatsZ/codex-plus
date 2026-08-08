# Goal

`codex-plus` 是面向 Windows 官方 OpenAI Codex 桌面应用的单一启动器。正常点击 `codex-plus.exe` 时，它必须受控关闭旧 Codex/launcher、带 CDP 参数重新启动官方应用，并把账户切换界面注入 Codex 左下角个人资料菜单。

产品只包含账户列表、异步额度、`auth.json` 导入和账户切换。不得增加独立管理页面、第二个产品可执行文件、第三方模型供应商或其他 `codex-ppp` 功能。

# Current State

- 独立 Rust 项目，产品二进制固定为 `codex-plus.exe`，版本 `0.1.0`。
- 目标环境为 Windows 11 与 Microsoft Store `OpenAI.Codex`；当前验证版本为 `26.803.5235.0`，实际进程名为 `ChatGPT.exe`。
- 设计入口：`docs/design/account-switch-lifecycle.md`。
- 已实现单启动器重启、CDP bridge、账户 vault、逐账户额度和两页注入 UI。
- `cargo test` 13 项、DOM 测试 4 项通过；发布 EXE 已构建并完成真实热注入、菜单顺序、单行布局、弹窗和额度验证。
- 发布产物：`target\release\codex-plus.exe`；SHA-256 `C22C6223CCC8511B0D1A57B073FE0A3C5C224FC4B9F9A18D015DAE74A01CD285`。

# Active Work

- 当前功能已完成，无未完成实现。
- 正常无参数启动会关闭当前 Codex，因此本任务内使用 `--attach-existing` 完成 UI/bridge 实机验收；普通入口的重启顺序由 Rust 回归测试覆盖。

# Build / Run / Test

```powershell
cargo fmt --all -- --check
cargo test
npm test
npm run check
cargo build --release
```

正常启动：`target\release\codex-plus.exe`。

开发时仅附加现有 9229 CDP、不重启 Codex：`target\release\codex-plus.exe --attach-existing`。

# Durable Lessons

- Codex `26.803.5235.0` 的个人资料菜单项外层是 `flex flex-col`；图标和标签直接作为外层子节点会换行。自定义内容必须放进一个 `w-full` 的横向内层，且实际菜单项高度应约为 30px。
- 2026-08-08 的 usage 响应中 `credits.balance` 是字符串；把它固定反序列化为浮点数会导致整个额度响应失败。
- Microsoft Store 包名是 `OpenAI.Codex`，但可执行文件和任务管理器进程仍为 `ChatGPT.exe`；进程判断必须同时核对名称和 OpenAI 安装路径。
