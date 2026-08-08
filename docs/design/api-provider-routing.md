# 多 API 与智能 Provider 路由

## 产品边界

API 接入属于 `codex-plus.exe` 的正式功能，不创建独立管理页面或辅助 EXE。仅支持 OpenAI 兼容的 Responses 与 Chat Completions 协议。官方 ChatGPT 登录、账户 vault 和原生账户控制保持独立且同时可用。

个人资料菜单顺序固定为：设置 → API 接入（Lucide `Cable`）→ 切换账户 → 退出登录。

## 数据与 bridge

`%LOCALAPPDATA%\codex-plus\providers.json` 是版本化数据文件，结构为 provider 列表：

- provider：`id/name/baseUrl/apiKey/protocol/enabled/models`；
- model：`routeId/modelId/displayName/visible`；
- `routeId` 由 provider ID 与真实 model ID 的 SHA-256 摘要生成，在编辑和重新发现后保持稳定；不同 API 的相同 model ID 得到不同 routeId；
- API Key 按用户选择明文保存，写入使用同目录临时文件、flush 和原子替换。

renderer 只使用 `/api-providers/list|discover|save|delete|catalog`。`list` 只返回 `hasApiKey`，`catalog` 只返回可见模型描述；两者都不得包含 key。bridge 失败日志只写路由和错误文本，不记录请求 payload。

`discover` 规范化 URL 后在用户填写的精确 base URL 后追加 `/models`，不得自行插入 `/v1`；需要版本前缀的服务由用户在 base URL 中提供。请求使用 Bearer Key。首次发现的模型默认全部可见；重新发现按真实 model ID 保留 alias、visible 和 routeId，新模型默认隐藏。启用的 API 必须至少有一个可见模型。

## 单 broker provider

启动顺序是：`stop → lock → broker → config → launch → inject`。broker 固定监听 `127.0.0.1:57321`，只接受 codex-plus 配置的本机 Bearer token。

用户级 `config.toml` 只增量维护：

```toml
[model_providers.codex-plus-api]
name = "codex-plus API broker"
base_url = "http://127.0.0.1:57321/v1"
wire_api = "responses"
experimental_bearer_token = "codex-plus-loopback"
```

不得改写顶层 `model_provider`、官方 `auth.json`、其他 provider 或未知配置。第一次变更前保留 `config.toml.codex-plus.bak`。

broker 从请求的 `model` 读取 routeId，加载对应 provider 与真实 model ID，替换后并发转发。Responses 上游保持原协议和 SSE；Chat Completions 上游转换输入、非流式响应和流式事件，保留工具调用、推理内容、usage 与错误隔离。不存在、停用或隐藏的 routeId 必须明确失败，绝不回退到其他 API。

## 原生模型目录与路由

注入模型 descriptor 时：

- `model/id/slug` 使用 routeId；
- `displayName` 使用用户 alias；
- `description` 显示 API 名称和真实 model ID。

模型选择写入 renderer 本地选择状态。创建任务时同时修正 `model` 与 `modelProvider`：官方模型使用 `openai`，API 模型使用 `codex-plus-api`。`thread/list` 的 `modelProviders` 固定为空数组，使两个 provider 的任务同时可见。

同 provider 的 API→API 切换只覆盖下一次 `turn/start.model`。跨 provider 切换是受控实验：仅空闲任务允许执行 `thread/shutdown` 后带目标 model/provider `thread/resume`；验证返回 provider 后才更新选择和允许下一条消息。失败时尝试用原 model/provider resume，并把失败暴露给 UI；不得静默新建任务或把请求发送到错误 provider。

## 验收不变量

- 密钥不出现在 bridge 摘要、模型目录、DOM 或日志；
- 两个 API 可同时流式工作，相同真实模型名不会串线；
- 官方 provider 不受 API 保存、删除或模型选择影响；
- API 出错只影响命中的 routeId；
- Codex 重建 target 后三类注入脚本可重复安装且不产生重复菜单项。
