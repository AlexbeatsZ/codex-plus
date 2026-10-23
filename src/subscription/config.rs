use super::*;

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SubscriptionConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub account_order: Vec<String>,
    #[serde(default)]
    pub models: Vec<crate::providers::SaveModel>,
    #[serde(default)]
    pub proxy_url: String,
}

impl SubscriptionConfig {
    pub fn load(paths: &AccountPaths) -> anyhow::Result<Self> {
        match std::fs::read(paths.state_dir.join("subscription.json")) {
            Ok(raw) => serde_json::from_slice(&raw).context("账户池配置无效"),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Self::default()),
            Err(_) => bail!("无法读取账户池配置"),
        }
    }

    pub fn save(&self, paths: &AccountPaths) -> anyhow::Result<()> {
        if self.account_order.len() > 100 || self.models.len() > 100 {
            bail!("账户池最多支持 100 个账户和模型");
        }
        let accounts = AccountVault::new(paths.clone()).list_accounts()?;
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
        self.client()?;
        atomic_write(
            &paths.state_dir.join("subscription.json"),
            &serde_json::to_vec_pretty(self)?,
        )?;
        Ok(())
    }

    pub(super) fn client(&self) -> anyhow::Result<reqwest::Client> {
        let mut builder = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .user_agent("codex-plus/0.3.3 account-pool")
            .redirect(reqwest::redirect::Policy::none());
        let proxy = if self.proxy_url.trim().is_empty() {
            system_proxy()
        } else {
            Some(self.proxy_url.trim().to_string())
        };
        if let Some(proxy) = proxy {
            let url = reqwest::Url::parse(&proxy).context("账户池代理地址无效")?;
            if !matches!(url.scheme(), "http" | "https")
                || !url.username().is_empty()
                || url.password().is_some()
            {
                bail!("代理仅支持不含用户名和密码的 HTTP/HTTPS 地址");
            }
            builder = builder.proxy(reqwest::Proxy::all(url).context("账户池代理地址无效")?);
        }
        builder.build().context("无法建立账户池网络客户端")
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
                provider_id: "chatgpt-subscription".into(),
                provider_name: "ChatGPT 订阅".into(),
                native_provider_id: crate::config::POOL_PROVIDER_ID.into(),
            })
            .collect()
    }
}

fn system_proxy() -> Option<String> {
    // reqwest handles environment proxies itself. macOS GUI launches do not
    // inherit shell proxy variables, so read the existing system HTTPS proxy.
    if ["HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"]
        .iter()
        .any(|k| std::env::var_os(k).is_some())
    {
        return None;
    }
    #[cfg(all(target_os = "macos", not(test)))]
    {
        let output = std::process::Command::new("/usr/sbin/scutil")
            .arg("--proxy")
            .output()
            .ok()?;
        let text = String::from_utf8(output.stdout).ok()?;
        let field = |key: &str| {
            text.lines()
                .find_map(|l| l.trim().strip_prefix(&format!("{key} : ")).map(str::trim))
        };
        if field("HTTPSEnable") == Some("1") {
            let host = field("HTTPSProxy")?;
            let port: u16 = field("HTTPSPort")?.parse().ok()?;
            if host
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b".-".contains(&b))
            {
                return Some(format!("http://{host}:{port}"));
            }
        }
    }
    None
}
