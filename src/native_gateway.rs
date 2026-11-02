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
use crate::providers::{ProviderProtocol, ToolMode};

const SETTINGS: &str = "native-gateway.json";
const LIMIT: usize = 32 * 1024 * 1024;
const TEMPLATE_ARCHIVE: &str = "native-model-templates.json";

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

fn official_entries(doc: &Value) -> Vec<Value> {
    doc["models"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|m| m["slug"].as_str().is_some_and(|id| !id.starts_with("cp-")))
        .cloned()
        .collect()
}

fn read_entries(path: &std::path::Path) -> Vec<Value> {
    fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .map(|doc| official_entries(&doc))
        .unwrap_or_default()
}

fn template_sources(paths: &AccountPaths, settings: &Settings) -> [Option<PathBuf>; 4] {
    [
        settings.original_catalog.clone(),
        Some(paths.state_dir.join("official-models.json")),
        Some(paths.state_dir.join(TEMPLATE_ARCHIVE)),
        Some(paths.codex_home.join("models_cache.json")),
    ]
}

pub fn native_models(paths: &AccountPaths, settings: &Settings) -> anyhow::Result<Vec<Value>> {
    for path in template_sources(paths, settings).into_iter().flatten() {
        let models = read_entries(&path);
        if !models.is_empty() {
            return Ok(models);
        }
    }
    bail!("原生模型模板尚未就绪，请先让官方客户端完成一次模型目录读取")
}

// The official list can differ between refreshes. Route capabilities must not
// shrink because one refresh omitted a model, so every seen entry is archived.
fn archive_templates(paths: &AccountPaths, fresh: &[Value]) -> anyhow::Result<()> {
    fs::create_dir_all(&paths.state_dir)?;
    let guard = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(paths.state_dir.join(".native-templates.lock"))?;
    fs2::FileExt::lock_exclusive(&guard)?;
    let path = paths.state_dir.join(TEMPLATE_ARCHIVE);
    let mut archived = read_entries(&path);
    for model in fresh {
        archived.retain(|old| old["slug"] != model["slug"]);
        archived.insert(0, model.clone());
    }
    archived.truncate(200);
    atomic_write(&path, &serde_json::to_vec(&json!({"models": archived}))?)?;
    Ok(())
}

pub fn find_template<'a>(templates: &'a [Value], model_id: &str) -> Option<&'a Value> {
    // A relay may namespace a native model ("vendor/gpt-x"); the last segment
    // names the model whose real capabilities apply.
    let bare = model_id.rsplit('/').next().unwrap_or(model_id);
    templates
        .iter()
        .find(|m| m["slug"] == model_id)
        .or_else(|| templates.iter().find(|m| m["slug"] == bare))
}

/// What the user must still declare before a route can be offered. Nothing is
/// guessed: a matched official template supplies a model's window, the
/// subscription backend is the official one, and Chat conversion can only
/// inline tools. A relay's tool support is unknowable from its model name.
pub fn missing_configuration(
    templates: &[Value],
    subscription: bool,
    model_id: &str,
    protocol: Option<ProviderProtocol>,
    window: Option<u64>,
    tool_mode: Option<ToolMode>,
) -> Vec<&'static str> {
    let known = find_template(templates, model_id).is_some();
    if subscription {
        return if known {
            Vec::new()
        } else {
            vec!["官方能力信息"]
        };
    }
    let mut missing = Vec::new();
    if window.is_none() && !known {
        missing.push("上下文窗口");
    }
    if tool_mode.is_none() && protocol != Some(ProviderProtocol::ChatCompletions) {
        missing.push("工具策略");
    }
    missing
}

/// Every official template this host has seen, for checks outside a catalog build.
pub fn known_templates(paths: &AccountPaths) -> Vec<Value> {
    let settings = Settings::load(paths).ok().flatten().unwrap_or(Settings {
        capability: String::new(),
        original_base: None,
        original_catalog: None,
    });
    let mut templates: Vec<Value> = Vec::new();
    for path in template_sources(paths, &settings).into_iter().flatten() {
        for model in read_entries(&path) {
            if !templates.iter().any(|m| m["slug"] == model["slug"]) {
                templates.push(model);
            }
        }
    }
    templates
}

/// A subscription account's own `/models` reply is authoritative for its models.
pub fn archive_official(paths: &AccountPaths, doc: &Value) -> anyhow::Result<()> {
    archive_templates(paths, &official_entries(doc))
}

pub fn catalog(
    paths: &AccountPaths,
    apis: &ApiIntegrations,
    settings: &Settings,
) -> anyhow::Result<Value> {
    catalog_with(paths, apis, settings, native_models(paths, settings)?)
}

fn catalog_with(
    paths: &AccountPaths,
    apis: &ApiIntegrations,
    settings: &Settings,
    official: Vec<Value>,
) -> anyhow::Result<Value> {
    anyhow::ensure!(!official.is_empty(), "原生模型模板尚未就绪");
    let mut templates = official.clone();
    for path in template_sources(paths, settings).into_iter().flatten() {
        for model in read_entries(&path) {
            if !templates.iter().any(|m| m["slug"] == model["slug"]) {
                templates.push(model);
            }
        }
    }
    let mut models = official;
    for route in apis.catalog()? {
        let subscription = route.provider_id == crate::integrations::SUBSCRIPTION_ID;
        if !missing_configuration(
            &templates,
            subscription,
            &route.model_id,
            route.protocol,
            route.context_window,
            route.tool_mode,
        )
        .is_empty()
        {
            continue;
        }
        let exact = find_template(&templates, &route.model_id);
        // An unmatched route only borrows the template's field layout; every
        // capability below comes from the user or is switched off.
        let mut model = exact.unwrap_or(&templates[0]).clone();
        model["slug"] = json!(route.route_id);
        model["display_name"] = if subscription {
            json!(route.display_name)
        } else {
            json!(format!("{} · {}", route.provider_name, route.display_name))
        };
        model["description"] = json!(format!("{} · {}", route.provider_name, route.model_id));
        model["visibility"] = json!("list");
        model["supported_in_api"] = json!(true);
        model["upgrade"] = Value::Null;
        model["availability_nux"] = Value::Null;
        // Lite adds web.run, whose alpha/search endpoint belongs to the official account.
        model["use_responses_lite"] = json!(false);
        if exact.is_none() {
            model["input_modalities"] = json!(["text"]);
            model["supported_reasoning_levels"] = json!([]);
            model["supports_reasoning_effort_updates"] = json!(false);
        }
        // Subscription routes (None) reach the official backend and keep its
        // deferred loading. A relay's tool support is the user's declaration.
        let tool_mode = if route.protocol == Some(ProviderProtocol::ChatCompletions) {
            Some(ToolMode::Direct)
        } else {
            route.tool_mode
        };
        match tool_mode {
            Some(ToolMode::Direct) => {
                model["tool_mode"] = json!("direct");
                model["supports_search_tool"] = json!(false);
                model["experimental_supported_tools"] = json!([]);
            }
            Some(ToolMode::Deferred) => {
                model["tool_mode"] = json!("code_mode_only");
                model["supports_search_tool"] = json!(true);
                model["experimental_supported_tools"] = json!([]);
            }
            None => {}
        }
        if let Some(window) = route.context_window {
            model["context_window"] = json!(window);
            model["max_context_window"] = json!(window);
            model["auto_compact_token_limit"] = json!(window * 9 / 10);
        }
        models.push(model);
    }
    Ok(json!({"models": models}))
}

// Only the fixed prompt is checked: conversation history can be compacted,
// tools and instructions cannot. o200k is a local estimate, not quota billing
// and not a promise about a third-party tokenizer. Never truncate user data.
#[cfg(test)]
fn check_fixed_prompt(body: &Value, window: u64) -> anyhow::Result<()> {
    check_fixed_prompt_at_limit(body, window, window.saturating_mul(9) / 10)
}

fn check_fixed_prompt_at_limit(body: &Value, window: u64, limit: u64) -> anyhow::Result<()> {
    let mut fixed = String::new();
    if let Some(instructions) = body["instructions"].as_str() {
        fixed.push_str(instructions);
    }
    if let Some(tools) = body["tools"].as_array() {
        for tool in tools {
            fixed.push_str(&serde_json::to_string(tool)?);
        }
    }
    if let Some(input) = body["input"].as_array() {
        for item in input {
            if matches!(item["role"].as_str(), Some("system" | "developer")) {
                fixed.push_str(&serde_json::to_string(item)?);
            }
        }
    }
    // UTF-8 byte count is an upper bound for this BPE. Ordinary small prompts
    // avoid tokenizer initialization and work altogether.
    if fixed.len() as u64 >= limit {
        let tokens = tiktoken_rs::o200k_base_singleton()
            .encode_ordinary(&fixed)
            .len() as u64;
        anyhow::ensure!(
            tokens < limit,
            "固定指令和工具定义约 {tokens} token，已达到模型 {window} token 窗口的压缩阈值。请求未发送；压缩历史不能解决此问题。请减少启用的工具，或在 API 接入中填写上游实际支持的上下文窗口；旧任务请重新选择模型或新建任务。"
        );
    }
    Ok(())
}

pub fn request_preflight(apis: &ApiIntegrations, route: &str, body: &Value) -> anyhow::Result<()> {
    let paths = apis.paths();
    let settings = Settings::load(paths)?.unwrap_or(Settings {
        capability: String::new(),
        original_base: None,
        original_catalog: None,
    });
    let entries = apis.catalog()?;
    let entry = entries.iter().find(|m| {
        m.route_id == route
            || (m.provider_id == crate::integrations::SUBSCRIPTION_ID && m.model_id == route)
    });
    let Some(entry) = entry else {
        return Ok(());
    }; // routing owns unknown/disabled errors
    // Budget against the exact entry the client was given, so the guard can
    // never disagree with the window and compaction point it is enforcing.
    let Ok(catalog) = catalog(paths, apis, &settings) else {
        return Ok(());
    };
    let Some(model) = catalog["models"]
        .as_array()
        .and_then(|models| models.iter().find(|m| m["slug"] == entry.route_id.as_str()))
    else {
        // Withheld from the catalog for missing configuration; an old task may
        // still name it, and sending would mean guessing its window or tools.
        if entry.provider_id == crate::integrations::SUBSCRIPTION_ID {
            bail!(
                "订阅模型 {} 缺少官方能力信息，请求未发送。请在“API 接入 → ChatGPT 订阅”中重新读取模型后保存。",
                entry.model_id
            );
        }
        bail!(
            "模型 {} 尚未配置上下文窗口或工具策略，codex-plus 不会替它假设，请求未发送。请在“API 接入”中填写后保存，并重新选择模型。",
            entry.model_id
        );
    };
    let Some(window) = model["context_window"].as_u64() else {
        return Ok(()); // the official template leaves sizing to the native client
    };
    let default_limit = window.saturating_mul(9) / 10;
    let limit = model["auto_compact_token_limit"]
        .as_u64()
        .filter(|limit| *limit > 0)
        .unwrap_or(default_limit)
        .min(default_limit);
    check_fixed_prompt_at_limit(body, window, limit)
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
    let mut fresh = None;
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
            let models = official_entries(&doc);
            crate::runtime::append_log(
                paths,
                "native.models.refreshed",
                json!({"query": query.unwrap_or(""), "count": models.len(),
                    "slugs": models.iter().filter_map(|m| m["slug"].as_str()).collect::<Vec<_>>()}),
            );
            archive_templates(paths, &models)?;
            atomic_write(&paths.state_dir.join("official-models.json"), &bytes)?;
            fresh = Some(models).filter(|m| !m.is_empty());
        }
    }
    let official = match fresh {
        Some(models) => models,
        None => native_models(paths, settings)?,
    };
    let body = serde_json::to_vec(&catalog_with(paths, apis, settings, official)?)?;
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
