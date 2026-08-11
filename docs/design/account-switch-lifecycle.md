# 账户切换与注入生命周期

## 产品边界

`codex-plus.exe` 是唯一产品入口。所有操作都发生在 Codex 注入窗口内；内部 `--apply-pending-action`、`--attach-existing` 与 `--login-startup` 仍由同一个二进制提供，不构成第二产品或管理界面。

## 登录自启

- Windows 当前用户登录启动项使用 `codex-plus.exe --login-startup`，不能使用无参数入口。
- 登录模式先获取 launcher 锁并静默等待，不启动 broker、不修改配置，也不主动打开 Codex；若已有 launcher 持锁则直接退出。
- 用户之后从官方入口打开 Codex 时，登录模式检测到受支持的 OpenAI 进程，释放等待锁，再进入与普通启动相同的 `stop → lock → broker → config → launch → inject` 生命周期。
- 用户直接双击无参数 EXE 时，仍立即执行普通启动；它会停止等待中的登录实例，因此不会被后台 monitor 阻塞。

## 普通启动

1. 结束当前 EXE 的旧实例、已知旧 launcher 名称 `codex-plus-plus`，以及属于 OpenAI Codex/ChatGPT 安装的 `ChatGPT.exe`/`Codex.exe`；排除当前 PID 并核对目标路径。
2. 确认目标进程退出后获取 `%LOCALAPPDATA%\codex-plus\launcher.lock` 独占锁。
3. 启动本机 API broker，并增量核对 Codex provider 配置；详见 `api-provider-routing.md`。
4. 解析 Microsoft Store OpenAI 包或受支持的独立安装路径；优先以 `--remote-debugging-port=9229` 启动。若旧进程退出后 9229 仍无法在本机绑定（包括 Windows 遗留的失效监听端点），自动选择一个空闲本机端口，并让启动、注入 watchdog 与退出监测全程使用同一端口。
5. 选择主 `app://-/index.html` target，安装 CDP binding、账户/API UI、模型目录和路由脚本。
6. launcher 保持运行；target 重建或连接丢失时重新发现并注入。

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

## UI 与额度

- 账户入口固定放在个人资料菜单“API 接入”和“退出登录”之间，图标为 `UsersRound`。
- 菜单图标使用 16×16px，与 Codex 原生菜单图标保持相同视觉尺寸；仍须保留强制横向、nowrap 的内层，避免继承菜单项的 `flex-col` 后换行。
- 弹窗默认显示账户列表，标题栏不提供页面切换；列表最下方的“添加账户”按钮进入添加界面，添加界面通过“返回”回到账户列表，交互与 API 接入的列表/表单模式一致。
- 弹窗继承 Codex 的 UI 字体，采用低对比灰阶面板、12px 圆角、紧凑的 30px 控件和单一分组容器；账户之间用细分隔线而非独立高对比卡片。主题强调色使用 Codex 蓝色，当前账户只保留轻量蓝色标记，并同时适配深浅主题。
- 账户页先请求本地列表并立即渲染；随后为每个账户分别调用 usage 路由，哪个先完成就先更新哪个账户。
- usage 超时或单账户失败仅改变该行状态。
- 文件选择接受任意文本扩展名，只填入 textarea；“导入”负责最终解析和保存。失败保留原文，成功清空并返回账户页。
