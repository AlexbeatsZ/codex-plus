# 手机 Codex 的外接模型与任务可见性

## 范围与状态

2026-10-29 用户确认问题发生在手机 ChatGPT 的 Codex 远程电脑入口：外接 API / 聚合订阅任务
不显示或刷新后消失，同时无法选择这些模型。本文件记录研究与 0.3.8 的原生兼容实现；手机实机验收仍待加载新版后进行。
普通 ChatGPT 聊天的 MCP Connector / Secure MCP Tunnel 不属于这次故障链路。

基线为 main `920870a`；`git pull --ff-only` 已核对最新，Windows 两条远端分支无额外公共功能差异。
本机官方应用为 `26.1023.51421`，内嵌 CLI 为 `0.165.0-alpha.1.2`。
本轮没有重启、热附加或替换正式 launcher，没有修改登录、账户池参与账户或设备配对。

## 当前链路的缺口

- `src/config.rs` 注册 `codex-plus-api` 与 `codex-plus-account-pool` 两个原生自定义 provider。
  顶层默认 provider 保持官方配置，通常为 `openai`。
- `assets/model-routing.js` 在桌面 renderer 中包装 `enqueueRequest`，修改 `thread/list` 参数，
  为 `model/list` 返回值和 Query 缓存追加 `cp-*` 模型，再将创建/发送请求路由到上述 provider。
- 手机不是该 renderer 的另一份页面。桌面 CDP 注入不能保证改变手机请求及其模型目录，
  所以本地模型选择器正常并不等于手机可发现这些模型。
- broker 的 `/v1/models` 返回 OpenAI 兼容 HTTP 目录，但手机 Codex 使用的原生 `model/list`
  没有自动接上该目录；仅向 broker 增加 HTTP endpoint 不能补齐这一层。

0.3.7 有一个可单独复现的协议漂移（0.3.8 已改为 `[]`）：`routeParams("thread/list")` 强制使用
`modelProviders: null`，旧设计把它视为全 provider。当前官方内嵌 CLI 实测不是这个语义。

## 已验证的原生行为

`scripts/verify-native-mobile-providers.mjs` 使用临时 `CODEX_HOME`、本地模型模板、假凭据与
loopback mock HTTP/SSE 服务，不读取真实登录凭据，不发送真实模型请求，也不启动桌面应用。
原生 app-server 实际创建并完成三个不同 provider 的假任务后：

| `thread/list.modelProviders` | 返回的 provider | 个数 |
| --- | --- | --- |
| 省略 | `openai` | 1 |
| `null` | `openai` | 1 |
| `[]` | `openai`、`codex-plus-api`、`codex-plus-account-pool` | 3 |
| `["codex-plus-api"]` | `codex-plus-api` | 1 |

因此旧桌面包装的 `null` 会让自定义 provider 任务被默认过滤。手机的实际 RPC 参数本轮没有抓取，
不能宣称已观测到手机一定发送 `null`；其“刷新后消失”症状与原生默认过滤及社区报告一致。

另做了两个可行性验证：

1. 通过原生 `model_catalog_json` 加载两个假的 `cp-*` 模型，原生 `model/list` 确实返回它们，
   无需 renderer 改写返回值。这验证了主机原生目录的接入点，尚未证明手机选择器会原样展示。
2. 使用顶层 `openai_base_url` 指向隔离 mock，保持任务 provider 为小写 `openai`。
   同一个任务先后用假外接 API route 和假聚合订阅 route 完成两轮，默认 `null` 列表仍能发现它。
   这是前期统一 provider 的协议原型；下文 0.3.8 已将该模式接入生产 broker。

当前 CLI 会拒绝 `[model_providers.openai]`，报 reserved built-in provider ID；不能用覆盖该表
冒充受支持的配置方案。保留小写 `openai` 的原型采用顶层 `openai_base_url`。

执行：

```bash
node scripts/verify-native-mobile-providers.mjs \
  --binary=/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex \
  --catalog=/Users/meta/.codex/models_cache.json
```

Windows 显式传入其官方内嵌 `codex.exe` 与本机目录模板路径；尚未在 Windows 运行此新增探针。
脚本在 finally 中终止自己的隔离 app-server、关闭 mock 并删除临时目录。
当前精确列表断言针对上述 CLI 版本；官方语义改变时应核查协议后更新，不能机械改断言。

## 社区实现与边界

- [openai/codex #24780](https://github.com/openai/codex/issues/24780)：自定义 Responses provider
  任务能在主机执行，手机刷新后不可见，官方 `openai` 任务正常；2026-10-29 查询仍 open。
  这是直接匹配症状的用户报告，不是官方确认所有版本都使用相同过滤代码。
- [openai/codex #36879](https://github.com/openai/codex/issues/36879)：自定义 provider 的模型凭据
  与 ChatGPT 控制平面凭据被混淆，导致 Remote 入口隐藏；本次用户能进入主机，优先级低于任务可见性。
- [cluic/codex-remote-proxy](https://github.com/cluic/codex-remote-proxy)：保持 ChatGPT 登录，
  在本机代理内部切换上游；统一模型流量入口，独立处理控制平面身份，是可复用的架构思路。
  核查源码 `c5110ccc29b440d11ce3936a74f5d7f775892e71` 时，其目标 ID 实际是大写 `OpenAI`，
  并非本机内置的小写 `openai`；它还会在特定配置迁移时改写 rollout/SQLite 的 provider 元数据。
  不能把 README 的“内置身份”表述直接当作当前 CLI 的事实，也不能整包执行其历史修复。
- [CC Switch 的 Codex 投影实现](https://github.com/farion1231/cc-switch/blob/4ed071500b07ba5801be84c96ddb4e03bdf48a2d/src-tauri/src/live/project/codex.rs)：
  把官方登录与第三方推理凭据分别保存，并按凭据形式管理 `requires_openai_auth`；源码同时说明
  provider ID 大小写敏感，`OpenAI` 是合法自定义 ID。可借鉴身份分离，单改该标志不能补齐模型目录或列表过滤。

官方 [Remote connections](https://learn.chatgpt.com/docs/remote-connections) 描述手机使用连接主机的
会话、文件、凭据、权限与工具；没有承诺桌面第三方 renderer 扩展会同步到手机。
当前官方开源 [thread_processor.rs](https://github.com/openai/codex/blob/875a1a78f06731a8ecd20dd45378f61bd9c7701d/codex-rs/app-server/src/request_processors/thread_processor.rs)
也区分空数组与未指定 provider：空数组不设 provider filter，未指定使用当前配置 provider。

## 0.3.8 实现

原生目录与推理共用现有 broker，新增 `/native/<随机能力值>/backend-api/codex` 本机入口。
启动时增量维护顶层 `openai_base_url`；保留小写 `openai` 身份、原有官方认证和两张旧 provider 表。
`.codex-plus/native-gateway.json` 仅保存原始 URL、可选目录路径与本机能力值，不保存 OAuth 或 API Key。
当前官方客户端会省略发往自定义 origin 的 OAuth；网关仅在转发到可信官方端点时只读补充实时登录，
不续期、不改写 auth.json，不把该凭据送到外接 API。已有自定义原始端点不能自动借用官方登录。

`/models` 返回原生模型信息，并在 3 秒内尝试更新官方模板，网络失败保留旧模板。
模板依次采用用户显式目录、上次成功官方目录、本机 models_cache；滤除旧 cp-* 项后追加当前可见模型。
匹配真实 ID 的模型保留原始能力，未知模型采用 32K / 文本 / 不声明推理档位的保守能力；外接 route 禁用 Responses Lite。
原生客户端自行管理目录缓存；更改 API 后手机的出现时间取决于官方目录刷新。显式静态目录模式仅启动时更新。
WebSocket 握手返回官方支持的 426，让同一原生会话切换为 HTTP/SSE，避免跨上游复用有状态连接。
zstd 请求有解压上限，官方响应及凭据错误原样转发；cp-* 则使用原有精确 API/订阅路由，失效不回退。

普通裸模型和原生 reviewer 归当前官方账户，旧 provider 的 reviewer 路由保持既有订阅池规则。
原生 v2 compaction_trigger 和 /responses/compact 通过按 thread-id/session-id 持久化的最后渠道保持归属；
无法核对历史真实模型与渠道时明确失败，不能误用官方账户。

以下分工已落地：

1. **原生模型目录**：从现有官方目录模板与已启用、可见的 API/订阅模型生成受管原生目录，
   保持稳定 routeId、友好名称与真实能力字段。让手机和桌面查询原生 `model/list` 都有结果；
   不能把所有模型盲目复制为相同上下文、工具能力或推理档位。
2. **统一新任务的 provider**：保持小写 `openai`，由现有 broker 承接官方、外接 API 与
   聚合订阅的路由，避免手机默认枚举排除新任务。只将模型流量交给 broker；配对、插件及其他
   ChatGPT 控制平面继续使用原有官方登录。
3. **显式区分实际渠道**：继续用稳定的 `cp-*` routeId 区分同名模型，复用当前启用、可见性、
   已选账户、额度保留与失败边界。官方模型仍应走当前官方账户，不静默消费订阅池；内部 reviewer、
   压缩、Responses Lite/WebSocket 等路径需要单独适配。保持单 launcher、单 broker 和现有面板。
4. **旧任务独立处理**：新任务统一 provider 不会自动修复已存为 `codex-plus-*` 的旧任务。
   现有“API 接入 → 迁移旧任务”面板调用原生完整历史 fork，显式选择旧任务和目标模型后创建 `openai` 分支，
   核对 provider 后导航；原任务保留。不得直接批量 UPDATE 正在使用的 SQLite / rollout，也不得把模型目录修复说成历史迁移完成。
5. **桌面过滤修正**：当前 CLI 应使用 `[]` 表达全 provider，同时原样保留 sourceKinds、archived、
   project/cwd 等范围参数。此项修正桌面请求；手机的新任务由原生网关提供兼容。

此实现同步更新了 api-provider-routing.md / account-pool.md 的 provider 边界；旧 provider 仅保留给旧任务。
若手机只接受固定模型目录或仍单独过滤 routeId，应继续调查官方远程主机协议；本轮没有手机实机验收。

## 验收

- 两个同名模型分属不同外接 API、聚合订阅与官方账户，手机能够区分和选择，broker 命中正确渠道。
- 从手机创建、退出再进入、刷新后任务持续可见；电脑与手机交替续接仍保持 provider 与 route。
- 旧任务完整历史分支在手机可见且能续接；原任务、附件、工具记录与原始会话保持完整。
- 真实手机验证前先跑原生 mock 的官方/API/订阅、压缩、审批和失败路径；不隐式使用真实账户验证。
- Windows 与 Mac 分别验证，源码、构建、文件部署与运行实例更新分别记录。

2026-10-29 Mac 内嵌 CLI 原生 mock 已通过：动态 model/list、同任务三渠道、订阅压缩与续接、旧任务 fork 完整历史、默认列表可见、原任务保留。
脚本 `scripts/verify-native-mobile-gateway.mjs` 由 Rust `native_mobile_gateway_uses_three_channels_and_preserves_fork_history` fixture 调用。
探针的原生客户端使用无已选工作区的假 ChatGPT 身份，绕开独立的实时 HTTPS 工作区发现；broker 保留单独的假实时账户。
不代表真实配对或手机 UI 验收，未使用真实模型请求。
