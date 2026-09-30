# Goal

`codex-plus` 是面向 Windows 与 macOS 官方 OpenAI Codex/ChatGPT 桌面应用的单一跨平台启动器。显式启动时，它必须确保仓库内 tool-only MCP 的 Secure MCP Tunnel managed runtime 可用、受控关闭旧 Codex/launcher、启动本机多 API broker、增量核对 provider 配置、带 CDP 参数重新启动官方应用，并把账户与 API 界面注入左下角个人资料菜单。Windows 与 Mac 的 local-tools 可同时在线；既支持为每台机器分配独立的 Tunnel ID（Windows `codex-chat-local-tools-win` 与 macOS `codex-chat-local-tools-mac`）在 ChatGPT 侧同时作为两个独立 Connector 挂载，也支持在共享/跨机器场景下通过 `windows_*` / `mac_*` 工具语义路由与 SSH `host-rpc` 协同，不增加 UI 选择器。

产品包含账户列表、异步额度、`auth.json` 导入、网页登录、账户切换/删除，多个 OpenAI 兼容 API、模型发现/别名/可见性和智能 provider 路由，以及 `local-tools/` MCP sidecar。不得增加独立管理页面、第二个产品可执行文件或其他 `codex-ppp` 功能。

# Current State

- Rust 启动器与 Node.js `local-tools/` MCP 位于同一仓库，产品二进制和 Windows 自启动入口固定为 `codex-plus.exe`，启动器版本 `0.3.1`（内嵌 local-tools 仍为 `0.3.0`）。
- 2026-09-08 持久状态已从平台用户数据目录迁入仓库根 `.codex-plus/`（Git 忽略）：`accounts/`、`providers.json`、`pending-action.json`、`launcher.lock` 与 `codex-plus.log` 均随项目目录移动，不再使用 Windows `%LOCALAPPDATA%\codex-plus`、macOS `~/Library/Application Support/codex-plus` 或 Linux `~/.local/state/codex-plus`。Windows 现有状态已完成原位迁移并以 `--attach-existing` 在 Session 1 验证账户状态、broker 与 CDP 注入继续正常。
- 目标环境为 Windows 11 与 Microsoft Store `OpenAI.Codex`；2026-09-05 当前安装/进程识别验证版本为 `26.901.4073.0`，实际进程名为 `ChatGPT.exe`。
- 2026-09-07 已验证 macOS 26.6.1 Apple Silicon：官方应用 `/Applications/ChatGPT.app` 版本 1.2026.238.5，可直接以 `Contents/MacOS/ChatGPT --remote-debugging-port=...` 启动并完成 CDP 注入；Mac release 位于 `/Users/meta/Project/Workspaces/codex-plus/target/release/codex-plus`，登录后台入口使用 LaunchAgent `com.codex-plus.launcher`，不会主动打开 ChatGPT 窗口。
- 2026-09-07 已实现双机独立 Tunnel 架构：`src/local_tools.rs` 支持从 `.env.local` 动态加载 `TUNNEL_ID` 与 `TUNNEL_ALIAS`（Windows 默认 alias `codex-chat-local-tools-win` / Tunnel ID `tunnel_6a971ae4c9c0819192f1a813a4120a88`；macOS 默认 alias `codex-chat-local-tools-mac` / Tunnel ID `tunnel_6a9e8895ebd48191bfdfcae0aed40153`）。两端不再共享单一 Tunnel，彻底避免 OpenAI control plane 随机分流；同时保留免密 SSH 远程 `host-rpc` 双向通信作为后备。
- Windows 桌面端启动闪退与 `无法停止旧 Codex/codex-plus 实例` 根因解决：此前通过 OpenSSH 后台启动的 `codex-plus` 与子进程 `ChatGPT.exe` 运行在 Windows Session 0（非交互会话），导致桌面交互会话（Session 1）用户启动时因权限不足（0x80070005 Access Denied）无法终止 Session 0 实例而报错退出。已使用提权 taskkill 清理全部 Session 0 孤儿进程，恢复在交互式 Session 1 中正常启动与附加（CDP 9229 / broker 43121 均正常）。
- 2026-09-07 已在 Platform 复核 Windows 与 macOS 两个独立 Tunnel 都同时关联默认工作区与 `Xia`。macOS `.env.local` 已改用 Platform 显示的真实 ID `tunnel_6a9e8895ebd48191bfdfcae0aed40153`，managed runtime 重新连接后远端 metadata 与本地 health/ready 均成功，不再出现原错误 ID 导致的 `401 tunnel_use_forbidden`。
- 设计入口：`docs/design/account-switch-lifecycle.md`、`docs/design/api-provider-routing.md`、`docs/design/local-tools-lifecycle.md`；MCP 的上下文同步设计见 `local-tools/docs/design/codex-context-sync.md`。
- 已实现单启动器重启、CDP bridge、账户 vault、逐账户额度，以及多 API CRUD、模型发现、单 broker、Responses/Chat Completions 转换和原生模型 provider 路由；路由包装已下沉到 `enqueueRequest`，覆盖普通与预热建任务。
- 2026-09-28 macOS Codex 界面卡顿排查发现 `--login-startup` 的旧 broker 任务跨 Codex 生命周期残留：09:49 首轮绑定 43121，10:36 再接管回退到 60263；`tokio::select!` 丢弃等待中的 `JoinHandle` 不会停止 Axum 服务。现每轮结束显式 abort/await broker，并避免同页面重注入时重复注册模型选择点击监听。2026-09-29 自启动与显式启动均使用含此修复的 release，仍报告自启动卡顿，说明 broker 残留不是充分解释。
- 2026-09-29 macOS 自启动路径另发现 LaunchAgent `ProcessType=Background` 会把低调度优先级继承给它启动的 Codex：同机隔离 Agent 对照的子进程 `PRI` 为 Background 4、Standard 20、Interactive 31。已把仓库安装脚本及本机已安装 plist 改为 `Interactive`，但未重载 job 或重启当前 Codex；下次登录后的真实 Codex 界面流畅度仍待验收。设计约束见 `docs/design/account-switch-lifecycle.md`。
- 当前自动化基线：macOS `cargo test` 55 项、DOM/路由测试 19 项、`local-tools` MCP 测试 14 项通过；新增 desktop helper 回归覆盖 loopback endpoint 与健康实例复用，Windows 回归同时核对后台 PowerShell 无控制台窗口、Codex 子进程实际继承 `BelowNormal` priority class，以及 MCP 子进程不继承 Tunnel key。2026-09-12 新增 `cdp::tests::session_fails_when_heartbeat_stops_being_answered`（假 CDP 服务停止回包时会话必须报错退出）与 3 项 `assets/bridge.js` DOM 测试。
- 2026-09-25 修复 Windows Store / MSIX 官方应用 `ChatGPT.exe`（现场版本 `OpenAI.Codex_26.917.9434.0_x64__2p2nqsd0c76g0`）启动报 `拒绝访问。(os error 5)`：根因是 WindowsApps 目录下的可执行文件设置了 NTFS Conditional ACE（`WIN://SYSAPPID Contains "OpenAI.Codex_2p2nqsd0c76g0"`），未打包普通 Win32 进程直接调用 `CreateProcessW` 启动缺少包身份声明（Claim），内核直接返回 `0x80070005`。现已实现 `CodexAppTarget` 区分 AppX 与独立可执行文件；Store 包提取 `PackageFamilyName` 构造 AUMID（`OpenAI.Codex_2p2nqsd0c76g0!App`），调用 Shell COM `IApplicationActivationManager::ActivateApplication` 传递 CDP 调试端口参数激活，通过返回的 PID 用 `OpenProcess` 获取句柄后下调为 `BelowNormal` 优先级并统一生命周期监控。实测 9229 CDP、页面注入与 `BelowNormal` 调度优先级全部闭环恢复正常。
- 2026-09-12 macOS 修复“账户弹窗永久停在正在读取本地账户…”：根因是睡眠唤醒后 launcher 保留的旧 CDP WebSocket 假存活（TCP 仍 `ESTABLISHED`、ChatGPT 接收队列堆积约 583 KB，新建连接却正常），而心跳原为单向 `Runtime.evaluate`，watchdog 永远不重连，页面侧 `codexPlusInvoke` 也没有超时。现心跳改为可确认命令（45 秒无回包判定假存活并重连重注入）、CDP 写入加 10 秒上限、页面桥 `assets/bridge.js` 增加 30 秒兜底超时并在重新注入时让上一轮挂起请求立即失败。已部署 release 并实机验收：`bridgeVersion=2`、`/accounts/list` 经页面桥返回 4 个账户、强制超时无挂起残留。
- 2026-09-12 修复 macOS LaunchAgent plist 部署漂移：`macos/install.sh` 自 2026-09-09 起已写 `AbandonProcessGroup=true`，但本机已安装的 plist 早于该提交、缺该键。临时 job 对照实测确认缺省时 `launchctl bootout` 会连子进程一起杀掉，因此 launcher 由 LaunchAgent 管理时切换 helper 会在杀掉父 launcher 后被 launchd 连带清理，事务停在中间。已重新执行 `macos/install.sh` 部署修正后的 plist。
- 2026-09-13 修复 macOS 反复索要屏幕录制权限：`target/release/codex-plus` 原为 linker-signed adhoc，designated requirement 退化成 `cdhash H"..."`，每次 `cargo build --release` 都换一个，tccd 遂视为另一个程序（实测 24 小时内 42 次 `Failed to match existing code requirement`，跨 3 个不同 cdhash），而系统设置里的开关虽然打开，管的也只是旧二进制，所以用户怎么点都没用。新增 `macos/sign.sh` 并接入 `macos/install.sh`，用本机中性机器级身份 `Local Development Code Signing` + identifier `com.codex-plus.launcher` 签名，requirement 变为与文件内容无关的 `identifier "com.codex-plus.launcher" and certificate leaf = H"6474f2..."`。二进制已重签，**需重启 launcher 后才生效，并需再授权一次**；该身份与 Sefirah 共用，重建步骤见 `~/.agents/knowledge/macos-tcc-permissions.md`。
- 2026-09-13 让"签名丢失"不再静默：此前只有部署路径（`install.sh`）会签名，`cargo build --release` 之后直接跑二进制或点 `Codex Plus.app` 都会以 adhoc 身份启动，TCC 授权随即失效且症状延迟到下一次权限请求才暴露。现新增 `macos/release.sh`（`cargo build --release` + `sign.sh` 一步到位）作为 macOS 构建入口；`Codex Plus.app` 的启动脚本在拉起二进制前先调用一次 `sign.sh`（幂等，失败不拦启动）；并新增启动自检 `runtime::warn_if_code_signature_is_unstable`，当自身 requirement 不含 `certificate leaf` 时写一条 `launcher.signature.unstable` 日志并给出修复提示。测试 52 → 54（新增 requirement 解析与"解析不出来时不得误报"两项）。已实测：故意重链成 `cdhash H"35cf0c..."` 后该告警正确触发；经 `Codex Plus.app` 启动会自动补签成稳定身份且不误报。
- 2026-09-13 行尾噪音治理：一次跨平台操作把 10 个已跟踪文件的工作区副本改成了 CRLF（仓库存 LF，`core.autocrlf` 未设置 → git 按字节比较），`git diff` 因此把 `src/main.rs` 的 282 行报成 565 行改动，而 `git diff --ignore-cr-at-eol` 证明零语义变化。已把工作区还原为 LF（其中 8 个纯噪音文件随即与 HEAD 一致、从 `git status` 消失），并在 `.gitattributes` 增加 `* text=auto`：仓库继续以 LF 存储、检出按平台原生行尾，工作区即使被改成 CRLF 也不再产生 diff。实测把 `src/main.rs` 转成 CRLF 后 `git diff --numstat` 为 0 行。
- 2026-09-13 修复 CDP 调试端口静默回退：`stop_existing_runtime` 虽已等到旧进程退出，但内核释放监听套接字与进程退出之间仍有窗口期，原 `select_debug_port` 只做**一次** bind，撞上 `AddrInUse` 就回退到随机端口并只记 `preferred_bind_error`，于是开发期的 `--attach-existing`（固定 9229）静默失效（实测出现在 launcher 重启、旧 ChatGPT 仍占 9229 时，`preferredBindError=Address already in use (os error 48)`，回退到 62724）。现改为仅对 `AddrInUse` 在有界时间内重试（15 × 200ms ≈ 3 秒），其他错误立即回退；`DebugPortSelection` 增加 `preferred_bind_attempts` 并写入 `launcher.debug_port.selected` 日志 `preferredBindAttempts`，便于判断"是否真的等过"。测试从 51 增至 52 项，新增 `debug_port_selection_waits_for_preferred_port_to_be_released` 复现"端口延迟释放"的真实时序。
- 当前 0.3.0 自启动产物为账户脚本 v8/API 脚本 v6/路由脚本 v16：`target\release\codex-plus.exe`，6,672,896 bytes。2026-09-05 已从 `main` 的 `d418af1` 正式构建，并用 `--attach-existing` 无重启部署到当前 Codex；账户 vault 使用工作区与席位共同派生的 `recordId`，允许同一 Business 工作区的不同席位并存，并会迁移旧工作区级快照。普通接管会以 `BelowNormal` 启动 Codex 根进程，登录自启先确保 local-tools runtime 可用，在一次受管 Codex 生命周期结束后重新待命，可重新接管官方更新/自重启产生的新根进程。
- Windows 发布 EXE 通过 `build.rs` 嵌入 `assets/app-icon.ico`；图标以 Microsoft Fluent UI System Icons 的 Person Swap 为主体，蓝色圆角底用于和其他自制工具区分。
- 当前 Windows 用户登录自启动项 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run\CodexPlus` 为 `"C:\Users\Meta\Project\Workspaces\codex-plus\target\release\codex-plus.exe" --login-startup`；登录时立即确保 local-tools runtime 可用，再等待官方 Codex 被用户打开接管，不主动打开 Codex。旧 BigPizzaV3 `Codex++` 1.2.x 的程序、用户数据、启动项和卸载记录已于 2026-08-09 清理，官方 `OpenAI.Codex` Store 包保留。
- `local-tools/` 已纳入仓库；正常、attach、网页登录和登录自启入口都会幂等确保本机 alias（Windows `codex-chat-local-tools-win`、macOS `codex-chat-local-tools-mac`）运行。登录自启会立即启动 MCP，但仍不会主动打开官方 Codex。Tunnel key 只从忽略的 `local-tools/.env.local` 传给 `tunnel-client`，MCP 子进程会清除相关环境变量。
- 2026-09-08 桌面控制改为 `codex-plus` 自身的交互会话 loopback helper，不再依赖 Web 侧 `computer-use` Skill，也不增加 `desktop_*` MCP schema。launcher 在 `127.0.0.1:43122` 启动/复用 helper，endpoint 记录于 `.codex-plus/desktop-endpoint.json`；现有 `windows_run_command` / `mac_run_command` 通过 `local-tools/scripts/desktop-helper.mjs` 调用。Windows 已在正式 launcher 中闭环物理像素截图、鼠标、SendInput 键盘、窗口枚举和 UIA。macOS 的 Quartz/Accessibility primitive 已验证，但正式 LaunchAgent 当前 TCC preflight 为 `postEvents=false`、`screenCapture=false`，因此输入与截图在用户批准前不得宣称可用；`desktop-helper.mjs permissions` 可只读检查，`permissions request` 仅触发系统授权请求。Web Skill 桥继续排除依赖 Codex 专属运行时的 bundled Computer Use Skill，避免假能力。
- 2026-09-03 已确认本机 Internet Settings 使用 `127.0.0.1:7897` 时，`tunnel-client` 不会自动继承该代理并会直连 OpenAI 超时；现支持从忽略的 `.env.local` 读取可选 `TUNNEL_HTTP_PROXY`，仅给 Tunnel runtime 注入 `HTTPS_PROXY`。2026-09-04 21:30 修复旧正式 EXE 重新拉起无代理 runtime 的部署漂移：保留当前 Codex 窗口，以最新正式 EXE 的 `--attach-existing` 重启 launcher 和 Tunnel；远端 metadata、完整长轮询周期无 WARN/ERROR、唯一进程及 health/ready 200 均已验证。
- 2026-09-07 已部署 `local-tools` 0.3.0：本机全局和工作区根 `AGENTS` 指令直接进入 MCP `initialize` 响应，嵌套/变更后指令仍可按需刷新；`run_command` 超时会终止子进程树并强制关闭继承管道。managed runtime 已热重载为唯一 Tunnel/Node 实例，health/ready 为 200，完整轮询周期无 WARN/ERROR，原 Codex 窗口保持响应且未重启。按用户要求未在 Chat 模式主动发起工具调用。
- 2026-09-09 `local-tools` 新增显式 `CODEX_PLUS_MCP_APPROVAL_MODE=unrestricted` 私有部署模式：默认 `standard` 仍发布真实风险提示；双端私有配置启用后，generic/Windows/macOS 的 apply-patch 与 run-command 工具均发布非只读但不触发 destructive/open-world 审批的 annotations，并在 initialize instructions 明示实际能力未受沙箱限制。单元测试、六工具 stdio metadata smoke 通过，Windows 与 macOS managed runtime 已热重载且 health/ready 为 200。
- 2026-09-14 `local-tools` 的 AI Decision facade 已同步 Todoist section-aware schema：`task_creates` / `task_updates` 暴露可选 `section` 字段，与 ROG 侧 AI Decision core 的语义分区能力保持一致；HTTP 测试同时隔离宿主 bridge 配置，并按 `CODEX_PLUS_MACHINE_ID` 判断 ROG/OMEN/Mac。回归 `local-tools` 11/11 通过。
- 2026-09-04 Tunnel 曾在保留原工作区 `a7ff583c-c893-4be2-98ab-7173e84a3f7c` 的同时关联 Business 工作区 `Xia (b9c51c7a-e7a7-40d7-9978-aa60f76fbec0)`；当时只读验收通过插件发现与 `workspace_info`。用户随后切换了 ChatGPT 小号，因此当前 Chat 侧插件连接可能断开；本轮按用户要求不在 Chat 模式测试，不能沿用旧连接结论。
- 2026-09-04 22:16 已定位并部署首次重试仍返回 502 的修复：Tunnel 的共享 stdio MCP 通道会串行处理响应，而 `run_command` 原默认 90 秒、最大 300 秒，能超过托管请求约 83 秒的截止时间；原请求超时后，立即重试仍排在未结束命令之后。同步前台命令现限制为默认 30 秒、最大 45 秒；隔离 Tunnel 代理验证了命令超时后下一次 MCP 请求可立即恢复。实际 managed runtime 已重载为 PID 10040、MCP Node PID 25856，来自当前 `local-tools/dist/cli.js`；health/ready 200、远端 metadata 复查成功，重载后的运行日志无 WARN/ERROR。

# Active Work

- 2026-10-01 新版兼容修复正在部署：Windows 两机官方包均为 `26.928.2636.0`。路由 v17 已移除旧 React 源码特征、固定 `Txt` dispatcher 和全局 `Response.json` 包装；改为能力发现 + 真实 `model/list` 往返 + 唯一原生 fork helper，更新/删除 API 同步清理 Query 缓存，失效 routeId 明确拒绝。CDP 初次模型脚本移入接收循环，避免首次 catalog binding 被 setup 等待丢弃；界面 ready 与模型 ready 分开记录。ROG 候选已验证 client/cache/model probe/fork helper 接入，自动化 56 Rust/21 renderer 通过。用户明确只配置升级，不启动/重启 Codex 或 launcher；正式版只放置文件，待用户下次自行启动生效。源码合并保留 ROG 的 `1889a1e`/`c6dba7e` 两笔 AI Decision/Todoist 提交。设计详见 `docs/design/api-provider-routing.md`、`docs/design/account-switch-lifecycle.md`。

- 同次 ROG 启动验收还发现 `.codex/config.toml` 的 `[windows] sandbox="restricted-token"` 不被官方 `26.924.6891.0` 接受，app-server 明确报只接受 `elevated`、`unelevated`、`mxc`，页面停在“正在加载登录要求…”。已仅改为非提权 `unelevated`，原配置备份与旧 EXE 同目录；不要通过删除凭据或重装解决此解析错误。重新启动后 `config/read`、`account/read`、`getAuthStatus` 均正常回包，页面进入 “Continue signing in with your browser”，浏览器登录由用户完成。

- 2026-10-01 ROG (`192.168.31.32`) 的 `26.924.6891.0` 官方包被 9 月 11 日旧 launcher 直接作为 EXE 启动，报进程没有程序包标识符。已部署 OMEN 上 `6055c3c` 对应的 9 月 25 日 Windows release；ROG 原 EXE 保存在 `.codex-plus/release-backups/20261001-package-identity/codex-plus.exe`。实测交互 Session 1 的根进程 `GetPackageFullName` 返回完整 `OpenAI.Codex_26.924.6891.0_x64__2p2nqsd0c76g0`，优先级 `BelowNormal`、主窗口 1280×820、CDP 主页面和 bridge 均可响应。ROG 源码仍停在 `c6dba7e` 且有用户未提交改动，后续重建前必须同步包激活修复，不能用旧源码覆盖已部署 EXE；GitHub HTTPS fetch 在 SSH 会话下因 wincredman 凭据访问失败，未修改凭据设置。

- 2026-09-12 mac 账户切换可靠性：已完成并部署 CDP 桥假存活修复（心跳需回包 + 写超时 + 页面桥兜底超时）与 LaunchAgent plist 漂移修复，设计见 `docs/design/account-switch-lifecycle.md`。第三项“切换后对话历史消失”经复核推翻早先结论：UI 历史来自 `$CODEX_HOME/thread_history_1.sqlite` 的物化投影，投影在 rollout 出现 `ordinal` 回退后永久停在断点，与账户切换的硬停止无因果关系（切换当秒 rollout 写入的是正常 `turn_aborted`；未结束的 turn 本身不会破坏投影）。官方无重建投影入口（`codex migrate-rollouts` 跳过已 paginated 的 thread），故未改代码，结论见 `docs/design/account-switch-lifecycle.md` 的“对话历史与投影”。任务日志：`~/.agents/macos--codex-plus-account-switch/AGENTS.md`。

- 2026-09-25 Windows Store MSIX 启动拦截与 COM 激活修复：定位并彻底解决 Windows 11 下 Store 版 Codex/ChatGPT（`OpenAI.Codex_...`）更新后启动弹窗报 `无法启动 C:\Program Files\WindowsApps\...\app\ChatGPT.exe: 拒绝访问。(os error 5)` 的故障。根因为 WindowsApps 下二进制具有 NTFS Conditional ACE（`WIN://SYSAPPID Contains ...`），普通 Win32 进程没有 AppX 身份 Claim 导致内核拦截直接创建。已重构 `src/runtime.rs`：新增 `CodexAppTarget`（区分 `Appx` 与 `Executable`）和 `CodexProcess`（统一 `Child` 与 `Handle` 抽象），通过 PowerShell 查询 `PackageFamilyName` 构造 AUMID（`OpenAI.Codex_2p2nqsd0c76g0!App`），调用 Shell COM `IApplicationActivationManager::ActivateApplication` 传入 `--remote-debugging-port` 与 `--remote-allow-origins` 进行包激活，并利用 `OpenProcess` 对返回 PID 设置 `BelowNormal` 优先级并做生命周期监测。50 项 Rust 单元测试、18 项渲染器测试与 14 项 local-tools 测试全通，实机 release 启动成功注入 CDP 9229。

- 2026-09-08 desktop helper: 新增 `src/desktop.rs`、`desktop/windows.ps1`、`desktop/macos.jxa` 与 `local-tools/scripts/desktop-helper.mjs`。Windows 使用 Per-Monitor-V2 统一截图/窗口/鼠标为物理像素坐标，并修正 x64 `SendInput.INPUT` union；macOS 状态/窗口使用 CoreGraphics、文字输入由 Rust `core-graphics` 直接发 Unicode CGEvent、Accessibility 查询仍经 System Events 并限制 UI 树遍历深度/访问量。helper 仅绑定 loopback，若已有健康 `codex-plus` 占用首选端口则复用，避免多 launcher 覆盖 endpoint；macOS 另提供 TCC preflight/request，当前正式 helper 的 PostEvent 与 Screen Capture 尚未获批。设计见 `docs/design/desktop-helper.md`。
- 2026-09-14 为 Agy/Antigravity 新增独立标准 stdio MCP `local-tools/dist/desktop-mcp-cli.js`，直接复用 codex-plus loopback desktop helper，不再通过 Codex 私有 `cua_repl`/form elicitation 桥。MCP 暴露 observe/windows/permissions/click/move/scroll/type/key/Accessibility find/action；`computer_observe` 直接返回 MCP image content，坐标输入采用截图像素并自动转换 Retina backing pixels -> Quartz points。macOS 实机 MCP smoke 已验证 10 个工具、TCC `postEvents=true`/`screenCapture=true` 与真实 screenshot image 返回；Agy `~/.gemini/config/mcp_config.json` 的 `computer-use` 已切到该 server。
- 2026-09-07 dual-tunnel architecture: 解耦 Windows 与 macOS 独立的 Secure MCP Tunnel 绑定。`src/local_tools.rs` 动态解析各端配置（Windows 默认 alias `codex-chat-local-tools-win` / ID `tunnel_6a971ae4c9c0819192f1a813a4120a88`；macOS 默认 alias `codex-chat-local-tools-mac` / ID `tunnel_6a9e8895ebd48191bfdfcae0aed40153`），单元测试 45 项全过。双端各自独立运行 Tunnel 守护进程与 MCP 实例，解决单 Tunnel 随机分流问题，使 ChatGPT Web / Desktop 端能够同时勾选并调用 Windows 与 Mac 工具。
- 2026-09-07 ChatGPT 双连接器注册完成：现有 Windows 连接器已刷新并读取到 0.3.0 的上下文同步与双机工具元数据；`Xia Business` 已创建并连接 `Codex Local Tools - Mac`（应用 ID `asdk_app_6a9ed0ec880c819188b71e492ed3887f`），详情页确认包含 `machine_info`、完整 `windows_*` / `mac_*` 路由、Codex 上下文与 Skill 同步工具，`run_command` 超时上限为 45 秒。按用户要求未从 Chat 模式主动发起工具调用。
- 2026-09-07 Windows Session 0 冲突定位与修复：排查解决 OpenSSH 后台遗留 Session 0 `codex-plus` 与 `ChatGPT.exe` 拦截桌面启动导致的 `无法停止旧 Codex/codex-plus 实例` 与闪退问题，清理孤儿进程后桌面端 ChatGPT 正常接管启动与 CDP 注入。
- 2026-09-07 multi-machine routing: `machine_info` plus symmetric `windows_*` / `mac_*` tools keep the target host deterministic even when both runtimes share one Tunnel; remote calls use passwordless SSH + stdin JSON `host-rpc`. Windows->Mac and Mac->Windows real command smokes both passed.

- 2026-09-05 已修复同一 ChatGPT Business 工作区的不同席位因共享 `tokens.account_id` 而互相覆盖：本地 CRUD、活动判断、额度和 pending switch 改用席位级散列 `recordId`，API 请求仍发送真实工作区 ID；同工作区双席位与旧 vault 自动迁移回归通过。正式 release 已无重启附加到当前 Codex；迁移时曾为回滚创建任务级 vault 副本，但误放在 `%LOCALAPPDATA%\codex-plus\backups\account-seat-migration-20260905-033703`，该副本现已清理。此类由助手为当前任务创建的备份、快照、原文件副本或回滚副本一律视为临时产物，Windows 必须放入 `%LOCALAPPDATA%\Temp\.agents\<任务名>\`，不得因用途是“备份”而写入程序、配置、项目目录或自建 `backups` 目录；只有用户明确要求长期保留或程序正式备份机制要求该位置时例外。随后导入桌面席位，运行中 `/accounts/list` 验证该 Business 工作区同时保留两个不同邮箱席位。

- 0.3.0 已把 `codex-chat-local-tools` 合并为仓库内 `local-tools/` 组件，并在正常、attach、网页登录和登录自启入口幂等启动 managed runtime；旧 runtime 已热迁移到新目录，health/ready HTTP 200、doctor 通过、stdio MCP 报告 workspace `codex-plus`，当前 Codex 通过新 release 的 attach 模式保持注入，未为迁移重启用户窗口。最终验收在外部持有 launcher 锁时停止 runtime 并执行正式 release 的 `--login-startup`：日志记录 `alreadyRunning=false` 后 runtime 恢复为唯一 ready 进程，随后因锁安全退出，证明登录入口会实际拉起 MCP 且不会产生重复实例。
- `local-tools` 0.3.0 已把本机 Codex 可见的全局与已配置工作区根 `AGENTS` 指令注入 MCP 初始化上下文，使客户端在调用工具前即可看到；嵌套目录和运行中变化继续通过 `codex_instructions` 读取。Skills 仍先暴露有界元数据用于隐式/显式匹配，再加载单个完整 `SKILL.md` 和被引用资源。OpenAI 平台内部提示词不属于同步范围。
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
- 2026-08-14 已清理状态库中 142 条明确的临时记录（子代理、CLI/exec/未知来源及一条已确认的翻译校对侧会话），活动目录由 377 条降至 307 条；当时曾为回滚创建任务级副本，但误放在 `%LOCALAPPDATA%\codex-plus\backups\thread-cleanup-20260814-195125`，该副本现已清理，今后此类回滚副本必须使用 `%LOCALAPPDATA%\Temp\.agents\<任务名>\`。正常用户任务未按项目目录批量删除。
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

macOS 构建、签名与部署（**必须先签名**，否则已授予的 TCC 权限会随 cdhash 变化失效）：

```bash
bash macos/release.sh                # 构建 + 签名一步到位；macOS 上用它代替 cargo build --release
bash macos/sign.sh                   # 只签名；幂等，已用目标身份签过就跳过
bash macos/install.sh                # 部署 LaunchAgent（内部也会调用 sign.sh）
open "macos/Codex Plus.app"          # 显式启动；启动前会自动补一次签名
launchctl kickstart "gui/$UID/com.codex-plus.launcher"   # 经 launchd 启动/重启
```

判断签名身份**只能看 `codesign -d -r-`**：adhoc 签名下 `codesign --verify --strict` 同样报
valid，分不出身份对不对。未签名启动时日志会记一条 `launcher.signature.unstable`。

Windows 登录自启：`target\release\codex-plus.exe --login-startup`。该模式等待用户打开官方 Codex，不主动拉起应用。

开发时仅附加现有 9229 CDP、不重启 Codex：`target\release\codex-plus.exe --attach-existing`。若普通启动已回退到动态端口，使用 `target\release\codex-plus.exe --attach-existing-port=<实际端口>`。
普通启动优先使用 9229；若该地址不可绑定，会在日志 `launcher.debug_port.selected` 中记录实际回退端口。`--attach-existing` 仍只表示附加开发者显式启动的 9229 实例。

# Durable Lessons

- CDP 心跳必须要求回包：macOS 睡眠唤醒后旧 WebSocket 可以长期保持 `ESTABLISHED` 却不再处理消息（发送队列与对端接收队列持续增长）。单向写入式 `Runtime.evaluate` 心跳永远拿不到失效信号，watchdog 也就永不重连，UI 会永久卡在加载态。心跳要记录命令 id 并等待同 id 回包，超时即丢弃连接重新发现 target；socket 写入同样要有上限，否则对端停止读取写满缓冲后连失活检测都运行不到。页面侧请求还需要自己的兜底超时，并在脚本重新注入时让上一轮挂起的请求立即失败。
- **`codesign --verify --strict` 通过 ≠ 签名身份正确。** 每次 `cargo build --release` 重新链接都会把已有签名换成链接器的 adhoc 签名，此时 `--verify` 依然报 valid（adhoc 签名自洽），但 designated requirement 已经退回 `cdhash H"..."`，TCC 授权随即失效。判断"是否还是目标身份"**只能看 `codesign -d -r-`** 的 `designated` 行，或比 `codesign -dvv` 的 `Authority`。构建后不签名 = 白干，且症状会延迟到下一次权限请求才暴露。
- **签名的失效是"静默且延迟"的，必须主动把它暴露出来。** 破坏签名的动作（一次重新链接）与症状出现（下一次 TCC 权限请求）之间隔着很久，靠人记住"构建后要签名"不可靠。三层兜底缺一不可：构建入口把构建与签名绑在一起（`macos/release.sh`，取代裸 `cargo build --release`）；每条启动路径在拉起二进制前补签（`Codex Plus.app` 的脚本，幂等）；运行时对自身 requirement 做自检并写 `launcher.signature.unstable` 告警。凡是"某一步必须记得做、否则很久以后才出问题"的流程，都该照这个思路处理，而不是只写在文档里。
- 监听端口的释放滞后于进程退出：`stop_existing_runtime` 等到 PID 消失后立刻 bind 首选端口仍可能拿到 `AddrInUse`，单次 bind 就回退会让"首选端口"这个约定静默失效（`--attach-existing`、文档、脚本都按 9229 写死）。这类首选端口的选择必须**只对 `AddrInUse` 做有界重试**，其他错误立即回退，并把实际尝试次数写进日志，否则问题在下游才以"端口莫名其妙变了"的形式出现。
- **adhoc 签名的程序，其 TCC 授权绑在 cdhash 上，重新编译即失效。** 未签名 / adhoc / linker-signed 的 Mach-O，designated requirement 就是 `cdhash H"<整文件哈希>"`；`cargo build --release` 一跑哈希就变，tccd 认为换了程序，于是重新索要权限。此时"已在系统设置里允许过"完全无效——那条记录绑的是旧二进制，开关确实是开的，但管的不是现在跑的这个。自签证书 + 固定 identifier 后 requirement 变成 `identifier "..." and certificate leaf = H"<证书 SHA-1>"`，与文件内容无关，重新编译不再影响授权。因此任何需要 TCC 权限（屏幕录制、辅助功能、输入监控、蓝牙）的自构建程序，都必须在**每次构建之后**签名，只在部署脚本里签一次不够。判别方法：看 tccd 日志有没有 `Failed to match existing code requirement` 并列出两个 cdhash。另注意 launcher 直接 `spawn` 官方应用时，官方应用触发的权限请求会被归责到 launcher，弹窗显示的是 launcher 的名字，不要被名字误导。详见 `~/.agents/knowledge/macos-tcc-permissions.md`。
- `launchctl bootout`（以及作业自然退出）会按 `AbandonProcessGroup` 清理同一进程组的剩余进程，缺省为 false。实测对照：缺省时子进程随作业被杀，设为 `true` 时存活。因此 macOS launcher 的 plist 必须显式 `AbandonProcessGroup=true`，否则“helper 杀掉父 launcher 后继续完成切换事务”的设计必然失败；同理，任何依赖 `launchctl` 重启 launcher 的部署都会连带重启它拉起的官方应用，需要改用 `--attach-existing` 热更新。核对部署是否生效要看**已安装**的 plist，而不是仓库里的安装脚本。

- OpenAI Secure MCP Tunnel 为 1-to-1 Connector 模型：ChatGPT Web/Desktop 将每个 Tunnel ID 视为一个独立的 Connector。如果多台机器接入同一个 Tunnel ID，OpenAI 控制平面会进行负载均衡/随机分流。要让 ChatGPT 同时清晰显示并调用 Windows 与 Mac 的工具，必须在 OpenAI Platform 为两台机器创建独立的 Tunnel ID，并在 ChatGPT 中分别添加连接器。
- Tunnel ID 必须以 Platform Tunnels 页实际显示值为准，不能从截图或转述手工重打后直接写入默认值。2026-09-07 的 macOS ID 曾把 `...e8895...` 误记成 `...e6895...`，表现为 runtime 本地 health/ready 正常但 control plane 持续 `401 tunnel_use_forbidden`。
- Windows OpenSSH 服务运行在 Session 0：通过 SSH 或服务账户启动 Windows GUI 应用或 `codex-plus` 接管进程时，进程会落在非交互的 Session 0 中无界面运行；而登录用户的桌面属于 Session 1。当用户在桌面上再次启动应用时，Session 1 普通权限无法终止 Session 0 的高权限/隔离进程，导致报 `0x80070005 拒绝访问` 或 `无法停止旧 Codex/codex-plus 实例`。严禁通过后台 SSH 启动长期托管的 GUI 接管进程，调试 Windows 桌面应用必须确保在 Session 1 下运行。
- OpenAI Tunnel 的工作区（Workspace）权限边界：在 OpenAI Platform 创建 Tunnel 时，必须确保该 Tunnel 勾选的工作区涵盖了生成 `OPENAI_API_KEY`（或 `CONTROL_PLANE_API_KEY`）的所在工作区。如果 Tunnel 仅分配给子工作区（如 Business 工作区 `Xia`），而 API Key 是在默认/个人工作区派生的，`tunnel-client` 在 control-plane 长轮询时会报 `401 tunnel_use_forbidden: Access denied: caller does not have permission to use this tunnel`。多环境使用的 Tunnel 应在后台编辑页面同时勾选关联默认工作区与目标工作区。
- A shared Tunnel can dispatch requests to either online runtime, so the runtime that receives an MCP call must never be treated as the user's intended host. Host-sensitive tools need an explicit semantic target and must route to that host locally or over SSH; keeping only generic local tools makes simultaneous Windows/Mac runtimes nondeterministic.

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
- Windows Microsoft Store (MSIX / AppX) 安装的桌面应用在 `C:\Program Files\WindowsApps\` 下具有 NTFS 条件访问控制列表（Conditional ACE：`WIN://SYSAPPID Contains "<PackageFamilyName>"`）。普通非打包 Win32 进程直接调用 `CreateProcessW` / `Command::spawn()` 会因调用令牌缺少该包 Claim 而被操作系统内核安全模型直接拦截，返回 `拒绝访问。(os error 5)`（`0x80070005`）。必须通过 Windows Shell COM 接口 `IApplicationActivationManager::ActivateApplication` 传入 Application User Model ID (`AUMID: <PackageFamilyName>!App`) 和启动参数（如 `--remote-debugging-port`）由 DCOM 系统服务代理创建具备合法包身份的进程；再通过返回的 PID 用 `OpenProcess` 获取句柄后下调为 `BELOW_NORMAL_PRIORITY_CLASS` 并监听退出。
