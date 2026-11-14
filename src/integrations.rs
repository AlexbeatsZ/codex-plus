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
    pub fn paths(&self) -> &AccountPaths {
        &self.paths
    }
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
        let templates = crate::native_gateway::known_templates(&self.paths);
        entries.extend(
            ProviderStore::load(&self.paths)?
                .summaries()
                .into_iter()
                .map(|p| {
                    let mut value = serde_json::to_value(p).unwrap();
                    mark_matched(&templates, &mut value["models"]);
                    value
                }),
        );
        Ok(entries)
    }
    /// Strict catalog for the editor: any unreadable source is reported.
    pub fn catalog_checked(&self) -> anyhow::Result<Vec<CatalogModel>> {
        let mut catalog = ProviderStore::load(&self.paths)?.catalog();
        catalog.extend(SubscriptionConfig::load(&self.paths)?.catalog());
        self.mark_native(&mut catalog);
        Ok(catalog)
    }

    /// Request-path catalog. One damaged source only withdraws its own routes:
    /// a bad providers.json must not break the official model list or the
    /// subscription pool, and vice versa. Each new failure is logged once.
    pub fn catalog(&self) -> Vec<CatalogModel> {
        let mut catalog = Vec::new();
        let mut failures = Vec::new();
        match ProviderStore::load(&self.paths) {
            Ok(store) => catalog.extend(store.catalog()),
            Err(error) => failures.push(format!("{error:#}")),
        }
        match SubscriptionConfig::load(&self.paths) {
            Ok(config) => catalog.extend(config.catalog()),
            Err(error) => failures.push(format!("{error:#}")),
        }
        self.mark_native(&mut catalog);
        report_catalog_failures(&self.paths, failures);
        catalog
    }

    fn mark_native(&self, catalog: &mut [CatalogModel]) {
        if crate::native_gateway::Settings::load(&self.paths)
            .ok()
            .flatten()
            .is_some()
        {
            for model in catalog {
                model.native_provider_id = "openai".into();
            }
        }
    }

    pub fn resolve(&self, route: &str) -> anyhow::Result<ModelRoute> {
        if crate::subscription::is_pool_route(route) {
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
        if request.enabled {
            let templates = crate::native_gateway::known_templates(&self.paths);
            let pending: Vec<String> = request
                .models
                .iter()
                .filter(|m| m.visible)
                .filter_map(|m| {
                    let missing = crate::native_gateway::missing_configuration(
                        &templates,
                        false,
                        &m.model_id,
                        Some(request.protocol),
                        m.context_window,
                        m.tool_mode,
                    );
                    (!missing.is_empty())
                        .then(|| format!("{}（{}）", m.model_id, missing.join("、")))
                })
                .collect();
            if !pending.is_empty() {
                bail!(
                    "以下模型需要先填写才能使用：{}。codex-plus 不会替未确定的模型假设窗口或工具策略；也可以取消勾选这些模型。",
                    pending.join("；")
                );
            }
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
        mark_matched(
            &crate::native_gateway::known_templates(&self.paths),
            &mut view["models"],
        );
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

fn report_catalog_failures(paths: &AccountPaths, failures: Vec<String>) {
    static LAST: std::sync::Mutex<Vec<String>> = std::sync::Mutex::new(Vec::new());
    let mut last = LAST.lock().unwrap();
    if *last != failures {
        if !failures.is_empty() {
            crate::runtime::append_log(
                paths,
                "integrations.catalog.degraded",
                json!({"errors": failures}),
            );
        }
        *last = failures;
    }
}

// Lets the editor show which windows come from an official model and which
// the user must supply.
fn mark_matched(templates: &[Value], models: &mut Value) {
    for model in models.as_array_mut().into_iter().flatten() {
        let id = model["modelId"].as_str().unwrap_or_default().to_string();
        model["matched"] = json!(crate::native_gateway::find_template(templates, &id).is_some());
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
    #[test]
    fn one_damaged_source_only_withdraws_its_own_routes() {
        let (_temp, apis) = fixture();
        std::fs::create_dir_all(&apis.paths.state_dir).unwrap();
        std::fs::write(apis.paths.providers_path(), "corrupt").unwrap();
        std::fs::write(
            apis.paths.state_dir.join("subscription.json"),
            json!({"enabled":true,"accountOrder":["a"],"models":[{"modelId":"gpt-x","visible":true}]}).to_string(),
        )
        .unwrap();
        let catalog = apis.catalog();
        assert_eq!(catalog.len(), 1);
        assert_eq!(catalog[0].provider_id, SUBSCRIPTION_ID);
        assert!(apis.catalog_checked().is_err());
    }
    #[test]
    fn saving_requires_declarations_instead_of_guessing() {
        let (_temp, apis) = fixture();
        std::fs::create_dir_all(&apis.paths.codex_home).unwrap();
        std::fs::write(
            apis.paths.codex_home.join("models_cache.json"),
            json!({"models":[{"slug":"known","context_window":500000}]}).to_string(),
        )
        .unwrap();
        let save = |protocol: &str, models: Value| {
            apis.save_external(serde_json::from_value(json!({"name":"relay","baseUrl":"https://example.test/v1","apiKey":"fake","protocol":protocol,"models":models})).unwrap())
        };
        // A matched name fixes the window, not whether the relay supports deferred tools.
        let error = save("responses", json!([{"modelId":"known","visible":true}])).unwrap_err();
        assert!(error.to_string().contains("known（工具策略）"));
        let error = save(
            "responses",
            json!([{"modelId":"odd","visible":true,"toolMode":"direct"}]),
        )
        .unwrap_err();
        assert!(error.to_string().contains("odd（上下文窗口）"));
        // Chat conversion can only inline tools, so only the unknown window is asked.
        let error = save("chatCompletions", json!([{"modelId":"odd","visible":true}])).unwrap_err();
        assert!(error.to_string().contains("odd（上下文窗口）"));
        assert!(!apis.paths.providers_path().exists());
        // Hidden models need nothing; declared ones are accepted and marked for the editor.
        let listed = save(
            "responses",
            json!([{"modelId":"known","visible":true,"toolMode":"deferred"},{"modelId":"odd","visible":false}]),
        )
        .unwrap();
        assert_eq!(listed[1]["models"][0]["matched"], true);
        assert_eq!(listed[1]["models"][1]["matched"], false);
        assert_eq!(listed[1]["models"][0]["toolMode"], "deferred");
    }
}
