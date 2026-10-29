//! Native OpenAI identity with explicit broker-owned model routes. The URL
//! capability authenticates local clients without replacing their ChatGPT auth.
use std::{collections::HashMap, fs, io::Read, path::PathBuf, time::Duration};

use anyhow::{Context as _, bail};
use axum::body::{Body, Bytes};
use axum::http::{HeaderMap, Method, Response, StatusCode, header};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use toml_edit::{DocumentMut, value};

use crate::accounts::{AccountPaths, AccountVault, atomic_write};
use crate::integrations::ApiIntegrations;

const SETTINGS: &str = "native-gateway.json";
const LIMIT: usize = 32 * 1024 * 1024;

#[cfg(test)]
mod tests;

#[derive(Clone, Serialize, Deserialize)]
pub struct Settings {
    pub capability: String,
    pub original_base: Option<String>,
    pub original_catalog: Option<PathBuf>,
}

impl Settings {
    pub fn load(paths: &AccountPaths) -> anyhow::Result<Option<Self>> {
        match fs::read(paths.state_dir.join(SETTINGS)) {
            Ok(bytes) => Ok(Some(
                serde_json::from_slice(&bytes).context("原生路由配置无效")?,
            )),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    pub fn reconcile(
        paths: &AccountPaths,
        config: &mut DocumentMut,
        port: u16,
    ) -> anyhow::Result<()> {
        let provider = config
            .get("model_provider")
            .and_then(|v| v.as_str())
            .unwrap_or("openai")
            .to_string();
        if ![
            "openai",
            crate::config::BROKER_PROVIDER_ID,
            crate::config::POOL_PROVIDER_ID,
        ]
        .contains(&provider.as_str())
        {
            bail!("手机兼容路由不能接管其他默认 provider：{provider}");
        }
        let settings = match Self::load(paths)? {
            Some(settings) => settings,
            None => Self {
                capability: uuid::Uuid::new_v4().simple().to_string(),
                original_base: config
                    .get("openai_base_url")
                    .and_then(|v| v.as_str())
                    .map(str::to_string),
                original_catalog: config
                    .get("model_catalog_json")
                    .and_then(|v| v.as_str())
                    .map(PathBuf::from),
            },
        };
        // Do not silently replace a user's subsequent endpoint edit.
        if let Some(current) = config.get("openai_base_url").and_then(|v| v.as_str()) {
            if Some(current) != settings.original_base.as_deref() && !settings.owns_url(current) {
                bail!("openai_base_url 已被外部修改，请先恢复或移除旧原生路由配置");
            }
        }
        atomic_write(
            &paths.state_dir.join(SETTINGS),
            &serde_json::to_vec_pretty(&settings)?,
        )?;
        config["openai_base_url"] = value(format!(
            "http://127.0.0.1:{port}/native/{}/backend-api/codex",
            settings.capability
        ));
        // Existing legacy tables remain available for old tasks and native forks.
        if provider != "openai" {
            config["model_provider"] = value("openai");
        }
        // A user-owned static catalog is retained as the authoritative template.
        // Point to our merged copy only in that explicit static-catalog mode.
        if settings.original_catalog.is_some() {
            let merged = catalog(paths, &ApiIntegrations::new(paths.clone()), &settings)?;
            let destination = paths.state_dir.join("native-models.json");
            atomic_write(&destination, &serde_json::to_vec(&merged)?)?;
            config["model_catalog_json"] = value(destination.to_string_lossy().as_ref());
        }
        Ok(())
    }

    fn owns_url(&self, url: &str) -> bool {
        let Ok(url) = reqwest::Url::parse(url) else {
            return false;
        };
        url.host_str() == Some("127.0.0.1")
            && url.path() == format!("/native/{}/backend-api/codex", self.capability)
    }

    fn upstream(&self, headers: &HeaderMap) -> &str {
        self.original_base.as_deref().unwrap_or_else(|| {
            if headers.contains_key("chatgpt-account-id") {
                "https://chatgpt.com/backend-api/codex"
            } else {
                "https://api.openai.com/v1"
            }
        })
    }

    fn may_use_live_login(&self) -> bool {
        self.original_base.as_ref().is_none_or(|base| {
            let Ok(url) = reqwest::Url::parse(base) else {
                return false;
            };
            (url.scheme() == "https"
                && matches!(
                    url.host_str(),
                    Some("chatgpt.com" | "us.chatgpt.com" | "gov.chatgpt.com")
                ))
                || (cfg!(test) && url.host_str() == Some("127.0.0.1"))
        })
    }
}

pub fn native_models(paths: &AccountPaths, settings: &Settings) -> anyhow::Result<Vec<Value>> {
    let sources = [
        settings.original_catalog.clone(),
        Some(paths.state_dir.join("official-models.json")),
        Some(paths.codex_home.join("models_cache.json")),
    ];
    for path in sources.into_iter().flatten() {
        if let Ok(bytes) = fs::read(path)
            && let Ok(doc) = serde_json::from_slice::<Value>(&bytes)
            && let Some(models) = doc["models"].as_array()
        {
            let models: Vec<_> = models
                .iter()
                .filter(|m| m["slug"].as_str().is_some_and(|id| !id.starts_with("cp-")))
                .cloned()
                .collect();
            if !models.is_empty() {
                return Ok(models);
            }
        }
    }
    bail!("原生模型模板尚未就绪，请先让官方客户端完成一次模型目录读取")
}

pub fn catalog(
    paths: &AccountPaths,
    apis: &ApiIntegrations,
    settings: &Settings,
) -> anyhow::Result<Value> {
    let mut models = native_models(paths, settings)?;
    let templates = models.clone();
    for route in apis.catalog()? {
        let exact = templates.iter().find(|m| m["slug"] == route.model_id);
        let mut model = exact.unwrap_or(&templates[0]).clone();
        model["slug"] = json!(route.route_id);
        model["display_name"] = if route.provider_id == crate::integrations::SUBSCRIPTION_ID {
            json!(route.display_name)
        } else {
            json!(format!("{} · {}", route.provider_name, route.display_name))
        };
        model["description"] = json!(format!("{} · {}", route.provider_name, route.model_id));
        model["visibility"] = json!("list");
        model["supported_in_api"] = json!(true);
        model["upgrade"] = Value::Null;
        model["availability_nux"] = Value::Null;
        model["use_responses_lite"] = json!(false);
        model["tool_mode"] = json!("direct");
        model["supports_search_tool"] = json!(false);
        model["experimental_supported_tools"] = json!([]);
        if exact.is_none() {
            model["context_window"] = json!(32768);
            model["max_context_window"] = json!(32768);
            model["input_modalities"] = json!(["text"]);
            model["supported_reasoning_levels"] = json!([]);
            model["supports_reasoning_effort_updates"] = json!(false);
        }
        models.push(model);
    }
    Ok(json!({"models": models}))
}

pub async fn models(
    client: &reqwest::Client,
    paths: &AccountPaths,
    apis: &ApiIntegrations,
    settings: &Settings,
    headers: &HeaderMap,
    query: Option<&str>,
) -> anyhow::Result<Response<Body>> {
    // Native refresh is bounded; a network failure keeps the last official template.
    if settings.original_catalog.is_none() {
        let upstream_headers =
            official_headers(paths, settings, headers).unwrap_or_else(|_| forward_headers(headers));
        let mut url = format!(
            "{}/models",
            settings.upstream(&upstream_headers).trim_end_matches('/')
        );
        if let Some(query) = query {
            url.push('?');
            url.push_str(query);
        }
        if let Ok(response) = client
            .get(url)
            .headers(upstream_headers)
            .header(header::ACCEPT_ENCODING, "identity")
            .timeout(Duration::from_secs(3))
            .send()
            .await
            && response.status().is_success()
            && let Ok(bytes) = response.bytes().await
            && let Ok(doc) = serde_json::from_slice::<Value>(&bytes)
            && doc["models"].as_array().is_some_and(|m| !m.is_empty())
        {
            atomic_write(&paths.state_dir.join("official-models.json"), &bytes)?;
        }
    }
    let body = serde_json::to_vec(&catalog(paths, apis, settings)?)?;
    let etag = format!("\"{:x}\"", Sha256::digest(&body));
    Ok(Response::builder()
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::ETAG, etag)
        .header(header::CACHE_CONTROL, "no-cache")
        .body(Body::from(body))?)
}

pub fn http_client() -> anyhow::Result<reqwest::Client> {
    crate::subscription::SubscriptionConfig::default().client()
}

fn official_headers(
    paths: &AccountPaths,
    settings: &Settings,
    incoming: &HeaderMap,
) -> anyhow::Result<HeaderMap> {
    let mut headers = forward_headers(incoming);
    // The official client deliberately omits OAuth from a custom inference
    // origin. Only the capability-protected local gateway reads the live login;
    // it never renews it, changes it, or forwards it to external API routes.
    if !headers.contains_key(header::AUTHORIZATION) {
        anyhow::ensure!(
            settings.may_use_live_login(),
            "不能向自定义原始端点注入官方登录凭据"
        );
        let credential = AccountVault::new(paths.clone())
            .live_credential()?
            .context("请先登录官方 ChatGPT 账户")?;
        headers.insert(
            header::AUTHORIZATION,
            format!("Bearer {}", credential.access_token).parse()?,
        );
        headers.insert("chatgpt-account-id", credential.account_id.parse()?);
    }
    Ok(headers)
}

pub fn decode(headers: &HeaderMap, bytes: &Bytes) -> anyhow::Result<Value> {
    let encoding = headers
        .get(header::CONTENT_ENCODING)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("identity");
    let decoded = match encoding {
        "identity" | "" => bytes.to_vec(),
        "zstd" => {
            let decoder = zstd::stream::read::Decoder::new(bytes.as_ref())?;
            let mut decoded = Vec::new();
            decoder.take((LIMIT + 1) as u64).read_to_end(&mut decoded)?;
            anyhow::ensure!(decoded.len() <= LIMIT, "原生请求解压后过大");
            decoded
        }
        _ => bail!("原生请求压缩格式不受支持"),
    };
    serde_json::from_slice(&decoded).context("原生模型请求 JSON 无效")
}

pub fn forward_headers(headers: &HeaderMap) -> HeaderMap {
    let mut result = headers.clone();
    for name in [
        "host",
        "content-length",
        "connection",
        "upgrade",
        "transfer-encoding",
        "keep-alive",
        "proxy-authorization",
        "proxy-authenticate",
        "te",
        "trailer",
    ] {
        result.remove(name);
    }
    if let Some(connection) = headers
        .get(header::CONNECTION)
        .and_then(|v| v.to_str().ok())
    {
        for name in connection.split(',').map(str::trim) {
            result.remove(name);
        }
    }
    result
}

pub async fn official(
    client: &reqwest::Client,
    paths: &AccountPaths,
    settings: &Settings,
    headers: HeaderMap,
    method: Method,
    tail: &str,
    body: Bytes,
) -> anyhow::Result<Response<Body>> {
    let headers = official_headers(paths, settings, &headers)?;
    let endpoint = format!(
        "{}/{}",
        settings.upstream(&headers).trim_end_matches('/'),
        tail
    );
    let response = client
        .request(method, endpoint)
        .headers(forward_headers(&headers))
        .body(body)
        .send()
        .await?;
    let status = response.status();
    let headers = forward_headers(response.headers());
    let mut result = Response::new(Body::from_stream(response.bytes_stream()));
    *result.status_mut() = status;
    *result.headers_mut() = headers;
    Ok(result)
}

// Only compact requests may resolve a historical real model through this map.
// Ordinary bare model requests always retain official-account ownership.
pub fn remember_route(
    paths: &AccountPaths,
    headers: &HeaderMap,
    model: &str,
    compact: bool,
) -> anyhow::Result<String> {
    let Some(thread) = ["thread-id", "session-id"].into_iter().find_map(|key| {
        headers
            .get(key)
            .and_then(|v| v.to_str().ok())
            .filter(|v| !v.is_empty() && v.len() <= 256)
    }) else {
        return Ok(model.into());
    };
    let guard_path = paths.state_dir.join(".native-routes.lock");
    fs::create_dir_all(&paths.state_dir)?;
    let guard = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(guard_path)?;
    fs2::FileExt::lock_exclusive(&guard)?;
    let file = paths.state_dir.join("native-thread-routes.json");
    let mut routes: HashMap<String, String> = match fs::read(&file) {
        Ok(bytes) => serde_json::from_slice(&bytes).context("原生会话路由记录无效")?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => HashMap::new(),
        Err(e) => return Err(e.into()),
    };
    if compact && !model.starts_with("cp-") {
        if let Some(route) = routes.get(thread).filter(|route| route.starts_with("cp-")) {
            return Ok(route.clone());
        }
    } else if !compact && model != crate::subscription::AUTO_REVIEW_MODEL {
        routes.insert(thread.into(), model.into());
        atomic_write(&file, &serde_json::to_vec(&routes)?)?;
    }
    Ok(model.into())
}

pub fn failure(status: StatusCode, message: &str) -> Response<Body> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(
            json!({"error":{"type":"codex_plus_native_gateway","message":message}}).to_string(),
        ))
        .unwrap()
}
