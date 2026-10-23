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

以上是首选端口示例；发生回退时 `base_url` 使用本次 broker 实际持有的端口。不得改写顶层 `model_provider`、官方 `auth.json`、其他 provider 或未知配置。第一次变更前保留 `config.toml.codex-plus.bak`。

broker 从请求的 `model` 读取 routeId，加载对应 provider 与真实 model ID，替换后并发转发。Responses 上游保持原协议和 SSE；Chat Completions 上游转换输入、非流式响应和流式事件，保留工具调用、推理内容、usage 与错误隔离。不存在、停用或隐藏的 routeId 必须明确失败，绝不回退到其他 API。

## 原生模型目录与路由

注入模型 descriptor 时：

- `model/id` 使用 routeId；
- `displayName` 使用用户 alias；
- `description` 显示 API 名称和真实 model ID。

模型目录和任务请求经过 React runtime 中的真实 `AppServerRequestClient`，不经过冻结的 `window.electronBridge`。注入器必须包装最低层 `enqueueRequest`，完整保留 scheduler 的 options、dispatch 和 trace 参数，并同步更新 `models/list` Query 缓存。预热使用 `prewarmThreadStart → enqueueRequest("thread/start")`，绕过上层 `sendRequest`。

Codex `26.928.2636.0`（Windows）/`26.928.21956`（macOS）已不含旧 `setMessageHandler` host 特征，`app-initial` 的 `Txt` 导出也已对应无关函数。v17 从 React context、hook/ref/useMemo 值的能力形状发现 scope、request client 与 conversation manager，不再依赖组件源代码或压缩变量名。真实 `model/list` 成功回包、provider catalog 加载和本地 manager/client 接入后才报告模型就绪。跨 provider 分支的原生 helper 通过唯一的 `forkConversationFromLatest`/`forkConversationFromTurn`/`readResumeInputs` 合同特征识别；匹配不唯一则禁用该操作并阻止发送，不能猜一个导出调用。

缓存刷新必须先移除 codex-plus 的 `cp-` descriptor 再按当前目录重建，使 alias、visibility、provider 删除立即生效。已删除或隐藏的 routeId 不得被当作未知官方模型透传。不得全局包装 `Response.json`，以免污染无关 HTTP 响应。

安装路由包装时必须清除安装前已经创建的预热任务；原生选择器改变模型时也必须再次清除缓存。之后的普通创建、预热创建和首轮发送都从同一 `enqueueRequest` 包装进入，保证 routeId 与 `codex-plus-api` 同时提交，不能出现 routeId 搭配 `openai` 的混合状态。

创建任务时以原生选择器实际提交的 `model` 为准，同时修正 `modelProvider`：官方模型使用 `openai`，routeId 模型使用目录明确给出的 `nativeProviderId`（普通 API 为 `codex-plus-api`，订阅为 `codex-plus-account-pool`），不得用过期的 renderer 选择状态覆盖本次原生选择。`thread/list` 的 `modelProviders` 固定为当前官方客户端使用的 `null` 全 provider 哨兵，同时原样保留 `sourceKinds`、`archived` 等目录范围参数；不得再使用旧的空数组语义扩大本地目录扫描范围。

同 provider 的 API→API 切换只覆盖下一次 `turn/start.model`。Codex `26.803.10989.0` 的 provider 在任务 ID 创建时固定：`thread/resume` 不能改变 provider，`thread/shutdown` 已移除，二者都不得用于跨 provider 切换。

跨 provider 发送仅允许空闲或上一轮失败的任务，并采用明确确认的历史分支流程。确认后调用新版原生 helper（scope、hostId、sourceConversationId/model），由它提供原生 resume inputs、历史投影和任务注册；最低层路由同时写入目标 model/provider。必须确认返回 `status=created`、`synchronization.status=complete`，再 `thread/read` 验证 provider，最后才发送到新 threadId、复制原标题并导航。用户取消或任一步失败时恢复选择并阻止发送，保留原任务。v17 不再用裸 `thread/fork` fallback 创建未被 UI 注册的任务。

旧版 `26.810.4967.0` 的 `excludeTurns` 限制不能直接套在新版上：`26.928` 原生普通 fork 为分页历史也会提交 `excludeTurns:true`，并通过自己的 history projection/resume 处理继承内容。保持原生 helper 的历史流程；不要自行添加该字段或靠返回的 turns 是否为空判断持久历史是否丢失。

## 验收不变量

- 密钥不出现在 bridge 返回值、模型目录或日志；renderer 只在用户正在编辑时保留密码输入框中的草稿；
- 两个 API 可同时流式工作，相同真实模型名不会串线；
- 官方 provider 不受 API 保存、删除或模型选择影响；
- API 出错只影响命中的 routeId；
- Codex 重建 target 后三类注入脚本可重复安装且不产生重复菜单项。
