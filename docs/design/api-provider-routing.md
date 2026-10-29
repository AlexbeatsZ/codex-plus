# 多 API 与智能 Provider 路由

## 产品边界

API 接入属于 `codex-plus.exe` 的正式功能，不创建独立管理页面或辅助 EXE。仅支持 OpenAI 兼容的 Responses 与 Chat Completions 协议。官方 ChatGPT 登录、账户 vault 和原生账户控制保持独立且同时可用。

个人资料菜单顺序固定为：设置 → API 接入（Lucide `Cable`）→ 切换账户 → 退出登录。注入目标必须由同一菜单容器中的原生“设置”与“退出登录”共同识别；顶部应用菜单即使包含“设置”也不得注入。

API 接入与账户管理共用同一套 Codex 原生化视觉约束：16×16px 菜单图标、低对比灰阶分组面板、12px 弹窗圆角、30px 紧凑按钮、Codex 蓝色主操作以及深浅主题适配。列表项使用组内分隔线，不回退到绿色强调或逐项独立卡片。

## 数据与 bridge

仓库根 `.codex-plus/providers.json` 是版本化数据文件，结构为 provider 列表：

- provider：`id/name/baseUrl/apiKey/protocol/enabled/models`；
- model：`routeId/modelId/displayName/visible`；
- `routeId` 由 provider ID 与真实 model ID 的 SHA-256 摘要生成，在编辑和重新发现后保持稳定；不同 API 的相同 model ID 得到不同 routeId；
- API Key 按用户选择明文保存，写入使用同目录临时文件、flush 和原子替换。

renderer 只使用 `/api-providers/list|discover|save|delete|catalog`。`list` 只返回 `hasApiKey`，`catalog` 只返回可见模型描述；两者都不得包含 key。bridge 失败日志只写路由和错误文本，不记录请求 payload。

`discover` 规范化 URL 后在用户填写的精确 base URL 后追加 `/models`，不得自行插入 `/v1`；需要版本前缀的服务由用户在 base URL 中提供。请求使用 Bearer Key。首次发现的模型默认全部可见；重新发现按真实 model ID 保留 alias、visible 和 routeId，新模型默认隐藏。启用的 API 必须至少有一个可见模型。

外部模型发现同时保留真实 ID 和友好名称，名称依次取首个非空字符串 `display_name`、`displayName`、`name`，均无有效值时回退 ID；兼容直接返回字符串 ID 的接口。按 ID 去重和排序，重复项可为尚无友好名称的同一 ID 补充名称。重新发现时，旧名称为空或等于 ID 的条目采用供应方名称；其他已保存名称视为自定义别名保留。`modelId`、`routeId`、可见性规则和实际请求模型 ID 不因名称变化而改变，友好名称随保存进入模型目录。

固定订阅 API 的顺序、凭据策略与原生压缩见 [account-pool.md](account-pool.md)。`ApiIntegrations` 统一所有 API 的列表、模型发现、目录和路由；bridge 使用 `/api-providers/subscription/get|save|discover` 管理固定项，复用外部 API 的模型编辑与 rediscovery 规则。

## 单 broker provider

启动顺序是：`stop → lock → broker → config → launch → inject`。broker 只监听 `127.0.0.1`，只接受 codex-plus 配置的本机 Bearer token。首选稳定端口为 43121，刻意避开 Windows 默认动态客户端端口范围 49152–65535；若该端口仍因普通占用、Windows 保留范围或 WSL mirrored networking/FSE 端口跟踪而无法绑定，必须直接绑定系统分配的空闲本机端口，并在保持该 listener 的同时把实际端口写入 Codex 配置。不能先探测再释放端口，也不能因一个固定端口失败而终止整个接管生命周期。

登录自启会在同一 launcher 进程内反复接管 Codex。每轮受管生命周期结束时必须取消并等待该轮 broker 任务退出、释放 listener，再进入下一轮；仅丢弃 `JoinHandle` 会让服务器继续运行并占住旧端口。

用户级 `config.toml` 只增量维护：

```toml
[model_providers.codex-plus-api]
name = "codex-plus API broker"
base_url = "http://127.0.0.1:43121/v1"
wire_api = "responses"
experimental_bearer_token = "codex-plus-loopback"
```

以上是首选端口示例；发生回退时 `base_url` 使用本次 broker 实际持有的端口。0.3.8 增量维护顶层 `openai_base_url`，将内置 openai 的模型流量交给受能力值保护的同一 broker；原官方 URL 记录在忽略的 native-gateway.json 中。默认 provider 仅在原为 codex-plus 两个旧 provider 时迁回 openai，其他自定义默认 provider 明确拒绝接管；官方 auth.json、ChatGPT 控制平面、其他 provider 和未知配置保持原样。第一次变更前保留 `config.toml.codex-plus.bak`。

broker 从请求的 `model` 读取 routeId，加载对应 provider 与真实 model ID，替换后并发转发。Responses 上游保持原协议和 SSE；Chat Completions 上游转换输入、非流式响应和流式事件，保留工具调用、推理内容、usage 与错误隔离。不存在、停用或隐藏的 routeId 必须明确失败，绝不回退到其他 API。

## 原生模型目录与路由

2026-10-29 手机 Remote 可见性研究见 [mobile-remote-providers.md](mobile-remote-providers.md)。
当前内嵌 CLI `0.165.0-alpha.1.2` 的隔离实测表明，下文历史设计中的 `modelProviders:null`
实际只选默认 provider，`[]` 才表示全部；0.3.8 已修正，并增加原生目录与统一 openai 网关。

注入模型 descriptor 时：

- `model/id` 使用 routeId；
- `displayName` 使用用户 alias；
- `description` 显示 API 名称和真实 model ID。

模型目录和任务请求经过 React runtime 中的真实 `AppServerRequestClient`，不经过冻结的 `window.electronBridge`。注入器必须包装最低层 `enqueueRequest`，完整保留 scheduler 的 options、dispatch 和 trace 参数，并同步更新 `models/list` Query 缓存。预热使用 `prewarmThreadStart → enqueueRequest("thread/start")`，绕过上层 `sendRequest`。

Codex `26.928.2636.0`（Windows）/`26.928.21956`（macOS）已不含旧 `setMessageHandler` host 特征，`app-initial` 的 `Txt` 导出也已对应无关函数。v17 从 React context、hook/ref/useMemo 值的能力形状发现 scope、request client 与 conversation manager，不再依赖组件源代码或压缩变量名。真实 `model/list` 成功回包、provider catalog 加载和本地 manager/client 接入后才报告模型就绪。跨 provider 分支的原生 helper 通过唯一的 `forkConversationFromLatest`/`forkConversationFromTurn`/`readResumeInputs` 合同特征识别；匹配不唯一则禁用该操作并阻止发送，不能猜一个导出调用。

缓存刷新必须先移除 codex-plus 的 `cp-` descriptor 再按当前目录重建，使 alias、visibility、provider 删除立即生效。已删除或隐藏的 routeId 不得被当作未知官方模型透传。不得全局包装 `Response.json`，以免污染无关 HTTP 响应。

v19 在真实 `model/list` 探测成功后直接记录官方模型 ID 与显示名，不依赖 Query 缓存的键形状或 `enqueueRequest` 的返回值。`cp-` 前缀始终保留给 API 路由，旧缓存中的已删除 descriptor 也不得进入官方模型字典。点击只显示官方名称的选项时，应清除持久化的 API 选择并废弃旧预热任务。

安装路由包装时必须清除安装前已经创建的预热任务；原生选择器改变模型时也必须再次清除缓存。之后的普通创建、预热创建和首轮发送都从同一 `enqueueRequest` 包装进入，保证 routeId 与 `codex-plus-api` 同时提交，不能出现 routeId 搭配 `openai` 的混合状态。

创建任务时以原生选择器实际提交的 `model` 为准，同时修正 `modelProvider`：官方模型使用 `openai`，routeId 模型使用目录明确给出的 `nativeProviderId`（网关已配置时均为 `openai`；两个旧 provider 仅用于旧任务兼容），不得用过期的 renderer 选择状态覆盖本次原生选择。`thread/list` 的 `modelProviders` 使用当前原生 CLI 已验证的 `[]` 全 provider 语义，同时原样保留 `sourceKinds`、`archived` 等目录范围参数，不改变原来源及项目范围。

同 provider 的 API→API 切换只覆盖下一次 `turn/start.model`。Codex `26.803.10989.0` 的 provider 在任务 ID 创建时固定：`thread/resume` 不能改变 provider，`thread/shutdown` 已移除，二者都不得用于跨 provider 切换。

`turn/start` 的目标模型只取本次原生请求：优先 `collaborationMode.settings.model`，其次顶层 `model`，与官方 `26.1013.3656.0` 的模型优先级一致。两处均为空时原样发送，让服务端沿用该会话设置；同步兼容入口和真实 client 包装都不得回退到全局 `selectedModel()`、localStorage 或尚未消费的官方点击状态。显式模型仍走同 provider 切换或确认后的跨 provider 历史分支，原生 collaboration 设置、调度参数和历史流程保持完整。模型选择缓存只用于界面状态，不能作为其他会话发送或分支的依据。

跨 provider 发送仅允许空闲或上一轮失败的任务，并采用明确确认的历史分支流程。确认后调用新版原生 helper（scope、hostId、sourceConversationId/model），由它提供原生 resume inputs、历史投影和任务注册；最低层路由同时写入目标 model/provider。必须确认返回 `status=created`、`synchronization.status=complete`，再 `thread/read` 验证 provider，最后才发送到新 threadId、复制原标题并导航。用户取消或任一步失败时恢复选择并阻止发送，保留原任务。v17 不再用裸 `thread/fork` fallback 创建未被 UI 注册的任务。

v21 将跨 provider 迁移提升到原生 manager 的 `executeTurnStart` 事务入口，在原生创建乐观 turn、登记 completion observer 和执行队列之前完成确认、分支和 provider 核对，并用目标会话 ID 同时调用原生事务及其 request。旧版只在 `enqueueRequest("turn/start")` 改 threadId，会让源会话持有永远收不到目标完成事件的 inProgress turn；底层现在只做同 provider 路由，发现漏过的跨 provider 请求则阻发，不能再补做隐式分支。

原生模型选择器还会先发 `thread/settings/update`。跨 provider 的 model/effort 按 hostId 与 threadId 暂存，不把目标路由写进旧 provider 的持久配置；空输入续跑从同一会话暂存恢复目标，不能读取全局选择。分支确认后恢复源会话的原生 model/effort，再在目标会话调用完整原生发送事务；取消或验证失败也恢复源设置，且不创建原生 pending turn。附件、稳定消息 ID、协作模式、调度回调和 trace 原样保留；同 provider 的模型设置仍走官方路径。单会话切换在途时拒绝重复发送，其他会话互不干扰。真实官方应用的 manager 能力需只读核对；mock 事务回归不等于已加载新版或真实生产切换验收。

旧版 `26.810.4967.0` 的 `excludeTurns` 限制不能直接套在新版上：`26.928` 原生普通 fork 为分页历史也会提交 `excludeTurns:true`，并通过自己的 history projection/resume 处理继承内容。保持原生 helper 的历史流程；不要自行添加该字段或靠返回的 turns 是否为空判断持久历史是否丢失。

## 验收不变量

- 密钥不出现在 bridge 返回值、模型目录或日志；renderer 只在用户正在编辑时保留密码输入框中的草稿；
- 两个 API 可同时流式工作，相同真实模型名不会串线；
- 官方裸模型始终归当前官方账户，外接及订阅路由精确隔离；
- API 出错只影响命中的 routeId；
- Codex 重建 target 后三类注入脚本可重复安装且不产生重复菜单项。

手机原生目录、官方凭据补充边界、HTTP/SSE 回退与旧任务显式迁入入口见 [mobile-remote-providers.md](mobile-remote-providers.md)。
