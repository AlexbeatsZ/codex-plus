use std::convert::Infallible;

use axum::Router;
use axum::body::{Body, Bytes};
use axum::extract::{Path, State};
use axum::http::{HeaderMap, Method, Request, Response, StatusCode, header};
use axum::routing::{any, get, post};
use futures_util::StreamExt as _;
use serde_json::{Value, json};
use tokio::net::TcpListener;

#[cfg(any(test, debug_assertions))]
use crate::accounts::AccountPaths;
use crate::http::BODY_LIMIT;
use crate::integrations::{ApiIntegrations, ModelRoute};
use crate::protocol_proxy::{
    ChatSseToResponsesConverter, UpstreamWireApi, open_provider_responses_request,
    provider_non_stream_response,
};
use crate::providers::is_managed_route;
use crate::subscription::AUTO_REVIEW_MODEL;

// Keep the stable port below Windows' default dynamic client range
// (49152-65535). WSL mirrored networking tracks client ports in that range
// and can make an otherwise unused host port fail to bind with WSAEACCES.
pub const PREFERRED_BROKER_PORT: u16 = 43121;
const UPSTREAM_ERROR_LIMIT: usize = 1024 * 1024;

#[derive(Clone)]
struct BrokerState {
    apis: ApiIntegrations,
    token: std::sync::Arc<str>,
}

pub struct BrokerHandle {
    port: u16,
    token: String,
    preferred_bind_error: Option<String>,
    task: Option<tokio::task::JoinHandle<anyhow::Result<()>>>,
}

impl BrokerHandle {
    pub fn port(&self) -> u16 {
        self.port
    }

    /// Printed by the debug-only `--broker-only` smoke mode for test scripts.
    #[cfg_attr(not(any(test, debug_assertions)), allow(dead_code))]
    pub fn token(&self) -> &str {
        &self.token
    }

    pub fn preferred_bind_error(&self) -> Option<&str> {
        self.preferred_bind_error.as_deref()
    }

    pub async fn wait(&mut self) -> anyhow::Result<()> {
        let result = self
            .task
            .as_mut()
            .expect("broker task already consumed")
            .await;
        self.task.take();
        result.map_err(anyhow::Error::from)?
    }

    pub async fn shutdown(&mut self) {
        if let Some(task) = self.task.take() {
            task.abort();
            let _ = task.await;
        }
    }
}

impl Drop for BrokerHandle {
    fn drop(&mut self) {
        if let Some(task) = self.task.as_ref() {
            task.abort();
        }
    }
}

#[cfg(any(test, debug_assertions))]
pub(crate) async fn start_on_port(
    paths: AccountPaths,
    preferred_port: u16,
) -> anyhow::Result<BrokerHandle> {
    let apis = ApiIntegrations::new(paths.clone());
    start(preferred_port, apis).await
}

/// Binds the preferred port, or any free loopback port, and keeps holding the
/// listener: probing and releasing a port would race with other programs.
pub(crate) async fn bind_loopback(
    preferred_port: u16,
) -> anyhow::Result<(TcpListener, Option<String>)> {
    match TcpListener::bind(("127.0.0.1", preferred_port)).await {
        Ok(listener) => Ok((listener, None)),
        Err(preferred_error) => {
            let listener = TcpListener::bind(("127.0.0.1", 0)).await.map_err(|fallback_error| {
                anyhow::anyhow!(
                    "无法绑定本机端口；首选 127.0.0.1:{preferred_port} 失败: {preferred_error}；备用端口失败: {fallback_error}"
                )
            })?;
            Ok((listener, Some(preferred_error.to_string())))
        }
    }
}

pub async fn start(preferred_port: u16, apis: ApiIntegrations) -> anyhow::Result<BrokerHandle> {
    let token = crate::config::broker_token(apis.paths())?;
    let (listener, preferred_bind_error) = bind_loopback(preferred_port).await?;
    let port = listener.local_addr().map_err(anyhow::Error::from)?.port();
    let subscription = apis.subscription.clone();
    let state = BrokerState {
        apis,
        token: token.as_str().into(),
    };
    let app = Router::new()
        .route("/health", get(|| async { "ok" }))
        .route(
            "/native/{capability}/backend-api/codex/{*tail}",
            any(native_request),
        )
        .route("/v1/models", get(models))
        .route("/models", get(models))
        .route("/v1/responses", post(responses))
        .route("/responses", post(responses))
        .route("/v1/responses/compact", post(responses))
        .route("/responses/compact", post(responses))
        .route("/subscription/v1/responses", post(subscription_responses))
        .route(
            "/subscription/v1/responses/compact",
            post(subscription_responses),
        )
        .layer(axum::middleware::from_fn(crate::http::loopback_host_only))
        .with_state(state);
    let task = tokio::spawn(async move {
        tokio::select! {
            result = axum::serve(listener, app).into_future() => result.map_err(anyhow::Error::from),
            _ = subscription.run_activation() => Ok(()),
        }
    });
    Ok(BrokerHandle {
        port,
        token,
        preferred_bind_error,
        task: Some(task),
    })
}

async fn native_request(
    State(state): State<BrokerState>,
    Path((capability, tail)): Path<(String, String)>,
    request: Request<Body>,
) -> Response<Body> {
    use crate::native_gateway::{self as gateway, failure};
    let paths = state.apis.paths().clone();
    let settings = match gateway::Settings::load(&paths) {
        Ok(Some(settings)) if settings.capability == capability => settings,
        _ => return failure(StatusCode::UNAUTHORIZED, "原生路由凭据无效"),
    };
    let client = match gateway::http_client(&paths) {
        Ok(client) => client,
        Err(_) => {
            return failure(
                StatusCode::BAD_GATEWAY,
                "官方网络配置无效，请检查账户池代理",
            );
        }
    };
    let method = request.method().clone();
    let headers = request.headers().clone();
    let upstream_tail = match request.uri().query() {
        Some(query) => format!("{tail}?{query}"),
        None => tail.clone(),
    };
    // The capability also protects the non-secret model catalog. Native Codex
    // can refresh it before attaching an inference authorization header.
    if method == Method::GET && tail == "models" {
        return gateway::models(
            &client,
            &paths,
            &state.apis,
            &settings,
            &headers,
            request.uri().query(),
        )
        .await
        .unwrap_or_else(|_| {
            failure(
                StatusCode::BAD_GATEWAY,
                "原生模型目录尚未就绪，请检查官方目录或网络",
            )
        });
    }
    if method == Method::GET && tail == "responses" {
        // Codex's documented, session-scoped HTTP fallback avoids stateful WS
        // continuations crossing independent API/subscription backends.
        return failure(StatusCode::UPGRADE_REQUIRED, "本机模型路由使用 HTTP/SSE");
    }
    let body = match axum::body::to_bytes(request.into_body(), BODY_LIMIT).await {
        Ok(body) => body,
        Err(_) => return failure(StatusCode::PAYLOAD_TOO_LARGE, "原生模型请求过大"),
    };
    let official = |headers, method, body| {
        let (client, paths, settings, tail) = (
            client.clone(),
            paths.clone(),
            settings.clone(),
            upstream_tail.clone(),
        );
        async move {
            gateway::official(&client, &paths, &settings, headers, method, &tail, body)
                .await
                .unwrap_or_else(|_| failure(StatusCode::BAD_GATEWAY, "官方模型上游连接失败"))
        }
    };
    if method != Method::POST || !["responses", "responses/compact"].contains(&tail.as_str()) {
        // Other native endpoints, such as web.run's alpha/search, stay with the
        // official account exactly as before the gateway existed. Local routes
        // never borrow that account for them.
        if !body.is_empty()
            && gateway::decode(&headers, &body)
                .is_ok_and(|value| value["model"].as_str().is_some_and(is_managed_route))
        {
            return failure(StatusCode::BAD_REQUEST, "本机 API/订阅模型不支持该原生端点");
        }
        return official(headers, method, body).await;
    }
    let mut value = match gateway::decode(&headers, &body) {
        Ok(value) => value,
        Err(_) => return failure(StatusCode::BAD_REQUEST, "原生模型请求格式无效"),
    };
    let Some(model) = value["model"].as_str().map(str::to_string) else {
        return failure(StatusCode::BAD_REQUEST, "原生模型请求缺少 model");
    };
    let compact = tail.ends_with("/compact")
        || value["input"].as_array().is_some_and(|items| {
            items
                .iter()
                .any(|item| item["type"] == "compaction_trigger")
        });
    let reviewer = model == AUTO_REVIEW_MODEL;
    let route = {
        let (paths, headers, model) = (paths.clone(), headers.clone(), model.clone());
        tokio::task::spawn_blocking(move || {
            gateway::remember_route(&paths, &headers, &model, compact)
        })
        .await
    };
    let Ok(Ok(route)) = route else {
        return failure(StatusCode::INTERNAL_SERVER_ERROR, "无法保存原生会话路由");
    };
    if !is_managed_route(&route) {
        // Bare official models, and reviewers without a verified managed parent,
        // keep this request's official-account ownership.
        return official(headers, method, body).await;
    }
    if route != model
        && !state
            .apis
            .catalog()
            .iter()
            .any(|entry| entry.route_id == route && (reviewer || entry.model_id == model))
    {
        return failure(
            StatusCode::CONFLICT,
            "无法确认原生辅助请求所属渠道，请重新选择模型",
        );
    }
    // Managed-parent reviews use the already enabled native subscription
    // pool, exactly like legacy API reviews. Never send review instructions
    // to an external generation API or replace the reviewer model/policy.
    if !reviewer {
        value["model"] = json!(route);
    }
    let mut headers = headers;
    headers.remove(header::CONTENT_ENCODING);
    headers.remove(header::AUTHORIZATION);
    dispatch(&state, headers, &format!("/v1/{tail}"), value, false).await
}

async fn models(State(state): State<BrokerState>, headers: HeaderMap) -> Response<Body> {
    if !crate::http::bearer_matches(&headers, &state.token) {
        return error_response(StatusCode::UNAUTHORIZED, "broker authorization failed");
    }
    let models = state.apis.catalog();
    crate::http::json(
        StatusCode::OK,
        &json!({"object":"list","data":models.into_iter().map(|m|json!({"id":m.route_id,"object":"model","owned_by":m.provider_id})).collect::<Vec<_>>()}),
    )
}

async fn responses(
    State(state): State<BrokerState>,
    headers: HeaderMap,
    request: Request<Body>,
) -> Response<Body> {
    handle_responses(state, headers, request, false).await
}

async fn subscription_responses(
    State(state): State<BrokerState>,
    headers: HeaderMap,
    request: Request<Body>,
) -> Response<Body> {
    handle_responses(state, headers, request, true).await
}

async fn handle_responses(
    state: BrokerState,
    headers: HeaderMap,
    request: Request<Body>,
    subscription_endpoint: bool,
) -> Response<Body> {
    if !crate::http::bearer_matches(&headers, &state.token) {
        return error_response(StatusCode::UNAUTHORIZED, "broker authorization failed");
    }
    let path = request.uri().path().to_string();
    let body = match axum::body::to_bytes(request.into_body(), BODY_LIMIT).await {
        Ok(value) => value,
        Err(error) => {
            return error_response(
                StatusCode::BAD_REQUEST,
                &format!("request body failed: {error}"),
            );
        }
    };
    let value: Value = match serde_json::from_slice(&body) {
        Ok(value) => value,
        Err(_) => return error_response(StatusCode::BAD_REQUEST, "request is not valid JSON"),
    };
    dispatch(&state, headers, &path, value, subscription_endpoint).await
}

/// One routing pipeline for the legacy provider tables and the native gateway.
async fn dispatch(
    state: &BrokerState,
    headers: HeaderMap,
    path: &str,
    value: Value,
    subscription_endpoint: bool,
) -> Response<Body> {
    let user_agent = headers
        .get(header::USER_AGENT)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    let Some(route_id) = value
        .get("model")
        .and_then(Value::as_str)
        .map(str::to_string)
    else {
        return error_response(StatusCode::BAD_REQUEST, "missing route model");
    };
    let apis = state.apis.clone();
    let check_route = route_id.clone();
    let preflight = tokio::task::spawn_blocking(move || {
        crate::native_gateway::request_preflight(&apis, &check_route, &value)?;
        Ok::<_, anyhow::Error>(value)
    })
    .await;
    let mut value = match preflight {
        Ok(Ok(value)) => value,
        Ok(Err(error)) => return error_response(StatusCode::BAD_REQUEST, &error.to_string()),
        Err(_) => return error_response(StatusCode::INTERNAL_SERVER_ERROR, "请求大小检查失败"),
    };
    let compact = path.ends_with("/compact");
    if subscription_endpoint || route_id == AUTO_REVIEW_MODEL {
        // Native pre-turn compaction may use the previous turn's real model ID.
        // Keep that compatibility confined to the subscription provider's URL.
        return state
            .apis
            .subscription
            .responses(headers, value, compact)
            .await;
    }
    let (profile, model) = match state.apis.resolve(&route_id) {
        Ok(ModelRoute::Subscription) => {
            return state
                .apis
                .subscription
                .responses(headers, value, compact)
                .await;
        }
        Ok(ModelRoute::External(profile, model)) => (profile, model),
        Err(_) => {
            return error_response(StatusCode::NOT_FOUND, "unknown or disabled API model route");
        }
    };
    value["model"] = Value::String(model.model_id);
    let serialized = match serde_json::to_string(&value) {
        Ok(value) => value,
        Err(error) => return error_response(StatusCode::BAD_REQUEST, &error.to_string()),
    };
    let proxy =
        match open_provider_responses_request(&profile, &serialized, user_agent.as_deref(), path)
            .await
        {
            Ok(proxy) => proxy,
            Err(error) => return error_response(StatusCode::BAD_GATEWAY, &error.to_string()),
        };
    proxy_response(proxy).await
}

async fn proxy_response(proxy: crate::protocol_proxy::ProviderProxyResponse) -> Response<Body> {
    let status =
        StatusCode::from_u16(proxy.upstream.status_code).unwrap_or(StatusCode::BAD_GATEWAY);
    // An upstream rejection is JSON even for stream requests. Feeding it to the
    // SSE converter would turn a 401/429 into an empty "completed" response.
    if proxy.upstream.is_stream && status.is_success() {
        if proxy.upstream.wire_api == UpstreamWireApi::Responses {
            let stream = proxy.upstream.response.bytes_stream();
            return crate::http::response(status, "text/event-stream", Body::from_stream(stream));
        }
        let original = proxy.original_request;
        let mut upstream = proxy.upstream.response.bytes_stream();
        let stream = async_stream::stream! {
            let mut converter = ChatSseToResponsesConverter::with_request(&original);
            while let Some(chunk) = upstream.next().await {
                match chunk {
                    Ok(bytes) => {
                        let converted = converter.push_bytes(&bytes);
                        if !converted.is_empty() { yield Ok::<Bytes, Infallible>(Bytes::from(converted)); }
                    }
                    Err(error) => {
                        let failed = converter.fail(error.to_string(), Some("upstream_stream_error".to_string()));
                        if !failed.is_empty() { yield Ok(Bytes::from(failed)); }
                        return;
                    }
                }
            }
            let finished = converter.finish();
            if !finished.is_empty() { yield Ok(Bytes::from(finished)); }
        };
        return crate::http::response(status, "text/event-stream", Body::from_stream(stream));
    }
    let wire_api = proxy.upstream.wire_api;
    let content_type = proxy.upstream.content_type.clone();
    let original = proxy.original_request;
    let bytes = match read_limited(proxy.upstream.response, status).await {
        Ok(bytes) => bytes,
        Err(error) => return error_response(StatusCode::BAD_GATEWAY, &error.to_string()),
    };
    match provider_non_stream_response(wire_api, status.as_u16(), &content_type, &bytes, &original)
    {
        Ok((content_type, body)) => crate::http::response(status, &content_type, Body::from(body)),
        Err(error) => error_response(StatusCode::BAD_GATEWAY, &error.to_string()),
    }
}

/// Error bodies are only previewed, so a misbehaving relay cannot make the
/// broker buffer an unbounded response.
async fn read_limited(response: reqwest::Response, status: StatusCode) -> anyhow::Result<Bytes> {
    if status.is_success() {
        return Ok(response.bytes().await?);
    }
    let mut stream = response.bytes_stream();
    let mut bytes = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        let room = UPSTREAM_ERROR_LIMIT.saturating_sub(bytes.len());
        bytes.extend_from_slice(&chunk[..chunk.len().min(room)]);
        if bytes.len() >= UPSTREAM_ERROR_LIMIT {
            break;
        }
    }
    Ok(Bytes::from(bytes))
}

fn error_response(status: StatusCode, message: &str) -> Response<Body> {
    crate::http::error(status, "codex_plus_broker_error", None, message)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{Ipv4Addr, TcpListener as StdTcpListener};
    use tempfile::TempDir;

    fn test_paths(temp: &TempDir) -> AccountPaths {
        AccountPaths {
            codex_home: temp.path().join("codex"),
            state_dir: temp.path().join("state"),
            usage_endpoint: String::new(),
        }
    }

    #[tokio::test]
    async fn keeps_the_preferred_port_when_it_is_available() {
        let candidate = StdTcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let preferred_port = candidate.local_addr().unwrap().port();
        drop(candidate);
        let temp = TempDir::new().unwrap();

        let mut handle = start_on_port(test_paths(&temp), preferred_port)
            .await
            .unwrap();

        assert_eq!(handle.port(), preferred_port);
        assert!(handle.preferred_bind_error().is_none());
        assert!(StdTcpListener::bind((Ipv4Addr::LOCALHOST, handle.port())).is_err());
        handle.shutdown().await;
    }

    #[tokio::test]
    async fn falls_back_and_keeps_the_selected_port_reserved() {
        let occupied = StdTcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let preferred_port = occupied.local_addr().unwrap().port();
        let temp = TempDir::new().unwrap();

        let mut handle = start_on_port(test_paths(&temp), preferred_port)
            .await
            .unwrap();

        assert_ne!(handle.port(), preferred_port);
        assert!(handle.preferred_bind_error().is_some());
        assert!(StdTcpListener::bind((Ipv4Addr::LOCALHOST, handle.port())).is_err());
        handle.shutdown().await;
    }

    #[tokio::test]
    async fn cancelled_broker_wait_releases_its_listener() {
        let temp = TempDir::new().unwrap();
        let mut handle = start_on_port(test_paths(&temp), 0).await.unwrap();
        let port = handle.port();

        tokio::select! {
            _ = handle.wait() => panic!("broker ended before the managed lifecycle"),
            _ = std::future::ready(()) => {},
        }
        handle.shutdown().await;

        assert!(StdTcpListener::bind((Ipv4Addr::LOCALHOST, port)).is_ok());
        let mut next = start_on_port(test_paths(&temp), port).await.unwrap();
        assert_eq!(next.port(), port);
        assert!(next.preferred_bind_error().is_none());
        next.shutdown().await;
    }

    #[tokio::test]
    async fn requires_the_random_token_and_a_loopback_host() {
        let temp = TempDir::new().unwrap();
        let mut broker = start_on_port(test_paths(&temp), 0).await.unwrap();
        let url = format!("http://127.0.0.1:{}/v1/models", broker.port());
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let status = |request: reqwest::RequestBuilder| async move {
            request.send().await.unwrap().status()
        };
        assert_eq!(
            status(client.get(&url).bearer_auth("codex-plus-loopback")).await,
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            status(client.get(&url).bearer_auth(broker.token())).await,
            StatusCode::OK
        );
        assert_eq!(
            status(
                client
                    .get(&url)
                    .header(header::HOST, "rebind.example:43121")
                    .bearer_auth(broker.token())
            )
            .await,
            StatusCode::FORBIDDEN
        );
        broker.shutdown().await;
    }

    #[tokio::test]
    async fn stream_requests_surface_upstream_rejections_instead_of_empty_completions() {
        use wiremock::{Mock, MockServer, ResponseTemplate, matchers::method};
        let upstream = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(429).set_body_json(
                json!({"error":{"message":"relay quota exhausted","type":"rate_limit"}}),
            ))
            .mount(&upstream)
            .await;
        let temp = TempDir::new().unwrap();
        let paths = test_paths(&temp);
        for protocol in ["chatCompletions", "responses"] {
            let mut store = crate::providers::ProviderStore::load(&paths).unwrap();
            store.providers.clear();
            store
                .upsert(
                    serde_json::from_value(json!({
                        "id": "relay", "name": "Relay", "baseUrl": upstream.uri(),
                        "apiKey": "key", "protocol": protocol,
                        "models": [{"modelId": "m", "visible": true, "contextWindow": 200000, "toolMode": "direct"}]
                    }))
                    .unwrap(),
                )
                .unwrap();
            store.save(&paths).unwrap();
            let route = store.providers[0].models[0].route_id.clone();
            let mut broker = start_on_port(paths.clone(), 0).await.unwrap();
            let response = reqwest::Client::builder()
                .no_proxy()
                .build()
                .unwrap()
                .post(format!("http://127.0.0.1:{}/v1/responses", broker.port()))
                .bearer_auth(broker.token())
                .json(&json!({"model": route, "stream": true, "input": []}))
                .send()
                .await
                .unwrap();
            assert_eq!(
                response.status(),
                StatusCode::TOO_MANY_REQUESTS,
                "{protocol}"
            );
            let body = response.text().await.unwrap();
            assert!(body.contains("relay quota exhausted"), "{protocol}: {body}");
            assert!(!body.contains("response.completed"), "{protocol}: {body}");
            broker.shutdown().await;
        }
    }
}
