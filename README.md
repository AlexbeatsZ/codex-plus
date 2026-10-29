# codex-plus

`codex-plus` 是一个面向 Windows 与 macOS 官方 OpenAI Codex 桌面应用的账户、OpenAI 兼容 API 与本地 MCP 启动器。它只有一个 Windows 自启动入口，没有独立管理面板：正常点击 `codex-plus.exe` 后，程序会确保本机 Secure MCP Tunnel 可用、受控重启 Codex，并把管理入口注入左下角个人资料菜单。

## 功能

- 菜单顺序固定为“设置 → API 接入 → 切换账户 → 退出登录”；API 使用 `Cable` 图标。
- “账户”页立即显示本地账户和切换按钮，额度随后按账户异步加载；同一 ChatGPT Business 工作区中的不同用户席位可以同时保存和切换。
- “导入账户”页支持直接粘贴 `auth.json`，或读取任意文本文件后再确认导入。
- 切换账户时先停止 Codex、原子替换认证文件，再自动重新启动并恢复注入。
- 账户令牌只保存在本机，不返回给注入页面，也不写入日志。
- 可同时保存多个 OpenAI 兼容 API，通过 `/models` 自动发现模型，并选择模型、设置显示别名。
- “API 接入”内置固定的“ChatGPT 订阅 API”，直接复用已导入 auth.json；可选择允许使用额度的账户及优先顺序，额度受限时自动尝试后续账户，失效凭据持续跳过直到更新。
- 0.3.8 起，新任务的官方、外接 API、聚合订阅模型共用内置 `openai` 会话身份，由同一本机 broker 按稳定 `routeId` 精确分流；手机 Codex 可从主机原生模型目录发现外接模型。
- 现有“API 接入 → 迁移旧任务”可为旧自定义 provider 任务创建保留完整历史的新分支，原任务保留。
- 原生支持 Responses；Chat Completions 会在本机转换 Responses 请求、SSE、工具调用与推理字段。
- 内置 `local-tools/` tool-only MCP，可为 ChatGPT/Codex Chat 模式提供工作区文件、搜索、补丁、命令和 Git 工具；MCP 初始化时直接注入本机 Codex 可见的全局与工作区根 `AGENTS` 指令链，Skills 继续渐进加载。
- `codex-plus.exe --login-startup` 会立即幂等启动 Tunnel 与 MCP，但仍不会主动打开官方 Codex 窗口。

## 使用

1. 构建或取得 `codex-plus.exe`。
2. 双击启动。程序会关闭当前 Codex，再以注入模式重新打开。
3. 点击左下角个人资料：在“API 接入”中添加 API，在“切换账户”中导入、查看额度或切换账户。

添加 API 时填写名称、API URL、API Key 和协议，点击“读取模型”，勾选需要在 Codex 模型选择器中出现的模型并按需修改显示名，再保存。API URL 是上游公布的精确 base URL，codex-plus 会直接追加 `/models`、`/chat/completions` 或 `/responses`；需要 `/v1` 的服务应在 URL 中填写 `/v1`。首次发现默认勾选全部模型；再次发现会保留已有别名和选择，新模型默认隐藏。

例如 DeepSeek 应填写 `https://api.deepseek.com` 并选择 Chat Completions；其模型发现地址为 `https://api.deepseek.com/models`。

未登录时没有个人资料菜单，可直接点击原生登录页 ChatGPT 登录按钮旁的“切换账户 / 导入 auth.json”，选择已保存账户或先导入再切换。

导入只保存账户，不会自动切换；切换账户会自动重启 Codex。当前有效 ChatGPT 登录会自动加入本地账户列表。

使用订阅轮换时，在“API 接入 → ChatGPT 订阅 API → 配置”中勾选参与账户，用上下箭头调整优先顺序，读取模型、设置别名和可见性，再启用并保存。在 Codex 原生模型选择器选择“订阅 · …”模型即可。默认关闭；未勾选账户不消耗额度，新导入账户也需手动勾选。同一订阅对话中换账户不需要切换登录或重启。新版新任务在这些渠道之间切换不再需要跨 provider 分支；旧自定义 provider 任务可在“API 接入 → 迁移旧任务”中选择任务与目标模型，确认后创建手机可见的历史分支。

401 最多续期并重试一次；凭据确认失效后跳过，重新导入有效凭据后恢复。额度冷却和模型不可用按账户、模型分别处理，全部参与账户不可用时明确报错。已经输出文本或工具调用后的错误不会透明重放，以免重复执行工具。详情见 [固定订阅 API 设计](docs/design/account-pool.md)。

### Local tools 与 Secure MCP Tunnel

`local-tools/` 使用官方 `tunnel-client` 作为本机 sidecar。首次构建或换机时执行：

```powershell
npm run local-tools:install
npm run local-tools:build
.\local-tools\scripts\install-tunnel-client.ps1
```

把 Tunnel runtime key 保存到未提交的 `local-tools\.env.local`：

```dotenv
OPENAI_API_KEY=your-runtime-key
```

正常运行和 Windows 登录自启都会调用幂等的 managed runtime 连接；健康实例已存在时不会产生重复进程。默认 MCP workspace 是本仓库根目录。需要临时使用另一份组件时，可给当前进程设置 `CODEX_PLUS_LOCAL_TOOLS_ROOT`，其值应指向包含 `dist/cli.js`、`.env.local` 和本地 `tunnel-client.exe` 的组件目录。

MCP `initialize` 响应会按 Codex 优先级直接携带本机全局与已配置工作区根的 `AGENTS` 指令链，并受 `project_doc_max_bytes` 限制；进入嵌套目录或运行中修改指令后，再通过 `codex_instructions` 读取当前链。Skills 仍采用渐进加载：初始化只公开有界的名称/描述目录，匹配后才读取单个 `SKILL.md`，其 references/scripts/assets 继续按需读取。同步范围和安全边界见 `local-tools/docs/design/codex-context-sync.md`。OpenAI 平台内部 system/developer prompt 不属于本机可读数据。

Tunnel key 只作为 `tunnel-client` 子进程的 `CONTROL_PLANE_API_KEY` 环境变量传递；启动 MCP 的脚本会在 Node 子进程前清除它。启动结果记录在 `%LOCALAPPDATA%\codex-plus\codex-plus.log` 的 `local_tools.runtime.*` 事件中。

账户快照位于 `%LOCALAPPDATA%\codex-plus\accounts\`，API 配置位于 `%LOCALAPPDATA%\codex-plus\providers.json`，运行日志位于 `%LOCALAPPDATA%\codex-plus\codex-plus.log`。按产品约定 API Key 在 `providers.json` 中明文保存，但不会返回 renderer 或写入日志。

codex-plus 增量维护用户级 `config.toml` 的两张旧 provider 兼容表，并通过受能力值保护的 `openai_base_url` 将内置 openai 的模型流量交给本机 broker；原端点和可选静态目录来源保存在忽略的 `.codex-plus/native-gateway.json`。首次修改前保留 `config.toml.codex-plus.bak`；官方 `auth.json` 与远程配对保持原样，其他未知配置不覆盖。纯第三方默认 provider 不会被静默接管。

手机已连接电脑后，显式启动一次新版 codex-plus，再从手机刷新该主机的任务和模型列表。目录更新受官方客户端缓存影响；显式静态目录模式在启动时更新。旧任务需在电脑上使用上述迁入入口创建新分支。详见 [手机兼容设计与验收](docs/design/mobile-remote-providers.md)。

## 构建与测试

```powershell
npm install
npm run local-tools:install
npm run local-tools:build
cargo fmt --all -- --check
cargo test
npm run verify
cargo build --release
```

发布产物：`target\release\codex-plus.exe`。

开发时可以使用 `codex-plus.exe --attach-existing` 附加已在 `9229` 开启 CDP 的 Codex；该模式不会执行正常入口的重启流程。

若要随 Windows 登录启动，注册表启动命令应使用 `"codex-plus.exe 的完整路径" --login-startup`。这个模式会立即确保 Tunnel 与 MCP 运行，但不会主动打开 Codex，只会静默等待；用户之后从官方入口打开 Codex 时，它会接管并重启为可注入实例。直接双击不带参数的 `codex-plus.exe` 仍会立即重启 Codex。

## 支持范围

当前支持 Windows 11 上的 Microsoft Store `OpenAI.Codex`，并兼容可发现的 `OpenAI.CodexBeta`、`OpenAI.ChatGPT-Desktop` 与常见独立安装目录。第三方仅支持 OpenAI 兼容的 Responses 与 Chat Completions，不支持厂商专有协议。

同属 `codex-plus-api` 的模型可在下一轮原地切换。`openai ↔ codex-plus-api` 的已有任务切换属于实验功能：只允许空闲任务执行 shutdown/resume，并验证 provider；失败时阻止发送并尝试恢复原 provider。

Windows host releases are maintained separately: `codex/omen` has no AI Decision/Todoist adapter; `codex/rog` contains it. Shared fixes originate on `main`. See [host release maintenance](docs/design/host-releases.md).
