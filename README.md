# codex-plus

`codex-plus` 是一个面向 Windows 官方 OpenAI Codex 桌面应用的轻量账户切换器。它只有一个可执行文件，没有独立管理面板：正常点击 `codex-plus.exe` 后，程序会受控重启 Codex，并把账户管理入口注入左下角个人资料菜单。

## 功能

- 在“设置”和“退出登录”之间注入带双用户图标的“切换账户”。
- “账户”页立即显示本地账户和切换按钮，额度随后按账户异步加载。
- “导入账户”页支持直接粘贴 `auth.json`，或读取任意文本文件后再确认导入。
- 切换账户时先停止 Codex、原子替换认证文件，再自动重新启动并恢复注入。
- 账户令牌只保存在本机，不返回给注入页面，也不写入日志。

## 使用

1. 构建或取得 `codex-plus.exe`。
2. 双击启动。程序会关闭当前 Codex，再以注入模式重新打开。
3. 点击左下角个人资料，在“切换账户”中导入、查看额度或切换账户。

导入只保存账户，不会自动切换；切换账户会自动重启 Codex。当前有效 ChatGPT 登录会自动加入本地账户列表。

账户快照位于 `%LOCALAPPDATA%\codex-plus\accounts\`，运行日志位于 `%LOCALAPPDATA%\codex-plus\codex-plus.log`。

## 构建与测试

```powershell
npm install
cargo fmt --all -- --check
cargo test
npm run check
npm test
cargo build --release
```

发布产物：`target\release\codex-plus.exe`。

开发时可以使用 `codex-plus.exe --attach-existing` 附加已在 `9229` 开启 CDP 的 Codex；该模式不会执行正常入口的重启流程。

## 支持范围

首版支持 Windows 11 上的 Microsoft Store `OpenAI.Codex`，并兼容可发现的 `OpenAI.CodexBeta`、`OpenAI.ChatGPT-Desktop` 与常见独立安装目录。
