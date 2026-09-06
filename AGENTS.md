# Goal

`codex-plus` 是面向 Windows 官方 OpenAI Codex 桌面应用的单一启动器。正常点击 `codex-plus.exe` 时，它必须确保仓库内 tool-only MCP 的 Secure MCP Tunnel managed runtime 可用、受控关闭旧 Codex/launcher、启动本机多 API broker、增量核对 provider 配置、带 CDP 参数重新启动官方应用，并把账户与 API 界面注入 Codex 左下角个人资料菜单。

产品包含账户列表、异步额度、`auth.json` 导入、网页登录、账户切换/删除，多个 OpenAI 兼容 API、模型发现/别名/可见性和智能 provider 路由，以及 `local-tools/` MCP sidecar。不得增加独立管理页面、第二个产品可执行文件或其他 `codex-ppp` 功能。

# Current State

- Rust 启动器与 Node.js `local-tools/` MCP 位于同一仓库，产品二进制和 Windows 自启动入口固定为 `codex-plus.exe`，版本 `0.3.0`。
- 目标环境为 Windows 11 与 Microsoft Store `OpenAI.Codex`；2026-09-05 当前安装/进程识别验证版本为 `26.901.4073.0`，实际进程名为 `ChatGPT.exe`。
- 设计入口：`docs/design/account-switch-lifecycle.md`、`docs/design/api-provider-routing.md`、`docs/design/local-tools-lifecycle.md`；MCP 的上下文同步设计见 `local-tools/docs/design/codex-context-sync.md`。
- 已实现单启动器重启、CDP bridge、账户 vault、逐账户额度，以及多 API CRUD、模型发现、单 broker、Responses/Chat Completions 转换和原生模型 provider 路由；路由包装已下沉到 `enqueueRequest`，覆盖普通与预热建任务。
- 当前自动化基线：`cargo test` 44 项、DOM/路由测试 15 项、`local-tools` MCP 测试 8 项通过；Windows 回归测试同时核对后台 PowerShell 无控制台窗口、Codex 子进程实际继承 `BelowNormal` priority class，以及 MCP 子进程不继承 Tunnel key。
- 当前 0.3.0 自启动产物为账户脚本 v8/API 脚本 v6/路由脚本 v16：`target\release\codex-plus.exe`，6,672,896 bytes。2026-09-05 已从 `main` 的 `d418af1` 正式构建，并用 `--attach-existing` 无重启部署到当前 Codex；账户 vault 使用工作区与席位共同派生的 `recordId`，允许同一 Business 工作区的不同席位并存，并会迁移旧工作区级快照。普通接管会以 `BelowNormal` 启动 Codex 根进程，登录自启先确保 local-tools runtime 可用，在一次受管 Codex 生命周期结束后重新待命，可重新接管官方更新/自重启产生的新根进程。
- Windows 发布 EXE 通过 `build.rs` 嵌入 `assets/app-icon.ico`；图标以 Microsoft Fluent UI System Icons 的 Person Swap 为主体，蓝色圆角底用于和其他自制工具区分。
- 当前 Windows 用户登录自启动项 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run\CodexPlus` 为 `"C:\Users\Meta\Project\Workspaces\codex-plus\target\release\codex-plus.exe" --login-startup`；登录时立即确保 local-tools runtime 可用，再等待官方 Codex 被用户打开接管，不主动打开 Codex。旧 BigPizzaV3 `Codex++` 1.2.x 的程序、用户数据、启动项和卸载记录已于 2026-08-09 清理，官方 `OpenAI.Codex` Store 包保留。
- `local-tools/` 已纳入仓库；正常、attach、网页登录和登录自启入口都会幂等确保 alias `codex-chat-local-tools` 运行。登录自启会立即启动 MCP，但仍不会主动打开官方 Codex。Tunnel key 只从忽略的 `local-tools/.env.local` 传给 `tunnel-client`，MCP 子进程会清除相关环境变量。
- 2026-09-03 已确认本机 Internet Settings 使用 `127.0.0.1:7897` 时，`tunnel-client` 不会自动继承该代理并会直连 OpenAI 超时；现支持从忽略的 `.env.local` 读取可选 `TUNNEL_HTTP_PROXY`，仅给 Tunnel runtime 注入 `HTTPS_PROXY`。2026-09-04 21:30 修复旧正式 EXE 重新拉起无代理 runtime 的部署漂移：保留当前 Codex 窗口，以最新正式 EXE 的 `--attach-existing` 重启 launcher 和 Tunnel；远端 metadata、完整长轮询周期无 WARN/ERROR、唯一进程及 health/ready 200 均已验证。
- 2026-09-07 03:06 已部署 `local-tools` 0.2.1：本机全局和工作区根 `AGENTS` 指令直接进入 MCP `initialize` 响应，嵌套/变更后指令仍可按需刷新；`run_command` 超时会终止子进程树并强制关闭继承管道。managed runtime 已热重载为 Tunnel PID 14328、Node PID 14500，health/ready 为 200，完整轮询周期无 WARN/ERROR，Codex 窗口 PID 10556 保持响应且未重启。按用户要求未在 Chat 模式主动发起工具调用。
- 2026-09-04 Tunnel 曾在保留原工作区 `a7ff583c-c893-4be2-98ab-7173e84a3f7c` 的同时关联 Business 工作区 `Xia (b9c51c7a-e7a7-40d7-9978-aa60f76fbec0)`；当时只读验收通过插件发现与 `workspace_info`。用户随后切换了 ChatGPT 小号，因此当前 Chat 侧插件连接可能断开；本轮按用户要求不在 Chat 模式测试，不能沿用旧连接结论。
- 2026-09-04 22:16 已定位并部署首次重试仍返回 502 的修复：Tunnel 的共享 stdio MCP 通道会串行处理响应，而 `run_command` 原默认 90 秒、最大 300 秒，能超过托管请求约 83 秒的截止时间；原请求超时后，立即重试仍排在未结束命令之后。同步前台命令现限制为默认 30 秒、最大 45 秒；隔离 Tunnel 代理验证了命令超时后下一次 MCP 请求可立即恢复。实际 managed runtime 已重载为 PID 10040、MCP Node PID 25856，来自当前 `local-tools/dist/cli.js`；health/ready 200、远端 metadata 复查成功，重载后的运行日志无 WARN/ERROR。

# Active Work

- 2026-09-05 已修复同一 ChatGPT Business 工作区的不同席位因共享 `tokens.account_id` 而互相覆盖：本地 CRUD、活动判断、额度和 pending switch 改用席位级散列 `recordId`，API 请求仍发送真实工作区 ID；同工作区双席位与旧 vault 自动迁移回归通过。正式 release 已无重启附加到当前 Codex；实际 vault 已先备份到 `%LOCALAPPDATA%\codex-plus\backups\account-seat-migration-20260905-033703`，再导入桌面席位，运行中 `/accounts/list` 验证该 Business 工作区同时保留两个不同邮箱席位。

- 0.3.0 已把 `codex-chat-local-tools` 合并为仓库内 `local-tools/` 组件，并在正常、attach、网页登录和登录自启入口幂等启动 managed runtime；旧 runtime 已热迁移到新目录，health/ready HTTP 200、doctor 通过、stdio MCP 报告 workspace `codex-plus`，当前 Codex 通过新 release 的 attach 模式保持注入，未为迁移重启用户窗口。最终验收在外部持有 launcher 锁时停止 runtime 并执行正式 release 的 `--login-startup`：日志记录 `alreadyRunning=false` 后 runtime 恢复为唯一 ready 进程，随后因锁安全退出，证明登录入口会实际拉起 MCP 且不会产生重复实例。
- `local-tools` 0.2.1 已把本机 Codex 可见的全局与已配置工作区根 `AGENTS` 指令注入 MCP 初始化上下文，使客户端在调用工具前即可看到；嵌套目录和运行中变化继续通过 `codex_instructions` 读取。Skills 仍先暴露有界元数据用于隐式/显式匹配，再加载单个完整 `SKILL.md` 和被引用资源。OpenAI 平台内部提示词不属于同步范围。
- `local-tools` 已将同步 `run_command` 收紧为默认 30 秒、最大 45 秒，并增加继承 stdio 的子进程回归：超时时终止整棵进程树，短暂宽限后即使 `close` 未到也强制释放管道；随后同一 MCP 连接的 `workspace_info` 必须继续成功。

- 2026-08-15 用户确认关闭/重启 Codex 可短暂改善、运行后鼠标再次周期性卡顿。现场官方 Codex 已更新为 `26.810.6296.0`，根进程仅运行约 5 分钟即持续约 134% 单核 CPU，其中一个 `AboveNormal` 线程约 65%，其余多个线程各约 7–10%；GPU、DPC、磁盘无饱和。此时没有运行中的 codex-plus、主进程没有 CDP 参数且 9229 不可达，确认复发不由 plus 注入引起。当前进程临时降为 `BelowNormal` 后仍消耗约 138% 单核，但不再以普通/更高调度优先级与桌面输入竞争。
- 0.2.0 已让 launcher 用 `BELOW_NORMAL_PRIORITY_CLASS` 创建官方 Codex，并新增真实 Windows 子进程测试；登录自启从单次 takeover 改为每次受管 Codex 结束后重新静默待命，根进程发现读取最小身份/命令行并排除 `--type=` Electron 子进程与 `codex app-server`，避免官方更新重启后脱离管理或残留子进程误触发。
- 0.2.0 已修复 launcher 常驻期间每秒 `System::new_all()` 全量采集所有进程 CPU/内存/磁盘信息导致的持续占用：普通启动现在持有 Codex 根进程 `Child` 并用 `try_wait()` 监测，只在根进程退出后确认 CDP 端点；登录等待复用轻量 `System`，每 2 秒只刷新进程名称与可执行路径；停止清理同样只刷新身份字段和目标 PID。2026-08-15 热部署前后 20 秒采样从约 31.4% 单核、38MB private 降至 0.00%、3.6MB private。
- CDP 固定健康心跳由 2 秒降至 15 秒，健康时不再重复调用 `install()`；账户/API MutationObserver 只对菜单相关 mutation 排队扫描。新增回归覆盖 100 次无关 DOM 变更不触发全菜单扫描，同时新个人资料菜单仍正确注入。
- 0.2.0 已将账户/API 菜单注入目标收紧为同一容器内同时具有原生“设置”和“退出登录”的个人资料菜单，避免顶部“编辑”菜单中的“设置”被误判并注入两个自定义选项。
- 0.2.0 已修复读取模型后表单清空、原生模型列表缺失，以及 `prewarmThreadStart` 绕过 `sendRequest` 导致 routeId 仍配对 `openai` 的问题；自动化检查、release 构建及用户实机对话均已通过。
- 0.2.0 已将账户与 API 注入 UI 调整为 Codex 原生化风格：菜单图标为 16px，弹窗使用灰阶分组面板、行分隔线、30px 紧凑按钮与蓝色强调；实机检查账户弹窗 680px 宽、12px 圆角，4 个账户无换行或溢出。
- 0.2.0 已修复 Windows 强停旧 Codex 后 9229 留下失效监听端点、导致以后所有启动都无 CDP/无注入的问题；正常启动在 stop/lock/config 后实际绑定探测 9229，被占用时改用动态本机端口，并让 launch、watchdog 和退出监测使用同一端口。
- 0.2.0 已区分登录自启与显式点击：`--login-startup` 持锁静默等待，不启动 Codex；检测到用户从官方入口打开 Codex 后释放等待锁并进入普通接管生命周期。无参数双击仍立即重启 Codex。
- 0.2.0 已统一将账户切换 helper、重启 launcher、Codex 与安装位置查询 PowerShell 作为无窗口后台子进程启动，避免切换后重新解析 Store 安装路径时闪现命令行窗口。
- 0.2.0 已修复 WSL mirrored networking/FSE 将动态范围内的固定 broker 端口 57321 标记为不可绑定、导致登录接管在 `broker` 阶段以 `WSAEACCES 10013` 退出的问题；broker 改用动态范围外的首选端口 43121，任何绑定失败都直接持有系统分配的备用 listener，并用实际端口更新配置。
- 0.2.0 已为账户列表增加非当前账户删除；Rust 层拒绝删除当前实时账户。列表底部同时提供 `auth.json` 导入和网页登录，后者用 pending action 保存当前账户、移走实时凭据、重启到原生登录页并自动捕获新账户。
- 2026-08-14 已清理状态库中 142 条明确的临时记录（子代理、CLI/exec/未知来源及一条已确认的翻译校对侧会话），活动目录由 377 条降至 307 条；可恢复备份位于 `%LOCALAPPDATA%\codex-plus\backups\thread-cleanup-20260814-195125`。正常用户任务未按项目目录批量删除。
- 路由脚本的 `thread/list.modelProviders` 已从旧空数组改为 Codex `26.810.4967.0` 原生使用的 `null` 全 provider 哨兵，并保留 `sourceKinds`、`archived` 等范围参数，避免再次放大共享会话目录。
- Codex `26.803.10989.0` 不支持已有任务跨 provider 原地切换；v16 候选改为发送前明确询问，确认后以目标 model/provider 执行 `thread/fork`，验证新任务 provider，再把本条消息发送到继承完整历史的分支并自动导航。取消或验证失败时不发送且原任务不变。2026-08-14 审阅当前 `26.810.4967.0` app.asar 后，已移除普通 fork fallback 错误使用的 `excludeTurns: true`；自动化与隔离构建通过，尚未实机验收。

# Build / Run / Test

```powershell
npm install
npm run local-tools:install
npm run local-tools:build
cargo fmt --all -- --check
cargo test
npm test
npm run check
npm run local-tools:test
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
- Codex `26.810.4967.0` 会把 `~/.codex/sessions` 与状态库同步到本地任务目录；临时侧会话的 `ephemeral` 身份只保存在运行时集合，状态库没有对应列，重启后可能重新表现为普通用户条目。清理时必须按明确来源/会话身份筛选并同时处理 rollout、`state_5.sqlite`、`session_index.jsonl` 与 `local_thread_catalog`，不能按翻译项目目录删除正常任务；`thread/list.modelProviders` 应使用官方的 `null` 哨兵而非空数组。
- Codex `26.803.10989.0` 已移除 `thread/shutdown`，且 `thread/unsubscribe` 后用不同 `modelProvider` 调用 `thread/resume` 仍返回原 provider；provider 在任务创建时固定。保留历史并跨 provider 的受支持入口是 `thread/fork`：必须先征得用户确认，同时提交目标 model/provider，读取并验证新任务后才发送和导航；失败时原任务不变并阻止发送。
- Codex `26.810.4967.0` 的原生 `fork-conversation-from-latest` 最终调用普通 `thread/fork` 时不传 `excludeTurns`；`excludeTurns: true` 只用于 side conversation。跨 provider 完整历史分支的直接 fallback 同样必须省略该字段。
- 删除账户必须在 vault 锁内重新读取实时 account ID；当前账户只禁用 UI 不够。网页登录必须先把当前实时凭据保存到 vault，再移走 `auth.json`，并在新 launcher 中捕获新登录凭据；启动失败时恢复旧文件。
- ChatGPT Business 的 `tokens.account_id` / `chatgpt_account_id` 是工作区级标识，不是席位身份；同一工作区的两个用户会共享它。vault 唯一键、当前账户判断、切换与删除必须使用工作区 ID 加 `chatgpt_account_user_id` 派生的席位级 `recordId`，额度请求头才继续使用原工作区 ID。
- 当前 app bundle 主世界存在会遮蔽裸 `String`/`Function` 的同名绑定；注入脚本需要显式使用 `window` 原生构造器或从函数字面量捕获 `toString`，否则实机动态模块扫描会失败而测试环境仍通过。
- Windows 上旧 Codex PID 已退出并不保证其 CDP 监听端口立即可重新绑定；2026-08-09 实测 9229 可残留为 Owner PID 已不存在、HTTP 拒绝/超时但 bind 返回 `WSAEADDRINUSE (10048)` 的失效 listener。启动就绪判断必须以本机 bind/CDP target 为准，不能只等待 PID；遇到占用应回退端口，不能继续把“spawn 成功”当作可注入。
- WSL mirrored networking 的 FSE/PortTracker 会跟踪 Linux 连接使用的 Windows 动态客户端端口；2026-08-14 实测 Ubuntu 1080 代理遗留的 `CLOSE-WAIT` 对端 57321 会让 Windows host 对无普通监听进程的 `127.0.0.1:57321` 绑定返回 `WSAEACCES (10013)`。本机服务首选端口应避开默认动态范围，且仍需在任何 bind 错误时直接绑定并持有端口 0 listener，再把实际端口传给消费者。
- Windows `HKCU Run` 无法区分登录触发与用户双击；登录启动命令必须显式带 `--login-startup`。等待模式不提前启动 broker 或修改配置，检测到官方 Codex 后再复用 `stop → lock → broker → config → launch → inject`，避免登录时弹出应用，同时保留官方快捷方式与无参数 EXE 的接管能力。
- `Path::canonicalize()` 在 Windows 可返回 `\\?\C:\...`；写入 `tunnel-client` 的 stdio 命令前必须去掉 extended-length 前缀并改成正斜杠，否则会形成无效的 `//?/C:/...` PowerShell 路径。
- 仓库内嵌的 `local-tools/scripts/tunnel-client.ps1` 必须先切换到组件根目录再执行客户端；managed runtime 元数据保存相对 `profile-dir`，若沿用调用者工作目录，运行实例虽健康但 `status` 会误报 profile missing。
- release 主程序使用 Windows GUI 子系统并不意味着其后代控制台进程也会自动隐藏；无父控制台时，未设置创建标志的 `powershell.exe` 仍会自行创建可见窗口。所有内部 `Command` 都应走统一后台构造器，并在 Windows 设置 `CREATE_NO_WINDOW`。
- Windows Internet Settings 中启用本地代理不代表 Go `tunnel-client` 会自动使用它；若 control-plane 日志显示直连解析地址超时而浏览器可访问 OpenAI，应通过忽略的 `.env.local` 设置 `TUNNEL_HTTP_PROXY`。启动器和维护 wrapper 都只在子进程范围映射为 `HTTPS_PROXY`，MCP 启动脚本必须在运行 Node 前清除该变量，避免 `run_command` 意外继承。
- Tunnel 的 `/healthz`、`/readyz` 和 `doctor` 不能证明 stdio MCP 正在及时响应；当前客户端会明确跳过 stdio MCP probe。共享 stdio 连接会让长时间同步工具形成队头阻塞，因此 `run_command` 的公开超时必须显著短于托管请求截止时间；本项目使用默认 30 秒、最大 45 秒，并以“超时后同连接下一请求成功”作为恢复性验收。
- Windows 上 `ChildProcess.kill()` 只结束直接 shell，继承 stdout/stderr 的后代仍可让 Node 的 `close` 永不及时到达。MCP 命令超时必须用目标 PID 终止进程树，并设置独立的强制结算宽限期；否则 health/ready 仍为 200，`initialize` 与所有后续工具却会持续返回 `client_internal` 502。
- 本机 Codex Skills 不能作为整包提示词常驻 Chat 上下文；应只在 MCP 元数据中给出有界的 `name`/`description` 触发目录，命中后读取一个 `SKILL.md`，再按引用读取资源。`allow_implicit_invocation: false` 的 skill 必须保留显式可用性但不能进入自动触发目录。
- `System::new_all()` 会采集所有进程的 CPU、内存、磁盘和路径，不能放在常驻秒级轮询中；由 launcher 自己启动的 Codex 应保留根 `Child` 句柄并用 `try_wait()`，登录前不得不发现外部 Codex 时则复用单个 `System`，用 `ProcessRefreshKind::nothing().with_exe(OnlyIfNotSet)` 只刷新身份字段。全页面 MutationObserver 同样必须先按新增/变化的菜单节点过滤，避免聊天流和终端输出把一次菜单查找放大成持续扫描。
- Codex `26.810.6296.0` 可在没有 plus 进程、没有 CDP 参数且 GPU/DPC 均空闲时，由 Electron 根 `ChatGPT.exe` 自身持续消耗约 1.3 个核心；其中热线程可为 `AboveNormal`，足以造成系统级鼠标顿挫。plus 无法修复闭源忙循环，但可用 `BELOW_NORMAL_PRIORITY_CLASS` 隔离其桌面调度影响。官方更新可能先启动无 CDP 的新根进程再结束旧受管实例，因此登录 launcher 必须在生命周期结束后重新待命，并用命令行排除 renderer/GPU/crashpad/app-server 后再次接管。
