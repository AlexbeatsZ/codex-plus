# Local tools 与 Tunnel 生命周期

## 产品边界

`codex-plus` 在每台桌面主机上仍只有一个启动器入口：Windows 使用 `codex-plus.exe`，macOS 使用同一 Rust launcher 的 Darwin 构建并由 LaunchAgent 以 `--login-startup` 启动。仓库内的 `local-tools/` 是随启动器部署的 tool-only MCP 组件，不提供独立管理界面，也不要求用户在 UI 中选择机器。

OpenAI `tunnel-client` 作为本机 sidecar，把 OpenAI 托管 Tunnel 的请求转交给 `local-tools` 的 stdio MCP。它需要常驻才能接收工具调用；MCP 本身不持有 Tunnel runtime key。

## 多机器路由

- Windows PC `Meta-OMEN` 默认地址为 `meta@192.168.31.214`（备用 `meta@100.113.70.121`）；Mac 默认地址为 `meta@192.168.31.174`（备用 `meta@100.64.2.94`）。两端已配置双向免密 SSH。
- Windows 与 Mac 默认各自连接独立 Tunnel：Windows alias 为 `codex-chat-local-tools-win`，macOS alias 为 `codex-chat-local-tools-mac`。ChatGPT 将它们注册为两个可独立启用的连接器，从控制面避免同一 Tunnel 的随机分流。
- `windows_*` / `mac_*` 语义路由和双向 SSH 仍作为协议层保证：无论用户只启用其中一个连接器，还是以后显式改回共享 Tunnel，请求都能到达指定主机，不能把“当前 runtime 所在机器”等同于“用户想操作的机器”。
- MCP 0.3.0 为主要 workspace/file/Git/command 操作同时注册 `windows_*` 与 `mac_*` 工具。模型根据用户语义直接选择目标机器，不增加机器选择 UI。
- 若工具目标就是当前 runtime 所在主机，直接复用 `LocalOperations`；若目标是另一台主机，则通过 OpenSSH `BatchMode=yes` 把 JSON 请求从 stdin 转发到对端 `dist/host-rpc.js`。对端仍复用相同的 `WorkspaceRegistry` 与 `LocalOperations`，所以路径边界、patch 检查、命令超时和输出限制不因 SSH 转发而改变。
- `machine_info` 仅用于目标不清楚时查看两台主机及当前 runtime。旧的无前缀工具继续保留兼容性，但它们只作用于实际接到请求的 runtime；只要机器身份会影响结果，就必须使用 `windows_*` / `mac_*`。
- 默认 SSH 地址与工作区根可分别用 `CODEX_PLUS_WINDOWS_SSH_TARGET`、`CODEX_PLUS_WINDOWS_WORKSPACE_ROOT`、`CODEX_PLUS_MAC_SSH_TARGET`、`CODEX_PLUS_MAC_WORKSPACE_ROOT` 覆盖，不需要重新编译。

这一层使两个独立连接器都成为对称 gateway：显式目标工具始终路由到正确主机；即使某台机器暂时离线，另一台在线主机仍可通过 SSH 代为执行。

## 桌面交互桥

桌面控制不新增 `desktop_*` MCP tool。ChatGPT 继续通过 `windows_run_command` / `mac_run_command` 调用 `local-tools/scripts/desktop-helper.mjs`；薄客户端再访问目标机登录会话里 `codex-plus` 自己监听的 loopback desktop helper。Windows 因此不会在 OpenSSH Session 0 中直接执行 GUI 输入，ChatGPT App 的 frozen tool schema 也无需因桌面 primitive 变化而重新发布。

helper 的生命周期、截图缓存、Windows DPI 物理坐标、macOS Retina/TCC 和 UI Automation/Accessibility 约束详见 `docs/design/desktop-helper.md`。

MCP 同时提供只读 Codex 上下文桥接：Node MCP 进程启动时读取本机全局与已配置工作区根的 `AGENTS` 指令链，并直接放入 MCP `initialize` 指令；嵌套目录或进程启动后变化的指令仍由工具按需刷新。初始化另外携带有界的 skill 元数据目录；完整 `SKILL.md` 与其资源分阶段按需加载。详细发现顺序、触发与路径边界见 `local-tools/docs/design/codex-context-sync.md`。

## 启动时序

- 除 `--apply-pending-action` 账户事务 helper 外，每个 `codex-plus.exe` 入口都先幂等确保 managed runtime 已启动。
- `--login-startup` 在进入“等待用户打开 Codex”的循环前启动 runtime，因此登录后 MCP 可用，但官方 Codex 窗口仍不会被主动打开。
- 普通点击、网页登录和 attach 模式也执行同一幂等检查；已有健康 runtime 时不得创建重复进程。
- MCP 启动失败只写入 `%LOCALAPPDATA%\codex-plus\codex-plus.log`，不阻止账户、broker 或 Codex 注入功能继续运行。
- `run_command` 超时必须终止整个子进程树并在短暂宽限期后强制关闭继承管道；不能只杀 shell 父进程后继续等待 `close`，否则 Tunnel health/ready 仍为 200 时 stdio 也可能永久阻塞。

## 组件发现

启动器按以下顺序寻找 `local-tools`：

1. `CODEX_PLUS_LOCAL_TOOLS_ROOT` 指定的目录；
2. 发布 EXE 所在目录向上两级后的 `local-tools/`（仓库内 `target/release/codex-plus.exe`）；
3. 编译时仓库根目录下的 `local-tools/`，用于隔离 target 目录和开发构建。

一个可启动组件必须同时具有：

- `dist/cli.js`；
- `dist/host-rpc.js`；
- Windows：`scripts/start-tunnel-mcp.ps1` 与 `.tools/tunnel-client/tunnel-client.exe`；
- macOS：`scripts/start-tunnel-mcp.sh` 与 `.tools/tunnel-client/tunnel-client`；
- 双机转发脚本 `scripts/host-rpc.ps1` / `scripts/host-rpc.sh`；
- 未提交的 `.env.local`，其中含非空 `OPENAI_API_KEY`。

## 密钥边界

- `codex-plus` 只读取 `.env.local` 以便给 `tunnel-client runtimes connect` 的进程级 `CONTROL_PLANE_API_KEY` 赋值。
- 直连 `api.openai.com:443` 不可用时，`.env.local` 可设置 `TUNNEL_HTTP_PROXY`；启动器和 tunnel wrapper 仅将其映射为 tunnel-client 进程级 `HTTPS_PROXY`，不修改用户或系统环境变量。
- 启动器不记录密钥，不把密钥写入命令行，也不修改用户/系统环境变量。
- Tunnel profile 只保存 `env:CONTROL_PLANE_API_KEY` 引用。
- `scripts/start-tunnel-mcp.ps1` 在启动 Node MCP 前清除 `CONTROL_PLANE_API_KEY`、`OPENAI_API_KEY` 与 tunnel 专用 `HTTPS_PROXY`，防止 MCP 子进程继承凭据或改变用户命令的网络行为。

## 工作区边界

合并部署默认把 `codex-plus` 仓库根目录作为 MCP 的唯一 workspace root；这使本地工具能同时维护启动器和内嵌 `local-tools`，同时不会自动扩大到整个 `Workspaces` 或用户目录。

跨机器工具也只把对端 `codex-plus` 根注册为 workspace。`run_command` 与本地版本一样，shell 虽从 workspace 内启动但仍拥有目标用户权限；需要修改 workspace 外的系统配置时必须继续遵守目标机 `AGENTS.md` 权限规则。Windows 命令由 PowerShell 执行，Mac 命令由 Bash 执行。

## 发布与回退

`local-tools/.tools/`、`local-tools/.tunnel-client/`、`local-tools/.env.local`、`local-tools/node_modules/` 和构建输出均保持未提交。发布或换机时先执行组件安装/构建，再启动 `codex-plus.exe`。

迁移现有 runtime 时，先停止旧 alias，再从新目录执行一次幂等启动。旧 MCP 仓库在新 runtime 完成 health、ready 和真实工具调用验收前保留，作为回退入口。

Windows `canonicalize()` 可能返回 extended-length 路径；写入 profile 的命令必须去除 `\\?\` 前缀并统一为正斜杠。Tunnel wrapper 也必须把当前目录切到组件根目录，使相对 `.tunnel-client` 在启动、doctor 和 status 中指向同一位置。

`tunnel-client` 在 Windows 上不会自动采用 Internet Settings 中的本地代理。若日志中的 control-plane 请求直接连接解析地址并超时，而浏览器或 `curl` 可访问 OpenAI，应优先配置 `TUNNEL_HTTP_PROXY`，无需依赖 Proxifier 的进程规则。
