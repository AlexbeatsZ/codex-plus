# Goal

`codex-plus` 是面向 Windows 官方 OpenAI Codex 桌面应用的单一启动器。正常点击 `codex-plus.exe` 时，它必须受控关闭旧 Codex/launcher、启动本机多 API broker、增量核对 provider 配置、带 CDP 参数重新启动官方应用，并把账户与 API 界面注入 Codex 左下角个人资料菜单。

产品包含账户列表、异步额度、`auth.json` 导入、账户切换，以及多个 OpenAI 兼容 API、模型发现/别名/可见性和智能 provider 路由。不得增加独立管理页面、第二个产品可执行文件或其他 `codex-ppp` 功能。

# Current State

- 独立 Rust 项目，产品二进制固定为 `codex-plus.exe`，版本 `0.2.0`。
- 目标环境为 Windows 11 与 Microsoft Store `OpenAI.Codex`；当前验证版本为 `26.803.5235.0`，实际进程名为 `ChatGPT.exe`。
- 设计入口：`docs/design/account-switch-lifecycle.md`、`docs/design/api-provider-routing.md`。
- 已实现单启动器重启、CDP bridge、账户 vault、逐账户额度，以及多 API CRUD、模型发现、单 broker、Responses/Chat Completions 转换和原生模型 provider 路由；路由包装已下沉到 `enqueueRequest`，覆盖普通与预热建任务。
- 当前自动化基线：`cargo test` 25 项、DOM/路由测试 9 项通过。
- 发布产物：`target\release\codex-plus.exe`，6,276,096 bytes，构建时间 2026-08-09 02:00:36，SHA-256 `E22B29A4AB8177066BCC428CF1B82EA68E553141E7D7FBF17F2F4E1FAA79F4DB`；已在 Codex `26.803.5235.0` 的 9229 CDP 实例热注入验证账户/API 弹窗和 16px 菜单图标，先前 DeepSeek routeId 实机对话验证仍有效。

# Active Work

- 0.2.0 已修复读取模型后表单清空、原生模型列表缺失，以及 `prewarmThreadStart` 绕过 `sendRequest` 导致 routeId 仍配对 `openai` 的问题；自动化检查、release 构建及用户实机对话均已通过。
- 0.2.0 已将账户与 API 注入 UI 调整为 Codex 原生化风格：菜单图标为 16px，弹窗使用灰阶分组面板、行分隔线、30px 紧凑按钮与蓝色强调；实机检查账户弹窗 680px 宽、12px 圆角，4 个账户无换行或溢出。
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
- Codex `26.803.5235.0` 的原生菜单图标视觉尺寸是 16px；`UsersRound` 在 20px 时比相邻图标明显抢眼。账户/API 弹窗应复用低对比灰阶分组、组内分隔线和 30px 控件，强调色跟随当前 Codex 蓝色，不使用旧版绿色后台卡片风格。
- 2026-08-08 的 usage 响应中 `credits.balance` 是字符串；把它固定反序列化为浮点数会导致整个额度响应失败。
- Microsoft Store 包名是 `OpenAI.Codex`，但可执行文件和任务管理器进程仍为 `ChatGPT.exe`；进程判断必须同时核对名称和 OpenAI 安装路径。
- Codex 自定义 provider 只接受 Responses wire API；Chat Completions 必须由本机 broker 转换。多个上游不能通过改顶层 `model_provider` 共存，必须用 routeId 在单一 `codex-plus-api` provider 内分发。
- 模型目录显示 alias，但实际 `model` 必须保留稳定 routeId；描述中再显示 API 名称与真实 model ID，避免不同 API 的同名模型冲突。
- Codex `26.803.5235.0` 的 `window.electronBridge` 不可扩展，且模型目录与任务请求绕开 window dispatch，直接走 React host runtime 中的 `AppServerRequestClient`。必须包装该 client，并刷新 `models/list` Query 缓存；bridge/window dispatch/Response patch 只能作为兼容补充，不能作为完成依据。
- `AppServerRequestClient.prewarmThreadStart` 不调用 `sendRequest`，而是直接进入 `enqueueRequest`。provider 路由必须包装 `enqueueRequest`，并在安装及模型选择改变时清除旧预热任务；否则 routeId 会和默认 `openai` provider 组合，直到 ChatGPT 账户校验时报“不支持该模型”。
- 当前 app bundle 主世界存在会遮蔽裸 `String`/`Function` 的同名绑定；注入脚本需要显式使用 `window` 原生构造器或从函数字面量捕获 `toString`，否则实机动态模块扫描会失败而测试环境仍通过。
