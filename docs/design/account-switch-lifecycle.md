# 账户切换与注入生命周期

## 产品边界

`codex-plus.exe` 是唯一产品入口。所有操作都发生在 Codex 注入窗口内；内部 `--apply-pending-action` 与 `--attach-existing` 仍由同一个二进制提供，不构成第二产品或管理界面。

## 普通启动

1. 结束当前 EXE 的旧实例、已知旧 launcher 名称 `codex-plus-plus`，以及属于 OpenAI Codex/ChatGPT 安装的 `ChatGPT.exe`/`Codex.exe`；排除当前 PID 并核对目标路径。
2. 确认目标进程退出后获取 `%LOCALAPPDATA%\codex-plus\launcher.lock` 独占锁。
3. 解析 Microsoft Store OpenAI 包或受支持的独立安装路径，以 `--remote-debugging-port=9229` 启动。
4. 选择主 `app://-/index.html` target，安装 CDP binding、renderer 脚本和新文档脚本。
5. launcher 保持运行；target 重建或连接丢失时重新发现并注入。

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

- 入口固定放在个人资料菜单“设置”和“退出登录”之间，图标为 `UsersRound`。
- 弹窗只有“账户”和“导入账户”两页。
- 账户页先请求本地列表并立即渲染；随后为每个账户分别调用 usage 路由，哪个先完成就先更新哪个账户。
- usage 超时或单账户失败仅改变该行状态。
- 文件选择接受任意文本扩展名，只填入 textarea；“导入”负责最终解析和保存。失败保留原文，成功清空并返回账户页。
