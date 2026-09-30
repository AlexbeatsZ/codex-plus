# 账户切换与注入生命周期

## 产品边界

`codex-plus.exe` 是唯一产品入口。所有操作都发生在 Codex 注入窗口内；内部 `--apply-pending-action`、`--attach-existing` 与 `--login-startup` 仍由同一个二进制提供，不构成第二产品或管理界面。

## 登录自启

- Windows 当前用户登录启动项使用 `codex-plus.exe --login-startup`，不能使用无参数入口。
- 进入 launcher 等待循环前先幂等确保 `local-tools` managed runtime 可用；该 sidecar 启动不应打开 Codex 窗口，失败只记录日志且不阻断后续账户/注入生命周期。
- 登录模式先获取 launcher 锁并静默等待，不启动 broker、不修改配置，也不主动打开 Codex；若已有 launcher 持锁则直接退出。
- 用户之后从官方入口打开 Codex 时，登录模式检测到受支持的 OpenAI 进程，释放等待锁，再进入与普通启动相同的 `stop → lock → broker → config → launch → inject` 生命周期。
- 接管的 Codex 会以 Windows `BelowNormal` priority class 启动，避免官方 Electron 主进程出现持续 CPU 忙循环时以普通或更高线程优先级阻塞桌面输入；该设置仅作用于本次 Codex 进程树，不修改系统全局调度配置。
- 一次受管 Codex 生命周期结束后，登录模式必须重新获取等待锁并回到静默监测；官方应用更新或自重启产生的新根进程也要再次接管。根进程发现必须排除带 `--type=` 的 Electron 子进程和 `codex app-server`，避免残留 crashpad/renderer 触发无意义重启。
- 用户直接双击无参数 EXE 时，仍立即执行普通启动；它会停止等待中的登录实例，因此不会被后台 monitor 阻塞。
- macOS LaunchAgent 必须设置 `AbandonProcessGroup=true`。账户 helper 是 launcher 的子进程，但切换事务会主动停止父 launcher；若由 `launchd` 默认管理整个进程组，父进程退出时 helper 也会被清理，事务会停在 `runtime.stop.started`，留下 `pending-action.json` 且无法重新拉起 launcher。
- macOS LaunchAgent 必须使用 `ProcessType=Interactive`：登录模式虽然多数时间只是后台等待，但它会直接派生官方 Codex GUI 进程。`Background` 资源策略会继承到子进程，令官方应用以后台优先级运行；不能只把启动器按后台任务分类。修改已安装 plist 后须等下次登录或重新加载该 job 才会影响 `launchd` 已持有的配置。

## 普通启动

1. 结束当前 EXE 的旧实例、已知旧 launcher 名称 `codex-plus-plus`，以及属于 OpenAI Codex/ChatGPT 安装的 `ChatGPT.exe`/`Codex.exe`；排除当前 PID 并核对目标路径。
2. 确认目标进程退出后获取 `%LOCALAPPDATA%\codex-plus\launcher.lock` 独占锁。
3. 启动本机 API broker，并增量核对 Codex provider 配置；详见 `api-provider-routing.md`。
4. 解析 Microsoft Store OpenAI 包或受支持的独立安装路径；优先以 `--remote-debugging-port=9229` 启动。若旧进程退出后 9229 仍无法在本机绑定（包括 Windows 遗留的失效监听端点），自动选择一个空闲本机端口，并让启动、注入 watchdog 与退出监测全程使用同一端口。
5. 选择主 `app://-/index.html` target，安装 CDP binding、账户/API UI、模型目录和路由脚本。
6. launcher 保持运行；target 重建或连接丢失时重新发现并注入。常驻退出监测持有本次启动的 Codex 根进程句柄，根进程存活时不得周期性枚举全机进程或探测 CDP；只有根进程退出后才用 CDP 端点确认是否仍有接管后的 Codex 实例。登录自启等待模式可枚举进程，但必须复用轻量 monitor、只刷新名称、可执行路径和一次性命令行，并使用低频轮询。

注入 observer 只响应新增或变化的原生菜单节点；聊天流、终端输出和其他无关 DOM 变化不得触发全页面菜单扫描。CDP 健康心跳只在 observer/style 缺失时重新安装注入，不应把健康检查本身变成固定频率的 DOM 扫描。

macOS 睡眠唤醒后，launcher 已建立的 CDP WebSocket 会长期保持 `ESTABLISHED`，但渲染器不再处理其中的消息：launcher 侧发送队列持续增长，ChatGPT 侧接收队列堆积（现场实测约 583 KB）。如果心跳只是 `Runtime.evaluate` 单向写入，watchdog 永远收不到断开事件，旧 socket 会一直存在，账户弹窗就会永久停在“正在读取本地账户…”，只能靠重启应用恢复。因此：

- 心跳必须是可确认的命令，发送时记录命令 id，收到同 id 的回包才算本轮健康。
- 45 秒内没有回包即判定连接假存活，结束本次会话；由 watchdog 丢弃旧 socket、重新发现 target 并重新注入脚本。重新注入是幂等的：`bridge.js`、`renderer.js`、`api-providers.js`、`model-routing.js` 都有版本守卫，不会重建已挂载的 UI。
- 心跳间隔仍为 15 秒，只做极轻量 evaluate，不引入固定频率的 DOM 扫描。
- socket 写入也要有 10 秒上限：对端完全停止读取时写缓冲会写满，`send` 会永久等待，届时连失活检测都不再运行。

维护时若需在不重启 Codex 的情况下重新附加 launcher，`--attach-existing` 仍连接默认 9229；当当前实例已由普通启动回退到动态端口时，使用内部参数 `--attach-existing-port=<实际端口>`。该入口只恢复 broker、配置核对和注入 watchdog，不执行普通启动的 stop/launch 生命周期。

## 对话历史与投影

CDP 初次安装模型路由会立即调用页面 bridge。必须在接收 session 消息的循环开始后异步执行该脚本；同步 setup command 等待回包时会忽略 `Runtime.bindingCalled`，造成首次 catalog 请求丢失和 30 秒超时。`injection.renderer.ready` 仅表示账户/API 界面已安装；只有心跳得到模型路由的真实 `health.ready`（包含 `model/list` 往返）才写 `injection.ready`。健康时不重新遍历 React/DOM，未就绪时有界重试。

UI 显示的历史不直接读 rollout，而是读 `$CODEX_HOME/thread_history_1.sqlite` 的物化投影（`thread_turns` / `thread_items` / `thread_history_projection_state`）。投影按 `rollout_ordinal` 增量推进；一旦某个 rollout 里出现 ordinal 回退（同一文件被第二个 writer 以重新开始的序号追加），投影会停在断点，**断点之后的 turn 不会再投影**。此时 UI 表现为“对话历史消失 / 只剩最早一段”，而原始 rollout 仍然完整（所以模型仍记得内容）。`codex migrate-rollouts` 对已经是 paginated 的 thread 直接跳过，官方没有提供重建投影的入口。

2026-09-12 复核结论（thread `01a08474-445e-7370-a1a1-a9af071f0325`）：

- 该 rollout 第 35 行出现 `ordinal 33 -> 30` 回退（2026-09-09 23:16:53 CST），投影停在 `next_rollout_ordinal=34`，`thread_turns` 只剩第一条 turn（`inProgress`），app-server `thread/read` 因此只返回 1 个 turn。
- 扫描当时全部 16 份 rollout：只有该文件存在 ordinal 回退；另外 3 个 thread 同样带着未结束的 `inProgress` turn，但投影照常推进到最后。即**未结束的 turn 本身不会破坏投影，ordinal 回退才会**。
- 该 thread 的未结束 turn 产生于 2026-09-09 15:03，当时 launcher 日志没有任何事件；账户切换发生在 2026-09-10 01:13:03，同一秒 rollout 里写入了正常的 `turn_aborted`（`runtime.stop.started` 与 `turn_aborted` 同秒）。因此**没有证据支持“切换的硬停止会留下孤儿 turn 并吃掉历史”**这一早先结论。
- 该 thread 由 VS Code 扩展创建（`source=vscode`），回退发生在桌面端向同一 rollout 追加内容时，更像是跨客户端写入时新 writer 的 ordinal 起点取自投影（该处投影最大 item ordinal 为 28，新写入从 30 开始），而 rollout 尾部 ordinal 已经到 33。这是 OpenAI 侧 writer/reader 的一致性问题，codex-plus 不控制该序号，也没有受支持的修复入口。

因此本轮**没有**在停止流程里加入假设性的“先中断活跃 turn”改造；那种改造无法验证、也不针对已确认的机制。若后续要恢复已损坏的 thread，需要先找到让投影重建受支持的途径（例如 unarchive + fork 是否继承完整 rollout），再决定是否提供维护入口。

## 账户数据

- 实时凭据：`CODEX_HOME\auth.json`，未设置 `CODEX_HOME` 时为 `%USERPROFILE%\.codex\auth.json`。
- 账户快照：`%LOCALAPPDATA%\codex-plus\accounts\<record_id>.json`。`record_id` 是不可逆本地散列，优先由 Business 工作区 `account_id` 与席位级 `chatgpt_account_user_id` 共同派生；旧 token 缺少该 claim 时依次回退 `chatgpt_user_id`、`user_id`、`sub`，再回退旧的工作区散列。这样同一 Business 工作区的不同席位不会互相覆盖。
- 旧 `<sha256(account_id)>.json` 快照在首次列出账户时原子迁移到席位级文件名。迁移只改变 vault 文件名，不修改凭据内容。
- 渲染器只获得 `recordId`、`accountId`、name、email、plan、active 等摘要。令牌与席位 claim 只由 Rust 读取。
- 当前有效 ChatGPT auth 在列出账户前保存到 vault，因此当前账户永远可见且可在之后恢复。

## 切换事务

1. bridge 以 `recordId` 验证目标席位存在，且 `cli_auth_credentials_store` 未设置或为 `file`。
2. 将仅含不可逆 `recordId` 的动作原子写入 `pending-action.json`，启动同一 EXE 的内部 helper。
3. helper 给渲染器短暂响应时间，然后停止父 launcher 与 Codex。
4. 再次验证目标，保存当前实时账户，备份实时 `auth.json`，原子写入目标快照。
5. 清理 pending action 并重新启动普通 `codex-plus.exe`。写入失败时先恢复备份，再启动原账户。

账户切换 helper、重启后的 launcher、Codex 进程以及安装位置查询所用的 PowerShell 都必须通过统一的后台子进程入口启动；Windows 下设置 `CREATE_NO_WINDOW`，避免无父控制台时 PowerShell 在切换过程中短暂创建命令行窗口。

## 删除与网页登录

- 删除只作用于 `%LOCALAPPDATA%\codex-plus\accounts` 中的已保存快照，不调用 ChatGPT 服务，也不删除远端账户。
- 当前正在使用的席位不能直接删除，因为实时 `auth.json` 仍会继续代表该席位；用户必须先切换到其他账户。Rust 层必须以席位级 `recordId` 再次检查，不能只依赖渲染器禁用按钮，也不能只比较 Business 工作区 ID。
- “网页登录新账户”同样使用不含 token 的 pending action 和同一 EXE helper。helper 先验证 file credential store、停止旧运行时，再在 vault 锁内保存当前实时账户并移走 `auth.json`；随后以内部 `--web-login` 模式重新启动官方 Codex，使其显示原生登录页面。
- 网页登录 launcher 轮询新生成的 ChatGPT `auth.json`，解析成功后立即保存到 vault 并结束捕获任务。用户取消登录或关闭 Codex 不会丢失旧账户，其快照已经在移走实时凭据前保存。
- 若移走实时凭据或启动网页登录 launcher 失败，必须恢复操作前的 `auth.json`，并尝试按原账户恢复普通 launcher。

## UI 与额度

- 账户入口固定放在个人资料菜单“API 接入”和“退出登录”之间，图标为 `UsersRound`。注入前必须确认同一菜单容器内同时存在原生“设置”和“退出登录”；不能仅凭“设置”文字匹配，以免污染应用顶部“编辑”等菜单。
- 菜单图标使用 16×16px，与 Codex 原生菜单图标保持相同视觉尺寸；仍须保留强制横向、nowrap 的内层，避免继承菜单项的 `flex-col` 后换行。
- 弹窗默认显示账户列表，标题栏不提供页面切换；列表最下方同时提供“导入 auth.json”和“网页登录新账户”。前者进入导入界面并通过“返回”回到账户列表，后者经确认后执行上述受控重启。
- 每行提供切换与删除操作；当前行的两项操作分别显示“当前账户”和禁用的“删除”，删除非当前账户前必须二次确认。
- 弹窗继承 Codex 的 UI 字体，采用低对比灰阶面板、12px 圆角、紧凑的 30px 控件和单一分组容器；账户之间用细分隔线而非独立高对比卡片。主题强调色使用 Codex 蓝色，当前账户只保留轻量蓝色标记，并同时适配深浅主题。
- 账户页先请求本地列表并立即渲染；随后为每个账户分别调用 usage 路由，哪个先完成就先更新哪个账户。
- 页面侧 bridge（`assets/bridge.js`）对每次请求都有兜底超时，默认 30 秒，并可在调用时用 `timeoutMs` 覆盖；launcher 重新连接、脚本重新注入时，上一轮连接里挂起的请求必须立刻以“桥已重新连接”失败。launcher 侧的心跳失活检测最长约 45 秒，UI 不能依赖它来解锁，任何情况下账户弹窗都要在有限时间内给出错误并允许重试。
- usage 超时或单账户失败仅改变该行状态。
- 文件选择接受任意文本扩展名，只填入 textarea；“导入”负责最终解析和保存。失败保留原文，成功清空并返回账户页。
