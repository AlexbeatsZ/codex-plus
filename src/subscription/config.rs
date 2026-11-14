use super::*;

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SubscriptionConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub auto_activate: bool,
    #[serde(default)]
    pub account_order: Vec<String>,
    #[serde(default)]
    pub models: Vec<crate::providers::SaveModel>,
    #[serde(default)]
    pub proxy_url: String,
    #[serde(default)]
    pub account_reserves: HashMap<String, AccountReserve>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AccountReserve {
    #[serde(default)]
    pub short_term_percent: Option<u8>,
    #[serde(default)]
    pub long_term_percent: Option<u8>,
}

impl AccountReserve {
    pub fn enabled(&self) -> bool {
        self.short_term_percent.is_some() || self.long_term_percent.is_some()
    }
}

impl SubscriptionConfig {
    pub fn load(paths: &AccountPaths) -> anyhow::Result<Self> {
        crate::store::load(&paths.state_dir.join("subscription.json"), "账户池配置")
    }

    pub fn save(&self, paths: &AccountPaths) -> anyhow::Result<()> {
        if self.account_order.len() > 100
            || self.models.len() > 100
            || self.account_reserves.len() > 100
        {
            bail!("账户池最多支持 100 个账户和模型");
        }
        let accounts = AccountVault::new(paths.clone()).list_accounts()?;
        for (id, reserve) in &self.account_reserves {
            if !accounts.iter().any(|a| a.record_id == *id)
                || [reserve.short_term_percent, reserve.long_term_percent]
                    .into_iter()
                    .flatten()
                    .any(|value| value > 100)
            {
                bail!("保留额度必须属于已有账户，百分比须为 0 至 100 的整数");
            }
        }
        let mut seen = HashSet::new();
        for id in &self.account_order {
            if !seen.insert(id) || !accounts.iter().any(|a| a.record_id == *id) {
                bail!("账户池包含重复或不存在的账户，请刷新列表");
            }
        }
        let mut seen = HashSet::new();
        for model in &self.models {
            if model.model_id.is_empty()
                || model.model_id.len() > 200
                || model.display_name.len() > 160
                || !model
                    .model_id
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || b"-._".contains(&c))
                || !seen.insert(&model.model_id)
            {
                bail!("账户池模型 ID 无效或重复");
            }
        }
        if self.enabled && (self.account_order.is_empty() || !self.models.iter().any(|m| m.visible))
        {
            bail!("启用账户池前请选择至少一个账户并读取模型");
        }
        crate::net::validate_proxy(&self.proxy_url)?;
        atomic_write(
            &paths.state_dir.join("subscription.json"),
            &serde_json::to_vec_pretty(self)?,
        )?;
        Ok(())
    }

    pub(crate) fn client(&self) -> anyhow::Result<reqwest::Client> {
        crate::net::official_client(&self.proxy_url)
    }

    pub fn catalog(&self) -> Vec<CatalogModel> {
        if !self.enabled {
            return Vec::new();
        }
        self.models
            .iter()
            .filter(|m| m.visible)
            .map(|model| CatalogModel {
                route_id: route_id(&model.model_id),
                model_id: model.model_id.clone(),
                display_name: format!(
                    "订阅 · {}",
                    if model.display_name.is_empty() {
                        &model.model_id
                    } else {
                        &model.display_name
                    }
                ),
                provider_id: crate::integrations::SUBSCRIPTION_ID.into(),
                provider_name: "ChatGPT 订阅".into(),
                native_provider_id: crate::config::POOL_PROVIDER_ID.into(),
                context_window: None,
                tool_mode: None,
                protocol: Some(crate::providers::ProviderProtocol::Responses),
            })
            .collect()
    }
}
