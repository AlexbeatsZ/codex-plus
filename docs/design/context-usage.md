# 原生上下文浮窗中的 Token 用量

沿用输入框下方上下文圆环的原生 tooltip，在窗口占用量之后附加当前会话累计统计：
输入、缓存输入、缓存命中率、输出、其中推理。不创建独立页面，不替换原生上下文占用量。

统计优先读取该原生 tooltip 的 React 祖先已经订阅的 TokenUsageInfo，展示其中的
`total`。按 `total` / `last` 和 token 字段识别数据，不依赖组件名、压缩变量名或 hook
序号；对于原生 external store hook，通过其共享 queue 的 getSnapshot 读取当前订阅，
避免 DOM 指向旧 React alternate 时数值停更。只沿所属 tooltip 的祖先查找，遇到最近
conversationId / threadId 边界即停止；没有明确会话身份不能使用统计。

旧版原生界面没有该订阅数据时，仍通过模型路由模块按 hostId / threadId 查询
conversation manager 的 `latestTokenUsageInfo`。原生订阅明确返回空或读取失败时保持
未知，不退回旧 manager 的过期数据。不额外查询账户，不读取凭据，不请求推理。
原生 `thread/tokenUsage/updated` 负责更新状态，浮窗仅展示已有数据。

0.3.12 修复新版官方 bundle / manager 发现变化后累计全部显示 `—`：原生用量仍然存在，
而旧路由模块未发现 conversation manager，导致其 tokenUsage 入口始终返回 null。
显示统计不再依赖模型路由模块安装成功。该修复不改变模型路由或跨 provider 分支逻辑。

缓存命中率为 `cachedInputTokens / inputTokens`。缓存输入已包含在输入中，推理已包含
在输出中，两者均不能重复相加；输出没有缓存命中率。缺失数据显示 `—`，不能当作零。
会话累计与原生上下文占用量不同：多次工具往返可重复计入累计输入。

仅在原生 tooltip 匹配上下文标题后插入，使用其 React 祖先的会话身份，必要时采用明确的
thread 路径；不能使用其他会话的全局选择或最近一次统计。会话身份或宿主数据不可得时显示未知。
浮窗存在时每 750ms 更新；卸载后停止计时。重新注入销毁旧 observer、计时器和附加块。

首发构建按用户要求未测试；随后授权的真实订阅隔离验证已记录于项目日志。
0.3.12 已在本机真实应用上只读核对多个会话的祖先订阅与修复后读取结果，并以隔离 DOM
覆盖累计值、缓存比例、会话隔离、订阅刷新、旧版 fallback 与销毁。真实浮窗未目视验收，
运行生效需启动新版 launcher。
