# Desktop helper

## 边界

`codex-plus` 的桌面控制后端不依赖 ChatGPT Web 能否加载 Codex 专属 `computer-use` / `node_repl` Skill。ChatGPT 继续可以使用现有 `windows_run_command` / `mac_run_command`；此外，macOS 本机现在提供独立的标准 stdio MCP `codex-plus-computer-use`，供 Antigravity/Agy 等普通 MCP 客户端直接复用相同 loopback helper。

标准 MCP 路径不连接 OpenAI 私有 `cua_repl`、不伪造 `elicitation` capability，也不依赖 OpenAI 签名 Node：

```text
Agy / ordinary MCP client
  -> local-tools/dist/desktop-mcp-cli.js
  -> 127.0.0.1 codex-plus desktop helper
  -> CoreGraphics / Accessibility
```

MCP 的 `computer_observe` 直接返回 MCP `image` content。坐标工具统一接收该截图的像素坐标，并在 server 内按当前 screen/backing dimensions 转换为 Quartz point，避免 Retina 2x 导致的点击偏移。

Windows 与 macOS 使用不同的稳定后端：

```text
Windows
ChatGPT Web
  -> windows_run_command
  -> node local-tools/scripts/desktop-helper.mjs ...
  -> 127.0.0.1 codex-plus desktop helper
  -> Win32 / SendInput / UI Automation

macOS
ChatGPT Web
  -> mac_run_command
  -> node local-tools/scripts/desktop-helper.mjs codex-task ...
  -> 127.0.0.1 codex-plus desktop helper
  -> OpenAI codex exec --json --ephemeral
  -> official cua_repl / Computer Use
  -> macOS GUI
```

这样既不扩大 ChatGPT App 的 frozen MCP schema，也避免 Windows 远程 SSH 进程位于 Session 0 时直接注入鼠标/键盘。macOS 则直接复用 OpenAI 官方 Computer Use 的 Accessibility、截图与授权存储，不再维护可见 Codex Desktop bridge thread。

## 生命周期与端点

- 所有非 `--apply-pending-action` 的 `codex-plus` 启动模式都会确保 desktop helper 可用。
- 首选地址固定为 `127.0.0.1:43122`，仅监听 loopback。
- 若 43122 已被健康的 codex-plus helper 占用，新 launcher 复用现有实例，不再创建第二个 helper。
- 若 43122 被其他程序占用，则绑定随机 loopback 端口。
- 当前端点写入 `.codex-plus/desktop-endpoint.json`，薄客户端每次调用都重新读取，因此端口 fallback 不需要修改 MCP 配置。
- `POST /v1/desktop` 要求固定的 loopback bearer marker；它不是跨主机认证凭据，真正的安全边界仍是 loopback + 当前用户权限。

## 客户端

统一入口：

```text
node local-tools/scripts/desktop-helper.mjs state
node local-tools/scripts/desktop-helper.mjs windows
node local-tools/scripts/desktop-helper.mjs screenshot
node local-tools/scripts/desktop-helper.mjs mouse move 900 500
node local-tools/scripts/desktop-helper.mjs mouse click 900 500
node local-tools/scripts/desktop-helper.mjs keyboard key CTRL+L
node local-tools/scripts/desktop-helper.mjs keyboard text64 <UTF-8 base64>
node local-tools/scripts/desktop-helper.mjs uia find --control-type Edit --limit 20
node local-tools/scripts/desktop-helper.mjs permissions
node local-tools/scripts/desktop-helper.mjs permissions request --post-events true --screen-capture true
node local-tools/scripts/desktop-helper.mjs codex-task start64 <UTF-8 base64 prompt>
node local-tools/scripts/desktop-helper.mjs codex-task status <job-id> --wait-ms 30000
node local-tools/scripts/desktop-helper.mjs codex-task cancel <job-id>
```

任意文本通过 `text64` / `start64` 传入，避免 PowerShell/Bash/SSH 多层 quoting。Windows UI 查询可额外使用 `--window-handle`、`--max-depth` 和 `--max-visited`。macOS `codex-task start64` 立即返回 `jobId`，长任务通过 `status --wait-ms` 有界等待，不占满 MCP 的单次 30–45 秒命令预算。

## 截图缓存

Windows primitive 截图只覆盖正式运行状态目录中的单槽缓存：

```text
.codex-plus/desktop/latest.png
```

macOS 官方 Computer Use 返回的最新截图保存在对应任务目录：

```text
.codex-plus/desktop/codex-tasks/<job-id>/latest.png|latest.jpg
```

响应同时返回绝对路径和工作区相对路径。CUA 偶尔会把图片实际编码与声明 MIME 写得不一致，因此 helper 以 PNG/JPEG magic bytes 为准决定扩展名和 MIME。ChatGPT 可随后通过已有 `windows_read_image` / `mac_read_image` 读取，不需要新的 image MCP tool。

## Windows 坐标与输入

- 每个 PowerShell helper 调用首先设置 `DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2`。
- `state.screen`、窗口 bounds、截图和 `SetCursorPos` 都使用同一套物理像素坐标。
- 默认截图主屏；`screenshot --scope virtual` 可捕获整个虚拟桌面。
- 鼠标使用 Win32 输入；文字和快捷键使用 `SendInput`。
- UI Automation 返回 `Name`、`AutomationId`、`ControlType`、进程、窗口句柄和物理 bounds；支持 focus / InvokePattern / ValuePattern。

2026-09-08 实机验证：主屏为 2560x1600 物理像素、虚拟桌面跨三屏；截图为 2560x1600；鼠标移动可精确移动并恢复；隔离 WPF harness 的 UIA button/textbox 可定位，真实 click 触发 Button.Click，Unicode `SendInput` 文本可被 textbox 精确接收。

## macOS 官方 Computer Use

macOS 的首选控制面不是 `desktop/macos.jxa`/CoreGraphics primitive，而是 ChatGPT Desktop 内置 Codex CLI 提供的官方 `cua_repl` Computer Use：

```text
/Applications/ChatGPT.app/Contents/Resources/codex exec --json --ephemeral
```

- 每个 `codex-task` 都是独立 ephemeral Codex 执行，不写入 `~/.codex/sessions`，也不会在 Codex Desktop 侧边栏创建长期测试会话。
- `codex-plus` 解析 Codex JSONL，汇总最终文本、CUA tool-call 数量、错误与最新截图；任务状态只通过本机 loopback helper 查询。
- 已在 OpenAI Computer Use 中选择“始终允许”的 App 会写入官方 approval store，后续新的 ephemeral task 可复用授权；不需要每次切换 Desktop permission mode。
- 新 App 首次使用仍由 OpenAI 官方 Computer Use 授权流程控制；`codex-plus` 不写 approval store，也不绕过 Computer Use action-time confirmation policy。
- `--ephemeral` 只影响 Codex session 持久化，不影响 CUA 授权复用。
- 当直连 OpenAI 不可用时，Codex 子进程只继承进程级代理。优先读取 `CODEX_PLUS_CODEX_PROXY` / `HTTPS_PROXY`；否则从 `local-tools/.env.local` 依次读取 `CODEX_DESKTOP_HTTP_PROXY`、`CODEX_CLI_HTTP_PROXY`、`TUNNEL_HTTP_PROXY`。不修改用户或系统环境变量。

2026-09-08 实机闭环：`com.apple.TextEdit` 首次永久批准后，连续两个新的 `codex exec --ephemeral` 任务均可直接调用官方 `cua_repl`，读取窗口标题 `未命名` 与文本值 `Abc中文`，并返回真实 CUA 截图；第二次任务 `approval=null`，且两个 ephemeral thread 都没有出现在 Codex session/archived session 目录。

## macOS primitive fallback

- CoreGraphics 输入使用 Quartz point 坐标。
- `state.screen.width/height` 是 Quartz point 尺寸；`scaleFactor` 是 Retina backing scale；`backingPixelWidth/Height = point size * scaleFactor`。
- 不把 `CGDisplayPixelsWide/High` 单独视为 backing 像素，因为当前系统上下文中它可能仍返回 point 尺寸；原值仅作为 `quartzReportedWidth/Height` 诊断字段。
- `state/windows` 使用 CoreGraphics `CGWindowListCopyWindowInfo`，不依赖 System Events 枚举整个桌面。
- 鼠标与快捷键使用 CoreGraphics event；组合键通过 event flags（Command/Control/Option/Shift）而不是把修饰键当普通 keycode。
- 文字输入由 Rust `core-graphics` 直接发送 Unicode `CGEvent`，不再通过 `System Events.keystroke`，避免额外的 Apple Events Automation 权限；调用方仍应先让目标编辑控件获得焦点。
- Accessibility 搜索从目标应用窗口开始，带 depth/visited 上限，避免逐节点 Apple Events 查询超过 MCP 的 30–45 秒请求预算。

2026-09-08 primitive 实机验证：Mac cursor 可精确移动到 (400,400) 并恢复；Chrome 地址栏可作为 `AXTextField` 找到；独立测试进程可通过 CoreGraphics 输入文本。这套 primitive 现在只保留作诊断/回退，不是 ChatGPT 驱动 Mac GUI 的主路径；主路径使用上面的官方 CUA，并由其自身权限模型管理截图和输入。

## macOS TCC

Post Event/Accessibility 与 Screen Recording 是独立权限。`desktop-helper.mjs permissions` 只读返回 `postEvents` / `screenCapture`；`permissions request` 只调用 macOS 官方 `CGRequestPostEventAccess` / `CGRequestScreenCaptureAccess`，不修改 TCC 数据库，也不能替用户批准。

正式 helper 只有在相应 preflight 为 `true` 后才应被宣称具备输入或截图能力。Screen Recording 未授权时 `screencapture` 必须返回原始失败信息，不能尝试绕过 TCC。

在 Retina 屏上，若 `screencapture` 返回 backing-resolution PNG，截图像素坐标映射到 CoreGraphics 输入坐标时必须除以 `scaleFactor`；实际 PNG 尺寸以 helper 返回的 `width/height` 为准。

## 安全与副作用

- helper 不监听 LAN，不通过 Secure MCP Tunnel 直接暴露 HTTP 服务。
- 远程跨机工具只负责在目标机调用 loopback client；不得把 Win32/CGEvent 输入直接放进 SSH 子进程实现。
- UIA/Accessibility 优先于坐标点击；坐标动作前应读取最新 state/screenshot。
- macOS TCC、Windows 会话边界和应用自身安全提示都必须原样保留，不能为了自动化绕过系统边界。
