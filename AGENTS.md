# Goal

`codex-plus` 是面向 Windows 官方 OpenAI Codex 桌面应用的单一启动器。正常点击 `codex-plus.exe` 时，它必须受控关闭旧 Codex/launcher、启动本机多 API broker、增量核对 provider 配置、带 CDP 参数重新启动官方应用，并把账户与 API 界面注入 Codex 左下角个人资料菜单。

产品包含账户列表、异步额度、`auth.json` 导入、账户切换，以及多个 OpenAI 兼容 API、模型发现/别名/可见性和智能 provider 路由。不得增加独立管理页面、第二个产品可执行文件或其他 `codex-ppp` 功能。

# Current State

- 独立 Rust 项目，产品二进制固定为 `codex-plus.exe`，版本 `0.2.0`。
- 目标环境为 Windows 11 与 Microsoft Store `OpenAI.Codex`；当前验证版本为 `26.803.5235.0`，实际进程名为 `ChatGPT.exe`。
- 设计入口：`docs/design/account-switch-lifecycle.md`、`docs/design/api-provider-routing.md`。
- 已实现单启动器重启、CDP bridge、账户 vault、逐账户额度，以及多 API CRUD、模型发现、单 broker、Responses/Chat Completions 转换和原生模型 provider 路由。
- 当前自动化基线：`cargo test` 25 项、DOM 测试 8 项通过。
- 发布产物：`target\release\codex-plus.exe`，6,263,808 bytes，构建时间 2026-08-09 00:53:43，SHA-256 `8AA3BB06483714C77CFD78294ADF66DFDD08690C07FEA970DD367DE1BA0E93DB`；已热注入 Codex `26.803.5235.0` 并验证 API bridge 与深色下拉样式加载成功。

# Active Work

- 0.2.0 已完成 release 构建、冻结 bridge 修复与实机热注入；等待用户用真实 DeepSeek Key 验证模型发现和对话。
- 跨 provider 原地切换为受控实验；不能验证 resume provider 时必须恢复并阻止发送。

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
- Codex 自定义 provider 只接受 Responses wire API；Chat Completions 必须由本机 broker 转换。多个上游不能通过改顶层 `model_provider` 共存，必须用 routeId 在单一 `codex-plus-api` provider 内分发。
- 模型目录显示 alias，但实际 `model` 必须保留稳定 routeId；描述中再显示 API 名称与真实 model ID，避免不同 API 的同名模型冲突。
- Codex `26.803.5235.0` 的 `window.electronBridge` 不可扩展；注入脚本不得向该对象新增私有字段。原始方法引用放在闭包中，冻结对象时使用 window dispatch 路由补丁。
