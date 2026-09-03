# Local tools 与 Tunnel 生命周期

## 产品边界

`codex-plus.exe` 仍是唯一的 Windows 自启动入口。仓库内的 `local-tools/` 是随启动器部署的 tool-only MCP 组件，不提供独立界面，也不接管 Codex/ChatGPT 页面。

OpenAI `tunnel-client` 作为本机 sidecar，把 OpenAI 托管 Tunnel 的请求转交给 `local-tools` 的 stdio MCP。它需要常驻才能接收工具调用；MCP 本身不持有 Tunnel runtime key。

## 启动时序

- 除 `--apply-pending-action` 账户事务 helper 外，每个 `codex-plus.exe` 入口都先幂等确保 managed runtime 已启动。
- `--login-startup` 在进入“等待用户打开 Codex”的循环前启动 runtime，因此登录后 MCP 可用，但官方 Codex 窗口仍不会被主动打开。
- 普通点击、网页登录和 attach 模式也执行同一幂等检查；已有健康 runtime 时不得创建重复进程。
- MCP 启动失败只写入 `%LOCALAPPDATA%\codex-plus\codex-plus.log`，不阻止账户、broker 或 Codex 注入功能继续运行。

## 组件发现

启动器按以下顺序寻找 `local-tools`：

1. `CODEX_PLUS_LOCAL_TOOLS_ROOT` 指定的目录；
2. 发布 EXE 所在目录向上两级后的 `local-tools/`（仓库内 `target/release/codex-plus.exe`）；
3. 编译时仓库根目录下的 `local-tools/`，用于隔离 target 目录和开发构建。

一个可启动组件必须同时具有：

- `dist/cli.js`；
- `scripts/start-tunnel-mcp.ps1`；
- `.tools/tunnel-client/tunnel-client.exe`；
- 未提交的 `.env.local`，其中含非空 `OPENAI_API_KEY`。

## 密钥边界

- `codex-plus` 只读取 `.env.local` 以便给 `tunnel-client runtimes connect` 的进程级 `CONTROL_PLANE_API_KEY` 赋值。
- 直连 `api.openai.com:443` 不可用时，`.env.local` 可设置 `TUNNEL_HTTP_PROXY`；启动器和 tunnel wrapper 仅将其映射为 tunnel-client 进程级 `HTTPS_PROXY`，不修改用户或系统环境变量。
- 启动器不记录密钥，不把密钥写入命令行，也不修改用户/系统环境变量。
- Tunnel profile 只保存 `env:CONTROL_PLANE_API_KEY` 引用。
- `scripts/start-tunnel-mcp.ps1` 在启动 Node MCP 前清除 `CONTROL_PLANE_API_KEY`、`OPENAI_API_KEY` 与 tunnel 专用 `HTTPS_PROXY`，防止 MCP 子进程继承凭据或改变用户命令的网络行为。

## 工作区边界

合并部署默认把 `codex-plus` 仓库根目录作为 MCP 的唯一 workspace root；这使本地工具能同时维护启动器和内嵌 `local-tools`，同时不会自动扩大到整个 `Workspaces` 或用户目录。

## 发布与回退

`local-tools/.tools/`、`local-tools/.tunnel-client/`、`local-tools/.env.local`、`local-tools/node_modules/` 和构建输出均保持未提交。发布或换机时先执行组件安装/构建，再启动 `codex-plus.exe`。

迁移现有 runtime 时，先停止旧 alias，再从新目录执行一次幂等启动。旧 MCP 仓库在新 runtime 完成 health、ready 和真实工具调用验收前保留，作为回退入口。

Windows `canonicalize()` 可能返回 extended-length 路径；写入 profile 的命令必须去除 `\\?\` 前缀并统一为正斜杠。Tunnel wrapper 也必须把当前目录切到组件根目录，使相对 `.tunnel-client` 在启动、doctor 和 status 中指向同一位置。

`tunnel-client` 在 Windows 上不会自动采用 Internet Settings 中的本地代理。若日志中的 control-plane 请求直接连接解析地址并超时，而浏览器或 `curl` 可访问 OpenAI，应优先配置 `TUNNEL_HTTP_PROXY`，无需依赖 Proxifier 的进程规则。
