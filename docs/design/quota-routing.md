# 登录额度与 API 发送入口隔离

## 需求与原生限制

登录的 ChatGPT 账户耗尽时，用户已配置的外接 API 和已启用订阅池仍应能够接收消息。
官方模型继续使用当前登录账户并遵守官方额度；未选账户、停用渠道和隐藏模型不获得额外授权。

Codex 26.1103 的前端在请求发往 broker 前，使用原生账户额度状态与 Reserve 状态阻止发送。
这不是上游 API 的额度错误。仅修改 broker、HTML button.disabled 或伪造 /wham/usage 都不能正确解决。
Mac 26.1103.60933 与 Windows 26.1103.4239.0 使用相同 scoped-state 合同，但 UI 的发送禁用参数不同。

参考：
- OpenAI Codex [#48369](https://github.com/openai/codex/issues/48369)：外接 provider 在官方账户耗尽后仍被全局发送限制拦截。
- CC Switch [聚合模式说明](https://github.com/farion1231/cc-switch/blob/main/docs/user-manual/en/4-proxy/4.6-aggregation.md)：同类客户端限制及暂时移开登录的方案；本项目保留登录和统一任务身份，不采用移开凭据的方式。

## 实现边界

`assets/quota-routing.js` 从页面已加载的 Rspack 入口取得原生 require。对明确的原生模块源码合同、
ComposerScope 与 descriptor 能力共同校验；不能匹配时保持原生行为。它不修改安装包或原始 usage 数据。

适配点是额度阻断 descriptor，以及 Reserve 的状态/active/hardBlocked family。在每次原生 resolve 中，
只有调用链包含 ComposerScope 时，才返回该 composer 独立的原生 atom 投影；个人资料、用量显示与其他
调用链继续读取原始 atom。投影仍订阅原始额度状态，并由原生 store 追踪模型状态。

模型来源按原生语义读取：
1. 当前会话/默认配置的待应用模型选择；
2. 当前新草稿的私有原生 modelSettings；
3. 当前会话的 collaborationMode.settings.model；
4. 该 host/cwd 的原生 config 模型。

草稿 family 不公开，通过相同 draft key 的已绑定 signal 和完整状态形状定位，读取真实 atom 建立订阅。
不能以其他会话、全局 localStorage 选择或过去一次模型点击作为依据。明确选择官方模型时不再回退。
只有当前 bridge 目录存在的 routeId 才获得投影；loadCatalog 刷新原生 revision atom，移除/停用/隐藏后立即撤销。
未知模型、无法读取的选择、非本机执行和普通 ChatGPT composer 保留原生限制。

投影仅解除当前 API/订阅池 composer 的登录额度与 Reserve 误限制。不触碰策略限制、审批、附件准备、
环境忙碌、并发队列、原生请求内容、账户登录或 token。实际余额、账户池保留阈值与上游错误仍由既有路由处理。

## 原生 reviewer

统一 openai 网关在原生 x-codex-parent-thread-id（旧版回退 thread-id/session-id）已记录有效且仍可见的 cp-* 父渠道时，精确的
`codex-auto-review` 使用既有已启用订阅池，与旧 API provider 的 reviewer 规则一致。
请求保留 reviewer 模型、指令、input、结构化 schema 和批准/拒绝结果；不得送给外接生成 API。
原生 guardian 使用独立子线程，显式父头优先且不可被其他 session 覆盖；旧版仅恢复已记录的 thread/session 关联。
普通官方父渠道、缺少可确认关联的 reviewer 保留当前官方账户归属；不猜测父任务。
池停用或无参与账户仍明确报错，不自动启用或降低审批要求。reviewer 不覆盖会话上次生成渠道。

## 验证

- `npm test`：真实 Jotai store 上验证两会话隔离、模型切换订阅、独立草稿、待应用选择、目录撤销、
  Reserve family、未知/远程上下文及恢复原生 descriptor。
- `npm run native:quota -- <app.asar>`：直接从已安装客户端提取实际 quota/Reserve/scoped-state 模块，
  在隔离 Node 进程中使用合成身份和额度。验证真实 scope、signal-family 与 atom 依赖，不启动桌面进程，
  不读取凭据，不发送网络请求。Mac 可省略路径。
- `cargo test`：包含 native 网关、订阅 reviewer 和凭据归属回归。
- 测试与正式文件部署不能代替真实客户端发送验收；部署记录区分版本文件和已加载进程。
