# Goal

`codex-plus` 是面向 Windows 官方 OpenAI Codex 桌面应用的单一启动器。正常点击 `codex-plus.exe` 时，它必须受控关闭旧 Codex/launcher、启动本机多 API broker、增量核对 provider 配置、带 CDP 参数重新启动官方应用，并把账户与 API 界面注入 Codex 左下角个人资料菜单。

产品包含账户列表、异步额度、`auth.json` 导入、账户切换，以及多个 OpenAI 兼容 API、模型发现/别名/可见性和智能 provider 路由。不得增加独立管理页面、第二个产品可执行文件或其他 `codex-ppp` 功能。

# Current State

- 独立 Rust 项目，产品二进制固定为 `codex-plus.exe`，版本 `0.2.0`。
- 目标环境为 Windows 11 与 Microsoft Store `OpenAI.Codex`；当前安装/进程识别验证版本为 `26.803.10989.0`，实际进程名为 `ChatGPT.exe`。
- 设计入口：`docs/design/account-switch-lifecycle.md`、`docs/design/api-provider-routing.md`。
- 已实现单启动器重启、CDP bridge、账户 vault、逐账户额度，以及多 API CRUD、模型发现、单 broker、Responses/Chat Completions 转换和原生模型 provider 路由；路由包装已下沉到 `enqueueRequest`，覆盖普通与预热建任务。
- 当前自动化基线：`cargo test` 29 项、DOM/路由测试 10 项通过；Windows 回归测试会在后台 PowerShell 内核对 `GetConsoleWindow()` 为空。
- 发布产物：`target\release\codex-plus.exe`，6,344,192 bytes，构建时间 2026-08-12 22:00:42，SHA-256 `73FC753003A77899109E50A995D6D1ADFBE3BCEBD0B63D3FECFABAEBEAAB60CA`；从成品 EXE 反向提取到非默认 Person Swap 图标。图标重建后的当前 Codex `26.803.10989.0` 实例通过 `--attach-existing-port=59833` 接回实际 CDP renderer，日志确认 `injection.ready`，账户 `ready`、观察器、API 注入和模型路由全部就绪，本机 broker 监听 57321。先前在 Codex `26.803.5235.0` 实机触发 9229 失效监听冲突并自动回退到 64539、检查菜单顺序、账户/API 弹窗和 16px 菜单图标，DeepSeek routeId 实机对话验证仍有效。
- Windows 发布 EXE 通过 `build.rs` 嵌入 `assets/app-icon.ico`；图标以 Microsoft Fluent UI System Icons 的 Person Swap 为主体，蓝色圆角底用于和其他自制工具区分。
- 当前 Windows 用户登录自启动项 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run\CodexPlus` 为 `"C:\Users\Meta\Project\Workspaces\codex-plus\target\release\codex-plus.exe" --login-startup`；登录时只等待官方 Codex 被用户打开再接管，不主动打开 Codex。旧 BigPizzaV3 `Codex++` 1.2.x 的程序、用户数据、启动项和卸载记录已于 2026-08-09 清理，官方 `OpenAI.Codex` Store 包保留。

# Active Work

- 0.2.0 已将账户/API 菜单注入目标收紧为同一容器内同时具有原生“设置”和“退出登录”的个人资料菜单，避免顶部“编辑”菜单中的“设置”被误判并注入两个自定义选项。
- 0.2.0 已修复读取模型后表单清空、原生模型列表缺失，以及 `prewarmThreadStart` 绕过 `sendRequest` 导致 routeId 仍配对 `openai` 的问题；自动化检查、release 构建及用户实机对话均已通过。
- 0.2.0 已将账户与 API 注入 UI 调整为 Codex 原生化风格：菜单图标为 16px，弹窗使用灰阶分组面板、行分隔线、30px 紧凑按钮与蓝色强调；实机检查账户弹窗 680px 宽、12px 圆角，4 个账户无换行或溢出。
- 0.2.0 已修复 Windows 强停旧 Codex 后 9229 留下失效监听端点、导致以后所有启动都无 CDP/无注入的问题；正常启动在 stop/lock/config 后实际绑定探测 9229，被占用时改用动态本机端口，并让 launch、watchdog 和退出监测使用同一端口。
- 0.2.0 已区分登录自启与显式点击：`--login-startup` 持锁静默等待，不启动 Codex；检测到用户从官方入口打开 Codex 后释放等待锁并进入普通接管生命周期。无参数双击仍立即重启 Codex。
- 0.2.0 已统一将账户切换 helper、重启 launcher、Codex 与安装位置查询 PowerShell 作为无窗口后台子进程启动，避免切换后重新解析 Store 安装路径时闪现命令行窗口。
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

Windows 登录自启：`target\release\codex-plus.exe --login-startup`。该模式等待用户打开官方 Codex，不主动拉起应用。

开发时仅附加现有 9229 CDP、不重启 Codex：`target\release\codex-plus.exe --attach-existing`。若普通启动已回退到动态端口，使用 `target\release\codex-plus.exe --attach-existing-port=<实际端口>`。
普通启动优先使用 9229；若该地址不可绑定，会在日志 `launcher.debug_port.selected` 中记录实际回退端口。`--attach-existing` 仍只表示附加开发者显式启动的 9229 实例。

# Durable Lessons

- Codex 顶部“编辑”菜单与个人资料菜单都可能包含文字为“设置”的 `role=menuitem`；账户/API 注入不能仅匹配该文字，必须要求同一直接父容器还包含原生“退出登录”。
- Codex `26.803.5235.0` 的个人资料菜单项外层是 `flex flex-col`；图标和标签直接作为外层子节点会换行。自定义内容必须放进一个 `w-full` 的横向内层，且实际菜单项高度应约为 30px。
- Codex `26.803.5235.0` 的原生菜单图标视觉尺寸是 16px；`UsersRound` 在 20px 时比相邻图标明显抢眼。账户/API 弹窗应复用低对比灰阶分组、组内分隔线和 30px 控件，强调色跟随当前 Codex 蓝色，不使用旧版绿色后台卡片风格。
- 2026-08-08 的 usage 响应中 `credits.balance` 是字符串；把它固定反序列化为浮点数会导致整个额度响应失败。
- Microsoft Store 包名是 `OpenAI.Codex`，但可执行文件和任务管理器进程仍为 `ChatGPT.exe`；进程判断必须同时核对名称和 OpenAI 安装路径。
- Codex 自定义 provider 只接受 Responses wire API；Chat Completions 必须由本机 broker 转换。多个上游不能通过改顶层 `model_provider` 共存，必须用 routeId 在单一 `codex-plus-api` provider 内分发。
- 模型目录显示 alias，但实际 `model` 必须保留稳定 routeId；描述中再显示 API 名称与真实 model ID，避免不同 API 的同名模型冲突。
- Codex `26.803.5235.0` 的 `window.electronBridge` 不可扩展，且模型目录与任务请求绕开 window dispatch，直接走 React host runtime 中的 `AppServerRequestClient`。必须包装该 client，并刷新 `models/list` Query 缓存；bridge/window dispatch/Response patch 只能作为兼容补充，不能作为完成依据。
- `AppServerRequestClient.prewarmThreadStart` 不调用 `sendRequest`，而是直接进入 `enqueueRequest`。provider 路由必须包装 `enqueueRequest`，并在安装及模型选择改变时清除旧预热任务；否则 routeId 会和默认 `openai` provider 组合，直到 ChatGPT 账户校验时报“不支持该模型”。
- 当前 app bundle 主世界存在会遮蔽裸 `String`/`Function` 的同名绑定；注入脚本需要显式使用 `window` 原生构造器或从函数字面量捕获 `toString`，否则实机动态模块扫描会失败而测试环境仍通过。
- Windows 上旧 Codex PID 已退出并不保证其 CDP 监听端口立即可重新绑定；2026-08-09 实测 9229 可残留为 Owner PID 已不存在、HTTP 拒绝/超时但 bind 返回 `WSAEADDRINUSE (10048)` 的失效 listener。启动就绪判断必须以本机 bind/CDP target 为准，不能只等待 PID；遇到占用应回退端口，不能继续把“spawn 成功”当作可注入。
- Windows `HKCU Run` 无法区分登录触发与用户双击；登录启动命令必须显式带 `--login-startup`。等待模式不提前启动 broker 或修改配置，检测到官方 Codex 后再复用 `stop → lock → broker → config → launch → inject`，避免登录时弹出应用，同时保留官方快捷方式与无参数 EXE 的接管能力。
- release 主程序使用 Windows GUI 子系统并不意味着其后代控制台进程也会自动隐藏；无父控制台时，未设置创建标志的 `powershell.exe` 仍会自行创建可见窗口。所有内部 `Command` 都应走统一后台构造器，并在 Windows 设置 `CREATE_NO_WINDOW`。
