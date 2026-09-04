# codex-plus

`codex-plus` 是一个面向 Windows 官方 OpenAI Codex 桌面应用的账户、OpenAI 兼容 API 与本地 MCP 启动器。它只有一个 Windows 自启动入口，没有独立管理面板：正常点击 `codex-plus.exe` 后，程序会确保本机 Secure MCP Tunnel 可用、受控重启 Codex，并把管理入口注入左下角个人资料菜单。

## 功能

- 菜单顺序固定为“设置 → API 接入 → 切换账户 → 退出登录”；API 使用 `Cable` 图标。
- “账户”页立即显示本地账户和切换按钮，额度随后按账户异步加载；同一 ChatGPT Business 工作区中的不同用户席位可以同时保存和切换。
- “导入账户”页支持直接粘贴 `auth.json`，或读取任意文本文件后再确认导入。
- 切换账户时先停止 Codex、原子替换认证文件，再自动重新启动并恢复注入。
- 账户令牌只保存在本机，不返回给注入页面，也不写入日志。
- 可同时保存多个 OpenAI 兼容 API，通过 `/models` 自动发现模型，并选择模型、设置显示别名。
- 官方登录模型保持 `openai` provider；API 模型通过本机 `codex-plus-api` broker 按稳定 `routeId` 分发，不切换全局 provider。
- 原生支持 Responses；Chat Completions 会在本机转换 Responses 请求、SSE、工具调用与推理字段。
- 内置 `local-tools/` tool-only MCP，可为 ChatGPT/Codex Chat 模式提供工作区文件、搜索、补丁、命令和 Git 工具，并按需同步本机 Codex 可见的 `AGENTS` 指令链与 Skills。
- `codex-plus.exe --login-startup` 会立即幂等启动 Tunnel 与 MCP，但仍不会主动打开官方 Codex 窗口。

## 使用

1. 构建或取得 `codex-plus.exe`。
2. 双击启动。程序会关闭当前 Codex，再以注入模式重新打开。
3. 点击左下角个人资料：在“API 接入”中添加 API，在“切换账户”中导入、查看额度或切换账户。

添加 API 时填写名称、API URL、API Key 和协议，点击“读取模型”，勾选需要在 Codex 模型选择器中出现的模型并按需修改显示名，再保存。API URL 是上游公布的精确 base URL，codex-plus 会直接追加 `/models`、`/chat/completions` 或 `/responses`；需要 `/v1` 的服务应在 URL 中填写 `/v1`。首次发现默认勾选全部模型；再次发现会保留已有别名和选择，新模型默认隐藏。

例如 DeepSeek 应填写 `https://api.deepseek.com` 并选择 Chat Completions；其模型发现地址为 `https://api.deepseek.com/models`。

导入只保存账户，不会自动切换；切换账户会自动重启 Codex。当前有效 ChatGPT 登录会自动加入本地账户列表。

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

Codex 上下文同步采用渐进加载：初始化只公开有界的 skill 名称/描述目录，匹配后才读取单个 `SKILL.md`，其 references/scripts/assets 继续按需读取；`AGENTS` 指令链也只在进入具体工作区任务时加载。同步范围和安全边界见 `local-tools/docs/design/codex-context-sync.md`。OpenAI 平台内部 system/developer prompt 不属于本机可读数据，工具会明确说明这一边界。

Tunnel key 只作为 `tunnel-client` 子进程的 `CONTROL_PLANE_API_KEY` 环境变量传递；启动 MCP 的脚本会在 Node 子进程前清除它。启动结果记录在 `%LOCALAPPDATA%\codex-plus\codex-plus.log` 的 `local_tools.runtime.*` 事件中。

账户快照位于 `%LOCALAPPDATA%\codex-plus\accounts\`，API 配置位于 `%LOCALAPPDATA%\codex-plus\providers.json`，运行日志位于 `%LOCALAPPDATA%\codex-plus\codex-plus.log`。按产品约定 API Key 在 `providers.json` 中明文保存，但不会返回 renderer 或写入日志。

codex-plus 只增量维护用户级 `config.toml` 的 `[model_providers.codex-plus-api]` 表，并在第一次修改前创建 `config.toml.codex-plus.bak`；顶层 `model_provider`、官方 `auth.json` 和其他配置保持不变。

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
