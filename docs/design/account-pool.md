# 固定订阅 API 与账户池

## 目标与接入

“API 接入”始终列出一个不可删除的“ChatGPT 订阅 API”（`chatgpt-subscription`），默认停用。
它自动复用“切换账户”中已有的账户；勾选表示允许消耗该账户额度，上下移动决定优先顺序，
不另建凭据管理。模型别名、可见性与普通 API 共用编辑器和重新发现规则。
未勾选和后续新导入的账户都不自动参与。手动切换、导入、网页登录入口保持原有职责。

配置在 `.codex-plus/subscription.json`，只保存启用、recordId 顺序、模型设置及可选 HTTP 代理；
失效凭据版本在 `.codex-plus/subscription-rejected.json`，不含 token。真实凭据仍只有账户 vault 一份。
模型使用稳定的 `cp-pool-` routeId，显示为“订阅 · 模型别名”。

订阅复用现有单一 broker，不增加程序或管理页面。原生 provider 为 `codex-plus-account-pool`，
声明 `capabilities.remote_compaction="v2"`、HTTP/SSE 和无需官方登录认证；普通 API 的
`codex-plus-api` 能力不变，两者监听同一端口。目录明确区分 API profile 的 `providerId`
与原生 Codex 的 `nativeProviderId`，不能让渲染器从 profile ID 猜测原生 provider。
同一订阅 provider 内换实际账户不重启 Codex、不改实时 auth.json，不产生新 thread。
从官方或普通 API provider 迁入仍遵循现有跨 provider 原生分支确认流程。

订阅 provider 独立使用同一个 broker 的 `/subscription/v1`；普通 API 保持 `/v1`。
官方 app-server 在 `ModelDownshift` 前置压缩时会沿用历史上一轮的真实模型 ID，
例如 `gpt-6.1-sol`，即使当前 turn 已使用 `cp-pool-...`。订阅专用路径仅在配置
已启用且模型可见时接受真实 ID 或稳定 routeId，仍完整转发 `compaction_trigger`。
普通 `/v1` 不猜测裸模型属于哪个账户池；旧 `cp-pool-...` 请求继续兼容。
上一模型未获订阅配置允许时明确失败，不自动消费隐藏模型或其他 API。

## 原生自动审批

官方 `0.163.0-alpha.10.2` 的自动审批使用独立 reviewer 模型 `codex-auto-review`，
而不是被发送消息的目标对话模型。该模型在原生目录隐藏，不能用普通可见模型白名单拦截。
旧 broker 在审批阶段返回本机 404，MCP 动作因此没有执行；读取历史等无需审批的工具仍可用。

同一 broker 的 `/subscription/v1/responses` 与 `/v1/responses` 只对精确的裸模型 ID
`codex-auto-review` 使用原生订阅池。普通 API 对话的审批也使用该官方 reviewer，
消耗用户已启用账户池中已勾选账户的额度；对话生成仍走原 API，不修改目标模型或 provider。
不将审批提示词交给第三方 API，也不把 reviewer 替换成普通生成模型。
该内部路由不加入可选目录，不放开其他隐藏模型、前缀近似模型或任意裸模型；普通路由限制不变。

账户池必须已经启用、有参与账户且保留可见生成模型；否则返回 `pool_review_unavailable`，
提示用户启用池或在官方界面选择人工审批。不得静默启用、借用未勾选账户、关闭审批或生成批准结果。
请求指令、结构化输出 schema 和官方批准/拒绝输出原样保留，续期、额度冷却和输出后禁止重放规则不变。

`CODEX_PLUS_NATIVE_BIN=<官方 codex.exe> cargo test native_mcp_auto_review -- --nocapture`
使用临时 CODEX_HOME、假账户、mock 上游与不联网的 fixture MCP，覆盖两个 provider 的
工具搜索、实际审批、批准仅执行一次、拒绝不执行，不向用户对话发送消息。

## 模块职责

- `AccountVault` / `accounts/credentials.rs`：凭据读取、席位身份、原生续期及跨进程互斥；手动切换与导入共享续期锁。
- `ApiIntegrations`：外部 API 和固定订阅入口的统一列表、模型发现、目录、路由解析；bridge 和 broker 共享同一实例。
- `subscription/`：有序调度和账户状态；`config.rs` 管配置与目录，`transport.rs` 管原生请求、SSE 和错误分类。
- `broker.rs`：HTTP Adapter；`BridgeService`：页面 bridge Adapter。两者不重复读取和拼接两种 API 的目录。
- `assets/api-providers.js`：普通 API 与订阅共用模型编辑器；`assets/renderer.js` 只管理账户 UI。

## 原生凭据与验证

2026-10-23，macOS 官方 Codex CLI `0.163.0-alpha.11` 的现有 auth.json 在
`https://chatgpt.com/backend-api/codex/responses` 完成真实最小推理（HTTP 200、
`response.completed`、预期文本完全一致）。只使用现有 access token，没有刷新或改变生产登录。
这类 Codex 原生凭据与 SIWC 的 `chatgpt.tokens.use.direct` 授权不是同一种接入。
不得把原生 token 任意改投 public API，也不把普通 API Key 当作订阅凭据。

## 路由与失败边界

- 每次按保存顺序选账户。凭据有效时优先继续使用排在前面的账户；该账户受限时跳过，再用后一个。
- 401 最多续期后重试一次；第二次 401 或终止性 OAuth 错误按失败凭据版本阻断。
  保存顺序、换模型、重建路由实例都不能解除阻断；实际 token 变化后恢复。记录精确失败版本，避免并发导入的新凭据被旧错误误封。
- 模型发现与对话共用上述认证策略；已知坏 auth 不能因反复点击“读取模型”再次续期。
- 额度和模型限制按账户、模型冷却，优先服务端 reset；未知 reset 使用短退避，不猜五小时。
  暂时性凭据故障按账户短暂冷却。403、未知 429、网络故障明确报错，不伪装成额度耗尽。
- SSE 在第一项输出前有界缓存，支持 HTTP 200 内的结构化额度失败；不会把两个账户的失败流和成功流拼起来。
- 第一项文本、推理或工具输出交付后绝不透明重放；之后的失败更新冷却并报告失败，避免重复工具执行。
- SSE 拆包、CRLF、UTF-8、缺少完成事件、超时及客户端断开都必须正确处理。
- 原生 v2 压缩请求与结果同样经 `/responses`；`previous_response_id`、conversation 和 item 引用不允许跨账户使用。
- 原生旧 `/compact` 和 `/responses/compact` 实测 404。订阅入口明确拒绝 legacy compact，不能伪造压缩结果。
- 请求携带完整 input，保留工具调用、工具结果和推理结构；不删未知上下文来假装兼容。
- 全部参与账户不可用时返回 `subscription_exhausted`；不自动调用未勾选账户或其他付费 API。

## 凭据所有权

只返回无令牌的配置、模型和账户状态给 renderer；错误不回显上游正文。
池使用当前登录席位时，每次读取最新实时凭据，但不主动刷新该会话，避免与官方进程竞争。
非当前席位续期使用原生 OAuth client/endpoint；每席位跨进程串行化，网络等待不占全局 vault 锁。
刷新后在 vault 锁内校验原 refresh token 和席位身份再原子写入。手动切换和导入先取席位锁、
再取 vault 锁；切换会等续期完成，使用最新 token。过期的当前席位等待官方客户端更新，池尝试后续账户。
Unix 凭据临时文件以 0600 创建，替换使用原子 rename；Windows 延用现有替换实现。

## Windows 兼容

Windows 的 OMEN/ROG 版使用相同订阅模块和各自已有的 vault，不复制其他机器的账户或配置。
代理优先采用订阅配置，其次由 reqwest 读取环境变量；没有环境代理时，通过
`WinHttpGetIEProxyConfigForCurrentUser` 只读取得当前用户的静态代理。支持统一代理与
`http=...;https=...` 中的 HTTPS 项，不把 HTTP 专用代理误用于 HTTPS。此处不执行 PAC/WPAD；
只配置自动代理的环境可在订阅页面填写明确的 HTTP/HTTPS 代理 URL。
测试使用临时 vault 和 mock 服务；部署文件不启用订阅、不选择账户、不改变实时登录。

## 验收与部署

2026-10-23 Windows 用户真实继承会话首次发送触发 `ModelDownshift`，旧版 broker
因真实模型 ID 不是 routeId 而本机 404。原来的新建订阅会话 + 手动压缩测试未覆盖
这条路径，不能据此认定生产压缩已验收；macOS 用户也尚未真实验收。
修复后的回归同时覆盖专用路径、禁用/隐藏模型拒绝与普通 API 隔离。
可选原生离线测试 `native_inherited_history_compaction_and_pool_turn` 通过环境变量
`CODEX_PLUS_NATIVE_BIN` 指定官方 app-server 二进制；它使用本地模型目录模板、临时
CODEX_HOME、假 vault 与 mock SSE，验证旧模型前置压缩后继续当前订阅 turn。
目录模板缺省来自 `~/.codex/models_cache.json`，可用 `CODEX_PLUS_NATIVE_CATALOG` 覆盖。
这是原生协议回归，真实订阅服务和用户当前对话仍需修复版 launcher 启动后验收。

79 Rust、33 JS 测试通过，覆盖顺序、停用、配额、SSE、并发续期、坏凭据跨请求跳过与导入竞态。
`scripts/verify-account-pool.mjs` 在 `/tmp/.agents/` 独立 state/CODEX_HOME 中复制现有凭据，
验证目录、A 账户工具调用、B 账户工具结果续接；实际官方 app-server 使用本项目生成的 provider 配置，
完成原生 v2 压缩后换账户，在同一 thread 正确恢复压缩前标记。响应头的 opaque recordId 核对实际账户。
配额耗尽和 OAuth 轮换通过 mock 验证，未人为耗尽真实额度或刷新生产 token。

首次实现时仅构建签名 `target/account-pool-build/release/codex-plus` 候选。用户随后于
2026-10-23 明确授权部署，已通过 `publishRelease` 原子替换 `target/release/codex-plus`，
release.json 记录源 commit `323b56a`、分支 `codex/account-pool`，base 版本仍为 0.3.3。
签名与候选文件一致性核对通过；broker/CDP 返回 200，Codex、launcher 与 Tunnel 的 PID/启动时间不变。
没有附加生产 CDP、改变登录或用户配置；当前旧进程继续运行，新功能待下次启动新版 launcher 后加载。
旧入口与发布记录保留在 `/tmp/.agents/codex-plus-deploy-subscription-W0LR6K/` 供本机回退。

## 原生页面样式兼容

2026-10-23 实机官方样式将 input/textarea/select/optgroup 的 appearance 设为 none，
导致浏览器独立预览可见的默认 checkbox 在实际应用中完全不可见。API v8 在弹窗作用域内
明确恢复 checkbox 的 appearance:auto、16px 尺寸、accent、焦点和禁用态，覆盖普通 API、
订阅启用、账户参与和模型可见性；不修改官方全局样式。回归必须带同样的原生 reset。
修复加载前，启用与账户参与仍可通过点击包裹 checkbox 的 label 文字切换；
账户出现优先序号后才启用读取模型。用户自行选择参与账户，助手不代为勾选或启用额度。
