use std::collections::{HashMap, HashSet};
use std::fs;

use anyhow::{Context as _, bail};
use reqwest::header::{ACCEPT, AUTHORIZATION, HeaderValue};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::accounts::{AccountPaths, atomic_write};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ProviderProtocol {
    Responses,
    ChatCompletions,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderModel {
    pub route_id: String,
    pub model_id: String,
    pub display_name: String,
    pub visible: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderProfile {
    pub id: String,
    pub name: String,
    pub base_url: String,
    pub api_key: String,
    pub protocol: ProviderProtocol,
    pub enabled: bool,
    #[serde(default)]
    pub models: Vec<ProviderModel>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderStore {
    #[serde(default = "store_version")]
    pub version: u32,
    #[serde(default)]
    pub providers: Vec<ProviderProfile>,
}

fn store_version() -> u32 {
    1
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoverRequest {
    #[serde(default)]
    pub provider_id: Option<String>,
    pub base_url: String,
    #[serde(default)]
    pub api_key: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiscoveredModel {
    pub model_id: String,
    pub display_name: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveRequest {
    #[serde(default)]
    pub id: Option<String>,
    pub name: String,
    pub base_url: String,
    #[serde(default)]
    pub api_key: String,
    pub protocol: ProviderProtocol,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub models: Vec<SaveModel>,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SaveModel {
    pub model_id: String,
    #[serde(default)]
    pub display_name: String,
    #[serde(default)]
    pub visible: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderSummary {
    pub id: String,
    pub name: String,
    pub base_url: String,
    pub protocol: ProviderProtocol,
    pub enabled: bool,
    pub has_api_key: bool,
    pub models: Vec<ProviderModel>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogModel {
    pub route_id: String,
    pub model_id: String,
    pub display_name: String,
    pub provider_id: String,
    pub provider_name: String,
    pub native_provider_id: String,
}

impl ProviderStore {
    pub fn load(paths: &AccountPaths) -> anyhow::Result<Self> {
        match fs::read(paths.providers_path()) {
            Ok(bytes) => serde_json::from_slice(&bytes).context("providers.json 无效"),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Self {
                version: 1,
                providers: Vec::new(),
            }),
            Err(error) => Err(error).context("无法读取 providers.json"),
        }
    }

    pub fn save(&self, paths: &AccountPaths) -> anyhow::Result<()> {
        let bytes = serde_json::to_vec_pretty(self).context("无法序列化 API 配置")?;
        atomic_write(&paths.providers_path(), &bytes).map_err(anyhow::Error::from)
    }

    pub fn summaries(&self) -> Vec<ProviderSummary> {
        self.providers
            .iter()
            .map(|profile| ProviderSummary {
                id: profile.id.clone(),
                name: profile.name.clone(),
                base_url: profile.base_url.clone(),
                protocol: profile.protocol,
                enabled: profile.enabled,
                has_api_key: !profile.api_key.is_empty(),
                models: profile.models.clone(),
            })
            .collect()
    }

    pub fn catalog(&self) -> Vec<CatalogModel> {
        self.providers
            .iter()
            .filter(|p| p.enabled)
            .flat_map(|p| {
                p.models.iter().filter(|m| m.visible).map(|m| CatalogModel {
                    route_id: m.route_id.clone(),
                    model_id: m.model_id.clone(),
                    display_name: m.display_name.clone(),
                    provider_id: p.id.clone(),
                    provider_name: p.name.clone(),
                    native_provider_id: crate::config::BROKER_PROVIDER_ID.into(),
                })
            })
            .collect()
    }

    pub fn route(&self, route_id: &str) -> Option<(ProviderProfile, ProviderModel)> {
        self.providers.iter().filter(|p| p.enabled).find_map(|p| {
            p.models
                .iter()
                .find(|m| m.visible && m.route_id == route_id)
                .cloned()
                .map(|m| (p.clone(), m))
        })
    }

    pub fn upsert(&mut self, request: SaveRequest) -> anyhow::Result<String> {
        let name = clean_text(&request.name, "API 名称", 120)?;
        let base_url = normalize_base_url(&request.base_url)?;
        let id = request
            .id
            .as_deref()
            .map(clean_id)
            .transpose()?
            .unwrap_or_else(new_provider_id);
        let existing_index = self.providers.iter().position(|p| p.id == id);
        let existing = existing_index.map(|index| self.providers[index].clone());
        let api_key = if request.api_key.trim().is_empty() {
            existing
                .as_ref()
                .map(|p| p.api_key.clone())
                .unwrap_or_default()
        } else {
            request.api_key.trim().to_string()
        };
        if api_key.is_empty() {
            bail!("API Key 不能为空");
        }

        let old_routes = existing
            .as_ref()
            .map(|p| {
                p.models
                    .iter()
                    .map(|m| (m.model_id.clone(), m.route_id.clone()))
                    .collect::<HashMap<_, _>>()
            })
            .unwrap_or_default();
        let mut seen = HashSet::new();
        let mut models = Vec::new();
        for model in request.models {
            let model_id = clean_text(&model.model_id, "模型 ID", 256)?;
            if !seen.insert(model_id.clone()) {
                continue;
            }
            let display_name = if model.display_name.trim().is_empty() {
                model_id.clone()
            } else {
                clean_text(&model.display_name, "显示名称", 160)?
            };
            let route_id = old_routes
                .get(&model_id)
                .cloned()
                .unwrap_or_else(|| stable_route_id(&id, &model_id));
            models.push(ProviderModel {
                route_id,
                model_id,
                display_name,
                visible: model.visible,
            });
        }
        if request.enabled && !models.iter().any(|model| model.visible) {
            bail!("启用的 API 至少需要显示一个模型");
        }
        let profile = ProviderProfile {
            id: id.clone(),
            name,
            base_url,
            api_key,
            protocol: request.protocol,
            enabled: request.enabled,
            models,
        };
        if let Some(index) = existing_index {
            self.providers[index] = profile;
        } else {
            self.providers.push(profile);
        }
        Ok(id)
    }
}

pub async fn discover_models(
    paths: &AccountPaths,
    request: DiscoverRequest,
) -> anyhow::Result<Vec<DiscoveredModel>> {
    let base_url = normalize_base_url(&request.base_url)?;
    let store = ProviderStore::load(paths)?;
    let api_key = if request.api_key.trim().is_empty() {
        request
            .provider_id
            .as_deref()
            .and_then(|id| store.providers.iter().find(|p| p.id == id))
            .map(|p| p.api_key.clone())
            .unwrap_or_default()
    } else {
        request.api_key.trim().to_string()
    };
    if api_key.is_empty() {
        bail!("API Key 不能为空");
    }
    let auth = HeaderValue::from_str(&format!("Bearer {api_key}")).context("API Key 无效")?;
    let response = reqwest::Client::builder()
        .user_agent("codex-plus/0.2")
        .build()?
        .get(models_url(&base_url))
        .header(AUTHORIZATION, auth)
        .header(ACCEPT, "application/json")
        .send()
        .await
        .context("无法连接模型接口")?;
    if !response.status().is_success() {
        bail!("模型接口返回 HTTP {}", response.status().as_u16());
    }
    let body: Value = response.json().await.context("模型接口返回的不是 JSON")?;
    let items = body
        .get("data")
        .and_then(Value::as_array)
        .or_else(|| body.get("models").and_then(Value::as_array))
        .ok_or_else(|| anyhow::anyhow!("模型接口缺少 data/models 数组"))?;
    let mut models_by_id = HashMap::new();
    for item in items {
        let Some(model_id) = item
            .as_str()
            .or_else(|| item.get("id").and_then(Value::as_str))
            .map(str::trim)
            .filter(|id| !id.is_empty())
        else {
            continue;
        };
        let display_name = ["display_name", "displayName", "name"]
            .into_iter()
            .find_map(|field| {
                item.get(field)
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|name| !name.is_empty())
            })
            .unwrap_or(model_id);
        let model = models_by_id
            .entry(model_id.to_string())
            .or_insert_with(|| DiscoveredModel {
                model_id: model_id.to_string(),
                display_name: model_id.to_string(),
            });
        if model.display_name == model_id {
            model.display_name = display_name.to_string();
        }
    }
    let mut models = models_by_id.into_values().collect::<Vec<_>>();
    models.sort_by(|left, right| left.model_id.cmp(&right.model_id));
    if models.is_empty() {
        bail!("模型接口没有返回可用模型");
    }
    Ok(models)
}

pub fn discover_view(
    existing: Option<&ProviderProfile>,
    discovered: Vec<DiscoveredModel>,
) -> Value {
    let names: HashMap<_, _> = discovered
        .iter()
        .map(|model| (model.model_id.as_str(), model.display_name.as_str()))
        .collect();
    let model_ids = discovered
        .iter()
        .map(|model| model.model_id.clone())
        .collect();
    let drafts = existing.map(|p| {
        p.models
            .iter()
            .map(|m| SaveModel {
                model_id: m.model_id.clone(),
                display_name: m.display_name.clone(),
                visible: m.visible,
            })
            .collect::<Vec<_>>()
    });
    let models: Vec<_> = rediscover_settings(drafts.as_deref(), model_ids)
        .into_iter()
        .map(|mut model| {
            if model.display_name.trim().is_empty() || model.display_name == model.model_id {
                if let Some(display_name) = names.get(model.model_id.as_str()) {
                    model.display_name = (*display_name).to_string();
                }
            }
            let previous =
                existing.and_then(|p| p.models.iter().find(|m| m.model_id == model.model_id));
            let mut view = serde_json::to_value(&model).expect("model settings serialize");
            view["routeId"] = json!(previous.map(|m| &m.route_id));
            view
        })
        .collect();
    json!({"models": models})
}

pub fn rediscover_settings(
    existing: Option<&[SaveModel]>,
    model_ids: Vec<String>,
) -> Vec<SaveModel> {
    let first = existing.is_none();
    let old = existing
        .unwrap_or_default()
        .iter()
        .map(|m| (&m.model_id, m))
        .collect::<HashMap<_, _>>();
    model_ids
        .into_iter()
        .map(|model_id| {
            let previous = old.get(&model_id);
            SaveModel {
                display_name: previous
                    .map(|m| m.display_name.clone())
                    .unwrap_or_else(|| model_id.clone()),
                visible: previous.map(|m| m.visible).unwrap_or(first),
                model_id,
            }
        })
        .collect()
}

pub fn normalize_base_url(value: &str) -> anyhow::Result<String> {
    let mut url = reqwest::Url::parse(value.trim()).context("API URL 无效")?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        bail!("API URL 必须是 http 或 https 地址");
    }
    url.set_query(None);
    url.set_fragment(None);
    let path = url.path().trim_end_matches('/').to_string();
    let path = if path.ends_with("/models") {
        path.trim_end_matches("/models").to_string()
    } else {
        path
    };
    url.set_path(&path);
    Ok(url.as_str().trim_end_matches('/').to_string())
}

fn models_url(base_url: &str) -> String {
    format!("{}/models", base_url.trim_end_matches('/'))
}

fn stable_route_id(provider_id: &str, model_id: &str) -> String {
    let digest = Sha256::digest(format!("{provider_id}\0{model_id}").as_bytes());
    format!("cp-{}", hex_lower(&digest[..12]))
}

fn new_provider_id() -> String {
    format!("api-{}", uuid::Uuid::new_v4().simple())
}

fn clean_id(value: &str) -> anyhow::Result<String> {
    let value = value.trim();
    if value.is_empty()
        || value.len() > 80
        || !value.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
    {
        bail!("API ID 无效");
    }
    Ok(value.to_string())
}

fn clean_text(value: &str, label: &str, max: usize) -> anyhow::Result<String> {
    let value = value.trim();
    if value.is_empty() || value.len() > max || value.chars().any(char::is_control) {
        bail!("{label}无效");
    }
    Ok(value.to_string())
}

fn hex_lower(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{header, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[test]
    fn normalizes_model_and_version_urls() {
        assert_eq!(
            normalize_base_url("https://example.com/v1/models?x=1").unwrap(),
            "https://example.com/v1"
        );
        assert_eq!(
            normalize_base_url("https://example.com/").unwrap(),
            "https://example.com"
        );
        assert_eq!(
            models_url("https://api.deepseek.com"),
            "https://api.deepseek.com/models"
        );
    }

    #[test]
    fn routes_are_stable_and_provider_scoped() {
        assert_eq!(stable_route_id("a", "same"), stable_route_id("a", "same"));
        assert_ne!(stable_route_id("a", "same"), stable_route_id("b", "same"));
    }

    #[test]
    fn summaries_never_serialize_keys() {
        let profile = ProviderProfile {
            id: "api-a".into(),
            name: "A".into(),
            base_url: "https://a.test/v1".into(),
            api_key: "secret-value".into(),
            protocol: ProviderProtocol::Responses,
            enabled: true,
            models: vec![],
        };
        let text = serde_json::to_string(
            &ProviderStore {
                version: 1,
                providers: vec![profile],
            }
            .summaries(),
        )
        .unwrap();
        assert!(!text.contains("secret-value"));
        assert!(!text.contains("apiKey"));
        assert!(text.contains("hasApiKey"));
    }

    #[test]
    fn rediscovery_preserves_alias_routes_and_visibility_and_upgrades_id_names() {
        let profile = ProviderProfile {
            id: "api-a".into(),
            name: "A".into(),
            base_url: "https://a.test/v1".into(),
            api_key: "secret".into(),
            protocol: ProviderProtocol::Responses,
            enabled: true,
            models: vec![
                ProviderModel {
                    route_id: "route".into(),
                    model_id: "old".into(),
                    display_name: "Alias".into(),
                    visible: true,
                },
                ProviderModel {
                    route_id: "raw-route".into(),
                    model_id: "raw".into(),
                    display_name: "raw".into(),
                    visible: false,
                },
                ProviderModel {
                    route_id: "blank-route".into(),
                    model_id: "blank".into(),
                    display_name: " ".into(),
                    visible: true,
                },
            ],
        };
        let discovered = [
            ("new", "New name"),
            ("old", "Provider name"),
            ("raw", "Friendly name"),
            ("blank", "Nonblank name"),
        ]
        .into_iter()
        .map(|(model_id, display_name)| DiscoveredModel {
            model_id: model_id.into(),
            display_name: display_name.into(),
        })
        .collect();
        let view = discover_view(Some(&profile), discovered);
        assert_eq!(view["models"][0]["visible"], false);
        assert_eq!(view["models"][0]["displayName"], "New name");
        assert_eq!(view["models"][1]["displayName"], "Alias");
        assert_eq!(view["models"][1]["routeId"], "route");
        assert_eq!(view["models"][1]["visible"], true);
        assert_eq!(view["models"][2]["displayName"], "Friendly name");
        assert_eq!(view["models"][2]["routeId"], "raw-route");
        assert_eq!(view["models"][2]["visible"], false);
        assert_eq!(view["models"][3]["displayName"], "Nonblank name");
        assert_eq!(view["models"][3]["routeId"], "blank-route");
        assert_eq!(view["models"][3]["visible"], true);
    }

    #[test]
    fn store_write_is_atomic_and_round_trips_plaintext_key() {
        let temp = tempfile::TempDir::new().unwrap();
        let paths = AccountPaths {
            codex_home: temp.path().join("codex"),
            state_dir: temp.path().join("state"),
            usage_endpoint: String::new(),
        };
        let store = ProviderStore {
            version: 1,
            providers: vec![ProviderProfile {
                id: "api-a".into(),
                name: "A".into(),
                base_url: "https://a.test/v1".into(),
                api_key: "plain-secret".into(),
                protocol: ProviderProtocol::Responses,
                enabled: true,
                models: vec![],
            }],
        };
        store.save(&paths).unwrap();
        assert_eq!(
            ProviderStore::load(&paths).unwrap().providers[0].api_key,
            "plain-secret"
        );
        assert!(std::fs::read_dir(&paths.state_dir).unwrap().all(|entry| {
            !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .ends_with(".tmp")
        }));
    }

    #[tokio::test]
    async fn discovery_preserves_provider_names_through_save_and_catalog() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v1/models"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({"data":[
                {"id":"qoder-cn/gfmodel"},
                {"id":"qoder-cn/gfmodel","display_name":" GLM-5.3-Flash ","displayName":"ignored","name":"ignored"},
                {"id":"qoder-cn/gfmodel","display_name":"later name"},
                {"id":"camel","displayName":"Camel name"},
                {"id":"named","name":"Provider name"},
                {"id":"blank","display_name":" ","displayName":"","name":" "},
                {"id":"fallback","display_name":null,"displayName":7,"name":"Fallback name"},
                "legacy", "legacy", {"id":" id-only "},
                null, 7, {"id":" "}, {"name":"missing id"}
            ]})))
            .mount(&server)
            .await;
        let temp = tempfile::TempDir::new().unwrap();
        let paths = AccountPaths {
            codex_home: temp.path().join("codex"),
            state_dir: temp.path().join("state"),
            usage_endpoint: String::new(),
        };
        let models = discover_models(
            &paths,
            DiscoverRequest {
                provider_id: None,
                base_url: format!("{}/v1", server.uri()),
                api_key: "discovery-secret".into(),
            },
        )
        .await
        .unwrap();
        let view = discover_view(None, models);
        let names: Vec<_> = view["models"]
            .as_array()
            .unwrap()
            .iter()
            .map(|model| {
                (
                    model["modelId"].as_str().unwrap(),
                    model["displayName"].as_str().unwrap(),
                )
            })
            .collect();
        assert_eq!(
            names,
            vec![
                ("blank", "blank"),
                ("camel", "Camel name"),
                ("fallback", "Fallback name"),
                ("id-only", "id-only"),
                ("legacy", "legacy"),
                ("named", "Provider name"),
                ("qoder-cn/gfmodel", "GLM-5.3-Flash"),
            ]
        );
        let mut saved = ProviderStore::load(&paths).unwrap();
        saved
            .upsert(SaveRequest {
                id: None,
                name: "magpie".into(),
                base_url: format!("{}/v1", server.uri()),
                api_key: "discovery-secret".into(),
                protocol: ProviderProtocol::Responses,
                enabled: true,
                models: serde_json::from_value(view["models"].clone()).unwrap(),
            })
            .unwrap();
        saved.save(&paths).unwrap();
        let store = ProviderStore::load(&paths).unwrap();
        let catalog = store.catalog();
        let model = catalog
            .iter()
            .find(|model| model.model_id == "qoder-cn/gfmodel")
            .unwrap();
        assert_eq!(model.display_name, "GLM-5.3-Flash");
        assert_eq!(
            store.route(&model.route_id).unwrap().1.model_id,
            model.model_id
        );
    }

    #[tokio::test]
    async fn discovery_uses_exact_base_models_path_and_bearer_key() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/models"))
            .and(header("authorization", "Bearer discovery-secret"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(
                    json!({"object":"list","data":[{"id":"model-b"},{"id":"model-a"}]}),
                ),
            )
            .mount(&server)
            .await;
        let temp = tempfile::TempDir::new().unwrap();
        let paths = AccountPaths {
            codex_home: temp.path().join("codex"),
            state_dir: temp.path().join("state"),
            usage_endpoint: String::new(),
        };
        let models = discover_models(
            &paths,
            DiscoverRequest {
                provider_id: None,
                base_url: server.uri(),
                api_key: "discovery-secret".into(),
            },
        )
        .await
        .unwrap();
        assert_eq!(
            models,
            vec![
                DiscoveredModel {
                    model_id: "model-a".into(),
                    display_name: "model-a".into()
                },
                DiscoveredModel {
                    model_id: "model-b".into(),
                    display_name: "model-b".into()
                },
            ]
        );
    }
}
