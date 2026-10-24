# codex-plus domain

- **Account / 账户**: one saved ChatGPT user seat in a workspace. `recordId` is the local identity; workspace account ID alone is not a unique seat. AccountVault owns credentials and manual sign-in switching.
- **External API / 外部 API**: a user-configured OpenAI-compatible provider with URL, API key and model settings.
- **Subscription API / 订阅 API**: the fixed ChatGPT subscription entry in API integration. It reuses AccountVault; policies select whether and in which order account quotas may be used. It is not a second credential store.
- **Model route / 模型路由**: stable local model ID exposed to Codex. Profile identity and native Codex provider identity are distinct.
- **Account health / 账户状态**: credential rejection is account-wide until credentials change; quota/model restrictions are scoped to the relevant model and have bounded cooldowns.
- **Stream commitment / 输出交付**: once any text, reasoning or tool output is delivered, transparent retry is forbidden to avoid duplicated work.

Design entry points: docs/design/account-switch-lifecycle.md, docs/design/api-provider-routing.md, docs/design/account-pool.md.
