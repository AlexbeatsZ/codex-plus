# 账户切换与注入生命周期

## 产品边界

`codex-plus.exe` 是唯一产品入口。所有操作都发生在 Codex 注入窗口内；内部 `--apply-pending-action`、`--attach-existing` 与 `--login-startup` 仍由同一个二进制提供，不构成第二产品或管理界面。

## 登录自启

- Windows 当前用户登录启动项使用 `codex-plus.exe --login-startup`，不能使用无参数入口。
- 登录模式先获取 launcher 锁并静默等待，不启动 broker、不修改配置，也不主动打开 Codex；若已有 launcher 持锁则直接退出。
- 用户之后从官方入口打开 Codex 时，登录模式检测到受支持的 OpenAI 进程，释放等待锁，再进入与普通启动相同的 `stop → lock → broker → config → launch → inject` 生命周期。
- 接管的 Codex 会以 Windows `BelowNormal` priority class 启动，避免官方 Electron 主进程出现持续 CPU 忙循环时以普通或更高线程优先级阻塞桌面输入；该设置仅作用于本次 Codex 进程树，不修改系统全局调度配置。
- 一次受管 Codex 生命周期结束后，登录模式必须重新获取等待锁并回到静默监测；官方应用更新或自重启产生的新根进程也要再次接管。根进程发现必须排除带 `--type=` 的 Electron 子进程和 `codex app-server`，避免残留 crashpad/renderer 触发无意义重启。
- 用户直接双击无参数 EXE 时，仍立即执行普通启动；它会停止等待中的登录实例，因此不会被后台 monitor 阻塞。

## 普通启动

1. 结束当前 EXE 的旧实例、已知旧 launcher 名称 `codex-plus-plus`，以及属于 OpenAI Codex/ChatGPT 安装的 `ChatGPT.exe`/`Codex.exe`；排除当前 PID 并核对目标路径。
2. 确认目标进程退出后获取 `%LOCALAPPDATA%\codex-plus\launcher.lock` 独占锁。
3. 启动本机 API broker，并增量核对 Codex provider 配置；详见 `api-provider-routing.md`。
4. 解析 Microsoft Store OpenAI 包或受支持的独立安装路径；优先以 `--remote-debugging-port=9229` 启动。若旧进程退出后 9229 仍无法在本机绑定（包括 Windows 遗留的失效监听端点），自动选择一个空闲本机端口，并让启动、注入 watchdog 与退出监测全程使用同一端口。
5. 选择主 `app://-/index.html` target，安装 CDP binding、账户/API UI、模型目录和路由脚本。
6. launcher 保持运行；target 重建或连接丢失时重新发现并注入。常驻退出监测持有本次启动的 Codex 根进程句柄，根进程存活时不得周期性枚举全机进程或探测 CDP；只有根进程退出后才用 CDP 端点确认是否仍有接管后的 Codex 实例。登录自启等待模式可枚举进程，但必须复用轻量 monitor、只刷新名称、可执行路径和一次性命令行，并使用低频轮询。

注入 observer 只响应新增或变化的原生菜单节点；聊天流、终端输出和其他无关 DOM 变化不得触发全页面菜单扫描。CDP 健康心跳只在 observer/style 缺失时重新安装注入，不应把健康检查本身变成固定频率的 DOM 扫描。

维护时若需在不重启 Codex 的情况下重新附加 launcher，`--attach-existing` 仍连接默认 9229；当当前实例已由普通启动回退到动态端口时，使用内部参数 `--attach-existing-port=<实际端口>`。该入口只恢复 broker、配置核对和注入 watchdog，不执行普通启动的 stop/launch 生命周期。

## 账户数据

- 实时凭据：`CODEX_HOME\auth.json`，未设置 `CODEX_HOME` 时为 `%USERPROFILE%\.codex\auth.json`。
- 账户快照：`%LOCALAPPDATA%\codex-plus\accounts\<sha256(account_id)>.json`。
- 渲染器只获得 `accountId`、name、email、plan、active 等摘要。令牌只由 Rust 读取。
- 当前有效 ChatGPT auth 在列出账户前保存到 vault，因此当前账户永远可见且可在之后恢复。

## 切换事务

1. bridge 验证目标存在，且 `cli_auth_credentials_store` 未设置或为 `file`。
2. 将仅含 account ID 的动作原子写入 `pending-action.json`，启动同一 EXE 的内部 helper。
3. helper 给渲染器短暂响应时间，然后停止父 launcher 与 Codex。
4. 再次验证目标，保存当前实时账户，备份实时 `auth.json`，原子写入目标快照。
5. 清理 pending action 并重新启动普通 `codex-plus.exe`。写入失败时先恢复备份，再启动原账户。

账户切换 helper、重启后的 launcher、Codex 进程以及安装位置查询所用的 PowerShell 都必须通过统一的后台子进程入口启动；Windows 下设置 `CREATE_NO_WINDOW`，避免无父控制台时 PowerShell 在切换过程中短暂创建命令行窗口。

## 删除与网页登录

- 删除只作用于 `%LOCALAPPDATA%\codex-plus\accounts` 中的已保存快照，不调用 ChatGPT 服务，也不删除远端账户。
- 当前正在使用的账户不能直接删除，因为实时 `auth.json` 仍会继续代表该账户；用户必须先切换到其他账户。Rust 层必须再次检查实时 account ID，不能只依赖渲染器禁用按钮。
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
- usage 超时或单账户失败仅改变该行状态。
- 文件选择接受任意文本扩展名，只填入 textarea；“导入”负责最终解析和保存。失败保留原文，成功清空并返回账户页。
