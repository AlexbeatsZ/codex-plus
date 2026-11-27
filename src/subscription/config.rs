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
    /// Ordered overrides within the explicitly enabled account set.
    #[serde(default)]
    pub account_priority: Vec<String>,
    #[serde(default)]
    pub force_priority: bool,
    #[serde(default)]
    pub models: Vec<crate::providers::SaveModel>,
    #[serde(default)]
    pub proxy_url: String,
    #[serde(default)]
    pub account_reserves: HashMap<String, AccountReserve>,
    #[serde(default)]
    pub account_temporary: HashMap<String, AccountTemporary>,
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

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum TemporaryResetTarget {
    Short,
    Long,
}

impl TemporaryResetTarget {
    pub fn label(self) -> &'static str {
        match self {
            Self::Short => "5h 额度",
            Self::Long => "周额度",
        }
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AccountTemporary {
    #[serde(default)]
    pub weekly_remaining_percent: Option<u8>,
    #[serde(default)]
    pub short_term_percent: Option<u8>,
    #[serde(default)]
    pub long_term_percent: Option<u8>,
    #[serde(default)]
    pub duration_minutes: Option<u32>,
    #[serde(default)]
    pub until_reset: Option<TemporaryResetTarget>,
}

impl AccountTemporary {
    pub fn enabled(&self) -> bool {
        self.weekly_remaining_percent.is_some()
            || self.short_term_percent.is_some()
            || self.long_term_percent.is_some()
            || self.duration_minutes.is_some()
            || self.until_reset.is_some()
    }

    pub fn needs_usage(&self) -> bool {
        self.weekly_remaining_percent.is_some()
            || self.short_term_percent.is_some()
            || self.long_term_percent.is_some()
            || self.until_reset.is_some()
    }
}

impl SubscriptionConfig {
    pub fn load(paths: &AccountPaths) -> anyhow::Result<Self> {
        let mut config: Self =
            crate::store::load(&paths.state_dir.join("subscription.json"), "账户池配置")?;
        // Existing temporary policies become priority overrides; participation
        // never expands to accounts that the user did not enable.
        for id in &config.account_order {
            if config.account_temporary.contains_key(id) && !config.account_priority.contains(id) {
                config.account_priority.push(id.clone());
            }
        }
        Ok(config)
    }

    pub(crate) fn write_unchecked(&self, paths: &AccountPaths) -> anyhow::Result<()> {
        atomic_write(
            &paths.state_dir.join("subscription.json"),
            &serde_json::to_vec_pretty(self)?,
        )?;
        Ok(())
    }

    pub fn save(&self, paths: &AccountPaths) -> anyhow::Result<()> {
        if self.account_order.len() > 100
            || self.models.len() > 100
            || self.account_reserves.len() > 100
            || self.account_temporary.len() > 100
            || self.account_priority.len() > 100
        {
            bail!("账户池最多支持 100 个账户和模型");
        }
        let accounts = AccountVault::new(paths.clone()).list_accounts()?;
        let mut priorities = HashSet::new();
        for id in &self.account_priority {
            if !self.account_order.contains(id) || !priorities.insert(id) {
                bail!("优先池必须由已参与的账户组成，且不能重复");
            }
        }
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
        for (id, temp) in &self.account_temporary {
            if !accounts.iter().any(|a| a.record_id == *id)
                || [temp.short_term_percent, temp.long_term_percent]
                    .into_iter()
                    .flatten()
                    .any(|value| value == 0 || value > 100)
            {
                bail!("临时使用额度必须属于已有账户，百分比须为 1 至 100 的整数");
            }
            if temp.duration_minutes.is_some_and(|m| m == 0 || m > 43_200) {
                bail!("临时使用时间须为 1 至 43200 分钟的整数");
            }
            if temp.weekly_remaining_percent.is_some_and(|p| p > 100) {
                bail!("周剩余额度退出阈值须为 0 至 100 的整数");
            }
            if self.account_order.contains(id) && !temp.enabled() {
                bail!("临时加入的账户请至少设置一项 5h 或周使用额度，或设置临时使用时间");
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
        self.write_unchecked(paths)?;
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
