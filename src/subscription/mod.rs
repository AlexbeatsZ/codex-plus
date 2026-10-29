//! Ordered, opt-in native Codex credential routing behind the existing broker.
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{Context as _, bail};
use axum::body::{Body, Bytes};
use axum::http::{HeaderMap, HeaderValue, Response, StatusCode};
use base64::Engine as _;
use futures_util::{Stream, StreamExt as _};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::pin::Pin;

use crate::accounts::{AccountCredential, AccountPaths, AccountVault, atomic_write};
use crate::accounts::{CredentialFailure, unix_now};
use crate::providers::CatalogModel;

const NATIVE_BASE: &str = "https://chatgpt.com/backend-api/codex";
const REFRESH_URL: &str = "https://auth.openai.com/oauth/token";
const PRELUDE_LIMIT: usize = 1024 * 1024;
const IDLE_TIMEOUT: Duration = Duration::from_secs(90);
const ROUTE_PREFIX: &str = "cp-pool-";
pub const AUTO_REVIEW_MODEL: &str = "codex-auto-review";

mod config;
pub use config::SubscriptionConfig;
mod quota;
mod activation;

pub fn route_id(model: &str) -> String {
    format!(
        "{ROUTE_PREFIX}{}",
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(model)
    )
}

#[derive(Clone)]
pub struct SubscriptionApi {
    paths: AccountPaths,
    native_base: String,
    refresh_url: String,
    state: Arc<Mutex<HashMap<(String, String), AccountState>>>,
    rejected: Arc<Mutex<HashMap<String, String>>>,
    quota: Arc<quota::QuotaTracker>,
    activity: Arc<Mutex<activation::Activity>>,
    foreground: Arc<tokio::sync::Notify>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AccountState {
    record_id: String,
    model: String,
    reason: String,
    retry_at: u64,
    #[serde(skip)]
    observed_at: std::time::Instant,
}

impl SubscriptionApi {
    pub fn new(paths: AccountPaths) -> Self {
        let rejected = std::fs::read(paths.state_dir.join("subscription-rejected.json"))
            .ok()
            .and_then(|raw| serde_json::from_slice(&raw).ok())
            .unwrap_or_default();
        Self {
            paths,
            native_base: NATIVE_BASE.into(),
            refresh_url: REFRESH_URL.into(),
            state: Arc::new(Mutex::new(HashMap::new())),
            rejected: Arc::new(Mutex::new(rejected)),
            quota: Arc::new(quota::QuotaTracker::default()),
            activity: Arc::default(),
            foreground: Arc::default(),
        }
    }

    pub fn view(&self) -> anyhow::Result<Value> {
        let config = SubscriptionConfig::load(&self.paths)?;
        let states: Vec<_> = self
            .state
            .lock()
            .unwrap()
            .values()
            .filter(|s| s.retry_at > unix_now())
            .cloned()
            .collect();
        let accounts = AccountVault::new(self.paths.clone()).list_accounts()?;
        let rejected_ids: Vec<_> = self.rejected.lock().unwrap().keys().cloned().collect();
        let blocked: Vec<_> = rejected_ids
            .iter()
            .filter(|id| self.is_rejected_current(id))
            .map(|id| json!({"recordId":id,"blocked":true,"reason":"凭据失效，请重新导入或登录"}))
            .collect();
        Ok(
            json!({"status":"ok", "quotaStates":self.quota_states(&config), "config":config, "accounts":accounts,"accountStates":states,"blockedAccounts":blocked}),
        )
    }

    pub fn save(&self, config: SubscriptionConfig) -> anyhow::Result<Value> {
        config.save(&self.paths)?;
        self.foreground.notify_waiters();
        self.quota.clear();
        self.view()
    }

    fn is_rejected_current(&self, id: &str) -> bool {
        let revision = AccountVault::new(self.paths.clone())
            .credential_revision(id)
            .ok();
        // Caller must not hold rejected mutex: all credential IO has one lock order.
        self.rejected
            .lock()
            .unwrap()
            .get(id)
            .is_some_and(|old| revision.as_ref() == Some(old))
    }

    fn reject(&self, id: &str, revision: String) {
        let mut rejected = self.rejected.lock().unwrap();
        rejected.insert(id.to_string(), revision);
        if let Ok(raw) = serde_json::to_vec(&*rejected) {
            let _ = atomic_write(
                &self.paths.state_dir.join("subscription-rejected.json"),
                &raw,
            );
        }
    }

    fn cool(&self, id: &str, model: &str, reason: &str, retry_at: u64) {
        let retry_at = if reason == "额度限制" {
            retry_at.min(unix_now() + 60)
        } else {
            retry_at
        };
        let mut states = self.state.lock().unwrap();
        states.retain(|_, s| s.retry_at > unix_now());
        if states.len() >= 2048 {
            states.clear();
        }
        states.insert(
            (id.to_string(), model.to_string()),
            AccountState {
                record_id: id.into(),
                model: model.into(),
                reason: reason.into(),
                retry_at,
                observed_at: std::time::Instant::now(),
            },
        );
    }

    fn cooling(&self, id: &str, model: &str) -> bool {
        let states = self.state.lock().unwrap();
        [model, "*"].iter().any(|key| {
            states
                .get(&(id.into(), (*key).into()))
                .is_some_and(|s| s.retry_at > unix_now())
        })
    }

    fn credential_failed(&self, id: &str, error: &anyhow::Error) {
        if let Some(CredentialFailure::Rejected(revision)) =
            error.downcast_ref::<CredentialFailure>()
        {
            // Record exactly the failed generation, even if an import just replaced it.
            self.reject(id, revision.clone());
        } else {
            self.cool(id, "*", "凭据暂时不可用", unix_now() + 60);
        }
    }

    // Discovery and inference share one bounded authentication/renewal policy.
    async fn authenticated_request(
        &self,
        id: &str,
        client: &reqwest::Client,
        endpoint: &str,
        body: Option<&Value>,
        headers: Option<&HeaderMap>,
    ) -> anyhow::Result<Option<reqwest::Response>> {
        let vault = AccountVault::new(self.paths.clone());
        let mut credential = match vault.credential(id, client, &self.refresh_url, None).await {
            Ok(c) => c,
            Err(error) => {
                self.credential_failed(id, &error);
                return Ok(None);
            }
        };
        for attempt in 0..2 {
            let mut request = native_request(client, &credential, endpoint, body.is_some());
            if let Some(body) = body {
                request = request.json(body);
            }
            if let Some(headers) = headers {
                // Codex uses hyphenated HTTP headers for prompt-cache affinity.
                // Underscored names are JSON metadata fields, not these headers.
                for name in ["session-id", "thread-id"] {
                    if let Some(value) = headers.get(name) {
                        request = request.header(name, value);
                    }
                }
            }
            let timeout = if body.is_some() {
                IDLE_TIMEOUT
            } else {
                Duration::from_secs(25)
            };
            let response = tokio::time::timeout(timeout, request.send())
                .await
                .ok()
                .and_then(Result::ok)
                .ok_or_else(|| anyhow::anyhow!("订阅 API 上游连接失败，请检查网络或代理"))?;
            if response.status() != StatusCode::UNAUTHORIZED {
                return Ok(Some(response));
            }
            if attempt == 1 {
                self.reject(id, credential.revision);
                return Ok(None);
            }
            match vault
                .credential(
                    id,
                    client,
                    &self.refresh_url,
                    Some(&credential.access_token),
                )
                .await
            {
                Ok(c) => credential = c,
                Err(error) => {
                    self.credential_failed(id, &error);
                    return Ok(None);
                }
            }
        }
        unreachable!("authentication is bounded to two attempts")
    }

    pub async fn discover(&self, draft: SubscriptionConfig) -> anyhow::Result<Value> {
        let client = draft.client()?;
        if draft.account_order.is_empty() {
            bail!("请先选择参与账户池的账户");
        }
        // Discovery and inference use the same native credential contract.
        for id in &draft.account_order {
            if self.is_rejected_current(id) || self.cooling(id, "*") {
                continue;
            }
            let Some(response) = self
                .authenticated_request(
                    id,
                    &client,
                    &format!("{}/models?client_version=0.163.0", self.native_base),
                    None,
                    None,
                )
                .await?
            else {
                continue;
            };
            if !response.status().is_success() {
                bail!("账户池模型接口返回 HTTP {}", response.status().as_u16());
            }
            let value: Value = tokio::time::timeout(Duration::from_secs(25), response.json())
                .await
                .context("订阅 API 模型目录读取超时")?
                .context("订阅 API 模型目录无效")?;
            let models: Vec<String> = value["models"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|m| m["visibility"].as_str() != Some("hide"))
                .filter_map(|m| m["slug"].as_str().or_else(|| m["id"].as_str()))
                .map(str::to_string)
                .collect();
            if models.is_empty() {
                bail!("该账户没有可用模型");
            }
            let previous = if draft.models.is_empty() {
                None
            } else {
                Some(draft.models.as_slice())
            };
            return Ok(
                json!({"status":"ok", "models":crate::providers::rediscover_settings(previous,models)}),
            );
        }
        bail!("参与账户均缺少有效凭据，请重新登录或导入最新 auth.json")
    }

    pub async fn responses(
        &self,
        headers: HeaderMap,
        mut body: Value,
        compact: bool,
    ) -> Response<Body> {
        if compact {
            return error(
                StatusCode::BAD_REQUEST,
                "pool_compaction_v2_required",
                "账户池使用原生 Responses v2 压缩，请使用 codex-plus 账户池 provider",
            );
        }
        let config = match SubscriptionConfig::load(&self.paths) {
            Ok(c) => c,
            Err(_) => {
                return error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "pool_config_invalid",
                    "账户池配置无效",
                );
            }
        };
        let route = body["model"].as_str().unwrap_or("");
        let model = if route == AUTO_REVIEW_MODEL {
            if !config.enabled
                || config.account_order.is_empty()
                || !config.models.iter().any(|model| model.visible)
            {
                return error(
                    StatusCode::NOT_FOUND,
                    "pool_review_unavailable",
                    "原生自动审批需要已启用且有参与账户的 ChatGPT 订阅账户池；请启用账户池或在官方界面选择人工审批",
                );
            }
            AUTO_REVIEW_MODEL.to_owned()
        } else {
            let Some(model) = config
                .models
                .iter()
                .find(|m| m.visible && (route_id(&m.model_id) == route || m.model_id == route))
                .map(|m| m.model_id.clone())
                .filter(|_| config.enabled)
            else {
                return error(
                    StatusCode::NOT_FOUND,
                    "pool_disabled",
                    "账户池已关闭或模型不再可用",
                );
            };
            model
        };
        // Stateful response references are account-bound and cannot safely fail over.
        if body
            .get("previous_response_id")
            .is_some_and(|v| !v.is_null())
            || body.get("conversation").is_some_and(|v| !v.is_null())
        {
            return error(
                StatusCode::BAD_REQUEST,
                "pool_stateful_request",
                "账户池需要完整 input，不支持跨账户服务端会话引用",
            );
        }
        if body["input"]
            .as_array()
            .is_some_and(|items| items.iter().any(|i| i["type"] == "item_reference"))
        {
            return error(
                StatusCode::BAD_REQUEST,
                "pool_stateful_request",
                "账户池不支持跨账户 item 引用",
            );
        }
        body["model"] = json!(model);
        body["store"] = json!(false);
        if body.get("instructions").is_none() {
            body["instructions"] = json!("");
        }
        let stream_requested = body["stream"] == true;
        if !compact && !stream_requested {
            return error(
                StatusCode::BAD_REQUEST,
                "pool_stream_required",
                "Codex 账户池需要 stream=true",
            );
        }
        let client = match config.client() {
            Ok(c) => c,
            Err(_) => {
                return error(
                    StatusCode::BAD_GATEWAY,
                    "pool_proxy_invalid",
                    "账户池网络配置无效",
                );
            }
        };
        let endpoint = format!("{}/responses", self.native_base);
        let mut tried = 0;
        let mut reserved = 0;
        let mut unknown = 0;
        let mut quota_budget = Duration::from_secs(25);
        for id in &config.account_order {
            if self.cooling(id, &model) || self.is_rejected_current(id) {
                continue;
            }
            let reserve = config.account_reserves.get(id).filter(|r| r.enabled());
            if let Some(reserve) = reserve {
                let started = tokio::time::Instant::now();
                let status = self
                    .check_reserve(id, reserve, &client, started + quota_budget)
                    .await;
                quota_budget = quota_budget.saturating_sub(started.elapsed());
                match status {
                    quota::ReserveStatus::Ready => {}
                    quota::ReserveStatus::Reserved(_) => {
                        reserved += 1;
                        continue;
                    }
                    quota::ReserveStatus::Unknown => {
                        unknown += 1;
                        continue;
                    }
                }
            }
            tried += 1;
            let activity = self.begin_foreground(id);
            let response = match self
                .authenticated_request(id, &client, &endpoint, Some(&body), Some(&headers))
                .await
            {
                Ok(Some(response)) => response,
                Ok(None) => continue,
                Err(_) => {
                    return error(
                        StatusCode::BAD_GATEWAY,
                        "pool_network_error",
                        "订阅 API 上游连接失败，请检查网络或代理",
                    );
                }
            };
            let status = response.status();
            if reserve.is_some() {
                self.quota.observe_headers(id, response.headers());
            }
            let retry_after = response
                .headers()
                .get("retry-after")
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.parse::<u64>().ok());
            if !status.is_success() {
                let bytes = match read_bounded(response, 16 * 1024 * 1024).await {
                    Ok(b) => b,
                    Err(_) => {
                        return error(
                            StatusCode::BAD_GATEWAY,
                            "pool_invalid_response",
                            "账户池响应读取失败",
                        );
                    }
                };
                let value = serde_json::from_slice::<Value>(&bytes).unwrap_or(Value::Null);
                if let Some((reason, until)) = recoverable(&value, retry_after) {
                    self.cool(id, &model, reason, until);
                    continue;
                }
                return error(
                    status,
                    "pool_upstream_rejected",
                    &format!(
                        "账户池上游拒绝请求（HTTP {}），请检查模型、权限或请求格式",
                        status.as_u16()
                    ),
                );
            }
            match prepare_stream(response).await {
                Ok(Prepared::Retry(value)) => {
                    if let Some((reason, until)) = recoverable(&value, retry_after) {
                        self.cool(id, &model, reason, until);
                        continue;
                    }
                    return error(
                        StatusCode::BAD_GATEWAY,
                        "pool_upstream_failed",
                        "账户池上游在输出前返回错误",
                    );
                }
                Ok(Prepared::Stream {
                    prefix,
                    mut tail,
                    mut guard,
                }) => {
                    if reserve.is_some() {
                        self.quota.observe_event(id, guard.quota_update.take());
                    }
                    if let Some(value) = &guard.failure
                        && let Some((reason, until)) = recoverable(value, retry_after)
                    {
                        self.cool(id, &model, reason, until);
                    }
                    let router = self.clone();
                    let record_id = id.clone();
                    let model = model.clone();
                    let track_quota = reserve.is_some();
                    let stream = async_stream::stream! {
                        let _activity = activity;
                        yield Ok::<Bytes, std::io::Error>(Bytes::from(prefix));
                        while !guard.terminal {
                            match tokio::time::timeout(IDLE_TIMEOUT, tail.next()).await {
                                Ok(Some(Ok(bytes))) => {
                                    guard.push(&bytes);
                                    if track_quota { router.quota.observe_event(&record_id, guard.quota_update.take()); }
                                    if let Some(value) = &guard.failure {
                                        if let Some((reason, until)) = recoverable(value, retry_after) { router.cool(&record_id,&model,reason,until); }
                                    }
                                    yield Ok(bytes);
                                }
                                _ => break,
                            }
                        }
                        if !guard.terminal {
                            yield Ok(Bytes::from("event: response.failed\ndata: {\"type\":\"response.failed\",\"response\":{\"status\":\"failed\",\"error\":{\"code\":\"upstream_stream_error\",\"message\":\"账户池上游流中断；已输出内容不会自动重放\"}}}\n\n"));
                        }
                    };
                    let mut response = response_body(
                        StatusCode::OK,
                        "text/event-stream",
                        Body::from_stream(stream),
                    );
                    if let Ok(record) = HeaderValue::from_str(id) {
                        response
                            .headers_mut()
                            .insert("x-codex-plus-account-record", record);
                    }
                    return response;
                }
                Err(_) => {
                    return error(
                        StatusCode::BAD_GATEWAY,
                        "pool_stream_error",
                        "账户池上游在有效输出前中断",
                    );
                }
            }
        }
        if unknown > 0 {
            return error(
                StatusCode::SERVICE_UNAVAILABLE,
                "subscription_quota_unknown",
                "参与账户的保留额度暂无法确认，其余账户已达保留阈值或不可用；请检查网络并稍后重试",
            );
        }
        if reserved > 0 {
            return error(
                StatusCode::TOO_MANY_REQUESTS,
                "subscription_reserve_reached",
                "参与账户已达到保留额度或暂不可用；请等待额度重置、调整保留百分比或选择其他账户",
            );
        }
        let message = if tried == 0 {
            "账户池暂时没有可用账户，请查看额度和冷却状态"
        } else {
            "账户池参与账户均不可用，请查看额度或更新登录凭据"
        };
        error(
            StatusCode::TOO_MANY_REQUESTS,
            "subscription_exhausted",
            message,
        )
    }
}

mod transport;
use transport::*;

#[cfg(test)]
mod tests;
