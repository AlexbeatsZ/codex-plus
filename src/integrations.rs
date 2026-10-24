//! The single owner of API profiles, the fixed subscription entry and model routes.
use crate::accounts::AccountPaths;
use crate::providers::{
    CatalogModel, DiscoverRequest, ProviderModel, ProviderProfile, ProviderStore, SaveRequest,
    discover_models, discover_view,
};
use crate::subscription::{SubscriptionApi, SubscriptionConfig};
use anyhow::bail;
use serde_json::{Value, json};

pub const SUBSCRIPTION_ID: &str = "chatgpt-subscription";
#[derive(Clone)]
pub struct ApiIntegrations {
    paths: AccountPaths,
    pub subscription: SubscriptionApi,
}
pub enum ModelRoute {
    External(ProviderProfile, ProviderModel),
    Subscription,
}
impl ApiIntegrations {
    pub fn new(paths: AccountPaths) -> Self {
        Self::with_subscription(paths.clone(), SubscriptionApi::new(paths))
    }
    pub fn with_subscription(paths: AccountPaths, subscription: SubscriptionApi) -> Self {
        Self {
            paths,
            subscription,
        }
    }
    pub fn list(&self) -> anyhow::Result<Vec<Value>> {
        let config = SubscriptionConfig::load(&self.paths)?;
        let models: Vec<_> = config
            .models
            .iter()
            .map(|m| json!({"modelId":m.model_id,"displayName":m.display_name,"visible":m.visible}))
            .collect();
        let mut entries = vec![
            json!({"id":SUBSCRIPTION_ID,"name":"ChatGPT 订阅","kind":"subscription","fixed":true,"enabled":config.enabled,"models":models,"baseUrl":"","protocol":"responses","hasApiKey":false}),
        ];
        entries.extend(
            ProviderStore::load(&self.paths)?
                .summaries()
                .into_iter()
                .map(|p| serde_json::to_value(p).unwrap()),
        );
        Ok(entries)
    }
    pub fn catalog(&self) -> anyhow::Result<Vec<CatalogModel>> {
        let mut catalog = ProviderStore::load(&self.paths)?.catalog();
        catalog.extend(SubscriptionConfig::load(&self.paths)?.catalog());
        Ok(catalog)
    }
    pub fn resolve(&self, route: &str) -> anyhow::Result<ModelRoute> {
        if route.starts_with("cp-pool-") {
            return Ok(ModelRoute::Subscription);
        }
        ProviderStore::load(&self.paths)?
            .route(route)
            .map(|(p, m)| ModelRoute::External(p, m))
            .ok_or_else(|| anyhow::anyhow!("unknown or disabled API model route"))
    }
    pub fn save_external(&self, request: SaveRequest) -> anyhow::Result<Vec<Value>> {
        if request.id.as_deref() == Some(SUBSCRIPTION_ID) {
            bail!("固定订阅 API 不接受外部 URL 或 Key");
        }
        let mut store = ProviderStore::load(&self.paths)?;
        store.upsert(request)?;
        store.save(&self.paths)?;
        self.list()
    }
    pub async fn discover_external(&self, request: DiscoverRequest) -> anyhow::Result<Value> {
        let store = ProviderStore::load(&self.paths)?;
        let existing = request
            .provider_id
            .as_deref()
            .and_then(|id| store.providers.iter().find(|provider| provider.id == id));
        let models = discover_models(&self.paths, request).await?;
        let mut view = discover_view(existing, models);
        view["status"] = json!("ok");
        Ok(view)
    }
    pub fn delete_external(&self, id: &str) -> anyhow::Result<Vec<Value>> {
        if id == SUBSCRIPTION_ID {
            bail!("固定订阅 API 只能停用，不能删除");
        }
        let mut store = ProviderStore::load(&self.paths)?;
        let before = store.providers.len();
        store.providers.retain(|p| p.id != id);
        if before == store.providers.len() {
            bail!("API 配置不存在");
        }
        store.save(&self.paths)?;
        self.list()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (tempfile::TempDir, ApiIntegrations) {
        let temp = tempfile::tempdir().unwrap();
        let paths = AccountPaths {
            codex_home: temp.path().join("home"),
            state_dir: temp.path().join("state"),
            usage_endpoint: String::new(),
        };
        (temp, ApiIntegrations::new(paths))
    }
    #[test]
    fn fixed_subscription_is_always_listed_and_cannot_be_deleted_or_overwritten() {
        let (_temp, apis) = fixture();
        let entries = apis.list().unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0]["id"], SUBSCRIPTION_ID);
        assert_eq!(entries[0]["fixed"], true);
        assert_eq!(entries[0]["enabled"], false);
        assert!(apis.delete_external(SUBSCRIPTION_ID).is_err());
        let request:SaveRequest=serde_json::from_value(json!({"id":SUBSCRIPTION_ID,"name":"replacement","baseUrl":"https://example.test","apiKey":"secret","protocol":"responses","models":[]})).unwrap();
        assert!(apis.save_external(request).is_err());
        assert!(!apis.paths.providers_path().exists());
    }
    #[test]
    fn subscription_resolution_does_not_depend_on_external_profile_file() {
        let (_temp, apis) = fixture();
        std::fs::create_dir_all(&apis.paths.state_dir).unwrap();
        std::fs::write(apis.paths.providers_path(), "corrupt").unwrap();
        assert!(matches!(
            apis.resolve("cp-pool-dGVzdA").unwrap(),
            ModelRoute::Subscription
        ));
        assert!(apis.resolve("cp-regular").is_err());
    }
}
