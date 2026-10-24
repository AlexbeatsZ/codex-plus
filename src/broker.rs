use std::convert::Infallible;

use axum::Router;
use axum::body::{Body, Bytes};
use axum::extract::State;
use axum::http::{HeaderMap, HeaderValue, Request, Response, StatusCode, header};
use axum::routing::{get, post};
use futures_util::StreamExt as _;
use serde_json::{Value, json};
use tokio::net::TcpListener;

#[cfg(any(test, debug_assertions))]
use crate::accounts::AccountPaths;
use crate::config::BROKER_TOKEN;
use crate::integrations::{ApiIntegrations, ModelRoute};
use crate::protocol_proxy::{
    ChatSseToResponsesConverter, UpstreamWireApi, open_provider_responses_request,
    provider_non_stream_response,
};

// Keep the stable port below Windows' default dynamic client range
// (49152-65535). WSL mirrored networking tracks client ports in that range
// and can make an otherwise unused host port fail to bind with WSAEACCES.
pub const PREFERRED_BROKER_PORT: u16 = 43121;

#[derive(Clone)]
struct BrokerState {
    apis: ApiIntegrations,
}

pub struct BrokerHandle {
    port: u16,
    preferred_bind_error: Option<String>,
    task: Option<tokio::task::JoinHandle<anyhow::Result<()>>>,
}

impl BrokerHandle {
    pub fn port(&self) -> u16 {
        self.port
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

pub async fn start(preferred_port: u16, apis: ApiIntegrations) -> anyhow::Result<BrokerHandle> {
    let (listener, preferred_bind_error) = match TcpListener::bind(("127.0.0.1", preferred_port))
        .await
    {
        Ok(listener) => (listener, None),
        Err(preferred_error) => {
            let listener = TcpListener::bind(("127.0.0.1", 0)).await.map_err(|fallback_error| {
                    anyhow::anyhow!(
                        "无法启动本机 API broker；首选端口 127.0.0.1:{preferred_port} 失败: {preferred_error}；选择备用端口失败: {fallback_error}"
                    )
                })?;
            (listener, Some(preferred_error.to_string()))
        }
    };
    let port = listener.local_addr().map_err(anyhow::Error::from)?.port();
    let state = BrokerState { apis };
    let app = Router::new()
        .route("/health", get(|| async { "ok" }))
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
        .with_state(state);
    let task = tokio::spawn(async move {
        axum::serve(listener, app)
            .await
            .map_err(anyhow::Error::from)
    });
    Ok(BrokerHandle {
        port,
        preferred_bind_error,
        task: Some(task),
    })
}

async fn models(State(state): State<BrokerState>, headers: HeaderMap) -> Response<Body> {
    if !authorized(&headers) {
        return error_response(StatusCode::UNAUTHORIZED, "broker authorization failed");
    }
    match state.apis.catalog() {
        Ok(models) => json_response(
            StatusCode::OK,
            json!({"object":"list","data":models.into_iter().map(|m|json!({"id":m.route_id,"object":"model","owned_by":m.provider_id})).collect::<Vec<_>>()}),
        ),
        Err(_) => error_response(StatusCode::INTERNAL_SERVER_ERROR, "API 模型目录读取失败"),
    }
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
    if !authorized(&headers) {
        return error_response(StatusCode::UNAUTHORIZED, "broker authorization failed");
    }
    let user_agent = headers
        .get(header::USER_AGENT)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    let path = request.uri().path().to_string();
    let body = match axum::body::to_bytes(request.into_body(), 32 * 1024 * 1024).await {
        Ok(value) => value,
        Err(error) => {
            return error_response(
                StatusCode::BAD_REQUEST,
                &format!("request body failed: {error}"),
            );
        }
    };
    let mut value: Value = match serde_json::from_slice(&body) {
        Ok(value) => value,
        Err(_) => return error_response(StatusCode::BAD_REQUEST, "request is not valid JSON"),
    };
    let route_id = match value
        .get("model")
        .and_then(Value::as_str)
        .map(str::to_string)
    {
        Some(value) => value,
        None => return error_response(StatusCode::BAD_REQUEST, "missing route model"),
    };
    if subscription_endpoint || route_id == crate::subscription::AUTO_REVIEW_MODEL {
        // Native pre-turn compaction may use the previous turn's real model ID.
        // Keep that compatibility confined to the subscription provider's URL.
        return state
            .apis
            .subscription
            .responses(headers, value, path.ends_with("/compact"))
            .await;
    }
    let (profile, model) = match state.apis.resolve(&route_id) {
        Ok(ModelRoute::Subscription) => {
            return state
                .apis
                .subscription
                .responses(headers, value, path.ends_with("/compact"))
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
        match open_provider_responses_request(&profile, &serialized, user_agent.as_deref(), &path)
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
    if proxy.upstream.is_stream {
        if proxy.upstream.wire_api == UpstreamWireApi::Responses {
            let stream = proxy.upstream.response.bytes_stream();
            return build_response(status, "text/event-stream", Body::from_stream(stream));
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
        return build_response(status, "text/event-stream", Body::from_stream(stream));
    }
    let wire_api = proxy.upstream.wire_api;
    let content_type = proxy.upstream.content_type.clone();
    let original = proxy.original_request;
    let bytes = match proxy.upstream.response.bytes().await {
        Ok(bytes) => bytes,
        Err(error) => return error_response(StatusCode::BAD_GATEWAY, &error.to_string()),
    };
    match provider_non_stream_response(wire_api, status.as_u16(), &content_type, &bytes, &original)
    {
        Ok((content_type, body)) => build_response(status, &content_type, Body::from(body)),
        Err(error) => error_response(StatusCode::BAD_GATEWAY, &error.to_string()),
    }
}

fn authorized(headers: &HeaderMap) -> bool {
    let expected = format!("Bearer {BROKER_TOKEN}");
    headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        == Some(expected.as_str())
}

fn json_response(status: StatusCode, value: Value) -> Response<Body> {
    build_response(
        status,
        "application/json; charset=utf-8",
        Body::from(value.to_string()),
    )
}

fn error_response(status: StatusCode, message: &str) -> Response<Body> {
    json_response(
        status,
        json!({"error":{"message":message,"type":"codex_plus_broker_error"}}),
    )
}

fn build_response(status: StatusCode, content_type: &str, body: Body) -> Response<Body> {
    let mut response = Response::new(body);
    *response.status_mut() = status;
    if let Ok(value) = HeaderValue::from_str(content_type) {
        response.headers_mut().insert(header::CONTENT_TYPE, value);
    }
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    response
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
}
