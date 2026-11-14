# Goal

`codex-plus` 是面向 Windows 与 macOS 官方 OpenAI Codex/ChatGPT 桌面应用的跨平台启动器；OMEN 与 ROG 分别维护独立发布分支，每台仍只有一个启动入口。显式启动时，它必须确保仓库内 tool-only MCP 的 Secure MCP Tunnel managed runtime 可用、受控关闭旧 Codex/launcher、启动本机多 API broker、增量核对 provider 配置、带 CDP 参数重新启动官方应用，并把账户与 API 界面注入左下角个人资料菜单。Windows 与 Mac 的 local-tools 可同时在线；既支持为每台机器分配独立的 Tunnel ID（Windows `codex-chat-local-tools-win` 与 macOS `codex-chat-local-tools-mac`）在 ChatGPT 侧同时作为两个独立 Connector 挂载，也支持在共享/跨机器场景下通过 `windows_*` / `mac_*` 工具语义路由与 SSH `host-rpc` 协同，不增加 UI 选择器。

产品包含账户列表、异步额度、`auth.json` 导入、网页登录、账户切换/删除，多个 OpenAI 兼容 API、模型发现/别名/可见性和智能 provider 路由，以及 `local-tools/` MCP sidecar。不得增加独立管理页面、第二个产品可执行文件或其他 `codex-ppp` 功能。

# Current State

## 版本与部署

- 公共源码 `main` 为 0.3.14（内嵌 local-tools 0.3.0）；OMEN/ROG 渠道为 `codex/omen` / `codex/rog`，发布身份 `<版本>-omen` / `<版本>-rog`，边界见 `docs/design/host-releases.md`。Mac 使用公共 base 版。各端固定入口的实际来源以各自 `.codex-plus/release.json` 为准；文件部署不等于运行实例已加载，须用户显式启动新版 codex-plus。
- 0.3.14（2026-11-14）是架构整理与缺陷修复版：新增 `layout`（仓库路径与 `.env.local`）、`net`（代理策略与 client 缓存）、`store`（JSON 状态文件）、`http`（响应与回环 Host 校验）模块和 `assets/core.js`（页面脚本公共层，单一菜单 observer）。修复 CDP 心跳误判、CDP 失联不结束、桌面 helper 被误杀、流式请求吞掉上游错误、原生路由文件损坏导致全部 500、官方流量忽略账户池代理等。broker 与桌面 helper 改用随机令牌并校验 Host。详细见 `docs/log/2026-11.md`。
- 0.3.14 部署（2026-11-14）：Mac 固定入口已签名替换（源码 c556598），ROG 固定入口已替换为 0.3.14-rog（61699a0，旧映像在 `C:\Users\Meta\AppData\Local\Temp\.agents\codex-plus-0314\running-previous-codex-plus.exe`，进程退出后可删）。OMEN 的 0.3.14-omen（efed103）只上传了 Release，**未替换 OMEN 固定入口**：新版桌面 helper 拒绝旧固定令牌，OMEN 只部署过二进制、其 local-tools 客户端仍是旧版，需同时更新后再部署。三端运行中的进程均未重启。
- 0.3.13 及以前的逐版本历史见 `docs/log/`，以及 git 历史中 0.3.14 之前的 AGENTS.md。

## 环境

- Windows 11 + Microsoft Store `OpenAI.Codex`（进程名 `ChatGPT.exe`，须经 `IApplicationActivationManager` 以 AUMID 激活）；macOS 26 Apple Silicon，官方应用 `/Applications/ChatGPT.app`。
- 持久状态全部在仓库根 `.codex-plus/`（Git 忽略）：`accounts/`、`providers.json`、`subscription.json`、`native-gateway.json`、`native-thread-routes.json`、`broker-token`、`desktop-endpoint.json`、`codex-plus.log`（8 MB 轮转到 `.log.1`）等。
- Windows 自启：`HKCU\...\Run\CodexPlus` = `target\release\codex-plus.exe --login-startup`；macOS 自启：LaunchAgent `com.codex-plus.launcher`（`ProcessType=Interactive`、`AbandonProcessGroup=true`），二进制须用 `macos/sign.sh` 的稳定证书身份签名。
- 双机独立 Tunnel：Windows alias `codex-chat-local-tools-win` / `tunnel_6a971ae4c9c0819192f1a813a4120a88`，macOS alias `codex-chat-local-tools-mac` / `tunnel_6a9e8895ebd48191bfdfcae0aed40153`，均关联默认工作区与 `Xia`；ID 以 Platform 页显示值为准。Tunnel key 与可选 `TUNNEL_HTTP_PROXY` 只在忽略的 `local-tools/.env.local`。
- 原生网关已接管 `~/.codex/config.toml` 的 `openai_base_url`（指向本机 broker 的能力值 URL）；launcher 不在运行时，终端 CLI、IDE 扩展等读同一配置的官方客户端无法连接，恢复入口目前只有手动删除该行（见 Active Work）。

## 已实现

- 单启动器生命周期（stop → lock → broker → config → launch → inject，常驻重新接管）、CDP bridge 与注入、账户 vault（席位级 recordId）、逐账户额度、未登录入口、网页登录。
- 多 API CRUD、模型发现、单 broker、Responses/Chat Completions 转换、原生 openai 网关与手机 Remote 兼容目录、订阅账户池（顺序、保留阈值、凭据续期、自动激活）、原生 reviewer 归属、登录额度与 API 发送隔离、上下文 Token 浮窗、PDF 预览 CMap、desktop helper 与 local-tools MCP。

# Active Work

- 0.3.14 发布后各端需显式启动新版 codex-plus；从旧版升级时运行中的 Codex 会在重启后读到新的 broker 令牌。待自然观察：日志不再出现 `injection.models.pending` 误翻转与成串 `injection.target.waiting`。
- 0.3.13 实机验收待用户显式启动新版：登录额度耗尽时选择有额度的外接 API 或订阅池模型，发送一条真实消息，切回官方模型确认限制恢复。
- 订阅 API 勾选框显示修复、普通 PDF/LaTeX 预览、未登录页按钮的目视验收仍待用户在新版界面确认。
- 待决策：原生网关缺少“停用/还原 `openai_base_url`”入口（launcher 不运行时其他官方客户端不可用）。
- 待决策：OMEN 部署 0.3.14-omen 时如何同步其 local-tools（`scripts/desktop-helper.mjs` 与 `dist/`），见 Current State。
- ROG 旧常驻 launcher 映像（`...\.agents\codex-plus-upgrade-20261001\` 与 `...\.agents\codex-plus-0314\running-previous-codex-plus.exe`）待进程自然退出后清理；OMEN 有 13 个既有未提交文件，同步源码前须先处理。

# Build / Run / Test

- 订阅路由真实验收：`node scripts/verify-account-pool.mjs --binary=target/account-pool-build/debug/codex-plus --auth-dir=.codex-plus/accounts --model=<可用模型> --proxy=<HTTP代理> --app-server=<官方codex可执行文件>`；脚本只运行隔离 broker/app-server，临时凭据在 finally 清理，切勿改成生产 CODEX_HOME。无重启候选构建显式使用 `--target-dir target/account-pool-build`，签名也明确该候选路径，不调用替换正式入口的 release 脚本。

- 隔离 broker：debug 构建的 `codex-plus --broker-only [--test-config]`（必须设置隔离的 `CODEX_PLUS_STATE_DIR` 与 `CODEX_HOME`）在 stdout 打印 `{"brokerPort","brokerToken"}`；`verify-native-auto-review.mjs` / `verify-native-pool-compaction.mjs` 需通过环境变量 `CODEX_PLUS_BROKER_TOKEN` 传入该令牌。
- 修改 `assets/` 页面脚本时，测试须先 `eval` `assets/core.js`；CDP 注入顺序为 bridge → core → 其余脚本。

- PDF 预览修改额外执行 `node --test tests/pdf-preview.test.mjs`，并按 `docs/design/pdf-preview-cmaps.md` 用官方应用自己的 PDF.js 做实际渲染验证；TeX 编译成功不能替代预览验收。
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
npm run macos:test                   # 原生签名、幂等与发布失败恢复集成测试
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

- 原生目录给 cp-* 合成的模型条目决定官方客户端如何组装请求：`tool_mode=direct` / `supports_search_tool=false` 会把全部 MCP/插件工具内联进每次请求（本机约 14 万 token），窗口小于该基线时压缩永远无效、每次工具调用都压缩。排查“新任务也压缩”先看 rollout 的 `token_count.model_context_window` 与首个请求 `input_tokens`，再对照 `~/.codex/models_cache.json` 中该 slug 的条目，不要先怀疑会话串话。官方 `/models` 会在不同列表间切换，能力模板不能只依赖最后一次刷新。
- Windows 发布构建必须在固定项目源码根目录执行，可另设 Cargo target-dir；不要把临时 worktree 构建的二进制部署后再删除 worktree。`desktop_codex_task` 等运行路径仍使用编译期 `CARGO_MANIFEST_DIR`，仅账户状态发现能从正式 target 路径反推仓库根；它不能保证所有模块都不依赖编译目录。
- macOS 不能直接在登录任务的固定入口上编译后再补签：这会给登录/手动启动留下 adhoc 身份窗口，签名失败时还会丢失旧入口。先在隔离 target 构建，再签名并同文件系统原子替换；Cargo 的实际 artifact 路径必须作为签名输入，避免 `--target` 构建后误签旧产物。详见 `docs/design/macos-release.md`。
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
- Codex `26.810.4967.0` 会把 `~/.codex/sessions` 与状态库同步到本地任务目录；临时侧会话的 `ephemeral` 身份只保存在运行时集合，状态库没有对应列，重启后可能重新表现为普通用户条目。清理时必须按明确来源/会话身份筛选并同时处理 rollout、`state_5.sqlite`、`session_index.jsonl` 与 `local_thread_catalog`，不能按翻译项目目录删除正常任务；`thread/list.modelProviders` 的 null/[] 必须按当前原生版本验证，0.165 已确认 [] 才表示全 provider。
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

# Docs Index

- `docs/design/quota-routing.md`：登录额度/Reserve 与 API 发送隔离、原生模块验收及 reviewer 父渠道边界。

- `docs/design/mobile-remote-providers.md`：手机 Remote 的原生模型目录、统一 provider 网关、旧任务迁入与验收。

- `docs/design/context-usage.md`：原生上下文浮窗的输入、输出与缓存统计。
- `CONTEXT.md`：账户、订阅 API、模型路由与凭据状态术语。
- `docs/design/account-pool.md`：固定订阅 API、顺序、失败跳过、凭据续期及验收。
- `docs/design/account-switch-lifecycle.md`：手动切换、未登录入口、生命周期。
- `docs/design/api-provider-routing.md`：外部 API、统一目录与原生 provider 路由。
- `docs/design/host-releases.md`、`docs/design/macos-release.md`：渠道、签名与发布。
- `docs/design/local-tools-lifecycle.md`、`docs/design/desktop-helper.md`、`docs/design/pdf-preview-cmaps.md`：MCP、桌面与 PDF。
