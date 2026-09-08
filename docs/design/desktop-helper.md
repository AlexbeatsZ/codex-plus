# Desktop helper

## 边界

`codex-plus` 的桌面控制不新增 MCP tool，也不依赖 ChatGPT Web 能否加载 Codex 专属 `computer-use` / `node_repl` Skill。ChatGPT 继续使用现有 `windows_run_command` / `mac_run_command`；命令只调用仓库内的薄客户端，真正的截图、鼠标、键盘和 Accessibility/UI Automation 操作在目标机登录会话中的 `codex-plus` 进程侧执行。

链路固定为：

```text
ChatGPT Web
  -> codex-plus local-tools run_command
  -> node local-tools/scripts/desktop-helper.mjs ...
  -> 127.0.0.1 desktop helper
  -> Windows Win32/UIA 或 macOS CoreGraphics/Accessibility
```

这样既不扩大 ChatGPT App 的 frozen MCP schema，也避免 Windows 远程 SSH 进程位于 Session 0 时直接注入鼠标/键盘。

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
```

任意文本通过 `text64` 传入，避免 PowerShell/Bash/SSH 多层 quoting。UI 查询可额外使用 `--window-handle`（Windows）、`--app` / `--window-title`（macOS）、`--max-depth` 和 `--max-visited`。

## 截图缓存

截图不在项目中累积任务文件，只覆盖正式运行状态目录中的单槽缓存：

```text
.codex-plus/desktop/latest.png
```

响应同时返回绝对路径、工作区相对路径和 PNG 尺寸。ChatGPT 可随后通过已有 `windows_read_image` / `mac_read_image` 读取这一文件，不需要新的 image MCP tool。

## Windows 坐标与输入

- 每个 PowerShell helper 调用首先设置 `DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2`。
- `state.screen`、窗口 bounds、截图和 `SetCursorPos` 都使用同一套物理像素坐标。
- 默认截图主屏；`screenshot --scope virtual` 可捕获整个虚拟桌面。
- 鼠标使用 Win32 输入；文字和快捷键使用 `SendInput`。
- UI Automation 返回 `Name`、`AutomationId`、`ControlType`、进程、窗口句柄和物理 bounds；支持 focus / InvokePattern / ValuePattern。

2026-09-08 实机验证：主屏为 2560x1600 物理像素、虚拟桌面跨三屏；截图为 2560x1600；鼠标移动可精确移动并恢复；隔离 WPF harness 的 UIA button/textbox 可定位，真实 click 触发 Button.Click，Unicode `SendInput` 文本可被 textbox 精确接收。

## macOS 坐标与输入

- CoreGraphics 输入使用 Quartz point 坐标。
- `state.screen.width/height` 是 Quartz point 尺寸；`scaleFactor` 是 Retina backing scale；`backingPixelWidth/Height = point size * scaleFactor`。
- 不把 `CGDisplayPixelsWide/High` 单独视为 backing 像素，因为当前系统上下文中它可能仍返回 point 尺寸；原值仅作为 `quartzReportedWidth/Height` 诊断字段。
- `state/windows` 使用 CoreGraphics `CGWindowListCopyWindowInfo`，不依赖 System Events 枚举整个桌面。
- 鼠标与快捷键使用 CoreGraphics event；组合键通过 event flags（Command/Control/Option/Shift）而不是把修饰键当普通 keycode。
- 文字输入由 Rust `core-graphics` 直接发送 Unicode `CGEvent`，不再通过 `System Events.keystroke`，避免额外的 Apple Events Automation 权限；调用方仍应先让目标编辑控件获得焦点。
- Accessibility 搜索从目标应用窗口开始，带 depth/visited 上限，避免逐节点 Apple Events 查询超过 MCP 的 30–45 秒请求预算。

2026-09-08 primitive 实机验证：Mac cursor 可精确移动到 (400,400) 并恢复；Chrome 地址栏可作为 `AXTextField` 找到；独立测试进程可通过 CoreGraphics 输入文本。正式 LaunchAgent helper 的 `state/windows` 已通过，但其 TCC preflight 当前仍为 `postEvents=false`、`screenCapture=false`，所以正式输入/截图要等用户批准后再做最终闭环。

## macOS TCC

Post Event/Accessibility 与 Screen Recording 是独立权限。`desktop-helper.mjs permissions` 只读返回 `postEvents` / `screenCapture`；`permissions request` 只调用 macOS 官方 `CGRequestPostEventAccess` / `CGRequestScreenCaptureAccess`，不修改 TCC 数据库，也不能替用户批准。

正式 helper 只有在相应 preflight 为 `true` 后才应被宣称具备输入或截图能力。Screen Recording 未授权时 `screencapture` 必须返回原始失败信息，不能尝试绕过 TCC。

在 Retina 屏上，若 `screencapture` 返回 backing-resolution PNG，截图像素坐标映射到 CoreGraphics 输入坐标时必须除以 `scaleFactor`；实际 PNG 尺寸以 helper 返回的 `width/height` 为准。

## 安全与副作用

- helper 不监听 LAN，不通过 Secure MCP Tunnel 直接暴露 HTTP 服务。
- 远程跨机工具只负责在目标机调用 loopback client；不得把 Win32/CGEvent 输入直接放进 SSH 子进程实现。
- UIA/Accessibility 优先于坐标点击；坐标动作前应读取最新 state/screenshot。
- macOS TCC、Windows 会话边界和应用自身安全提示都必须原样保留，不能为了自动化绕过系统边界。
