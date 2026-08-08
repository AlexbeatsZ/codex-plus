use std::convert::Infallible;
use std::sync::Arc;

use axum::Router;
use axum::body::{Body, Bytes};
use axum::extract::State;
use axum::http::{HeaderMap, HeaderValue, Request, Response, StatusCode, header};
use axum::routing::{get, post};
use futures_util::StreamExt as _;
use serde_json::{Value, json};
use tokio::net::TcpListener;

use crate::accounts::AccountPaths;
use crate::config::BROKER_TOKEN;
use crate::protocol_proxy::{
    ChatSseToResponsesConverter, UpstreamWireApi, open_provider_responses_request,
    provider_non_stream_response,
};
use crate::providers::ProviderStore;

pub const BROKER_PORT: u16 = 57321;

#[derive(Clone)]
struct BrokerState {
    paths: Arc<AccountPaths>,
}

pub struct BrokerHandle {
    task: tokio::task::JoinHandle<anyhow::Result<()>>,
}

impl BrokerHandle {
    pub async fn wait(self) -> anyhow::Result<()> {
        self.task.await.map_err(anyhow::Error::from)?
    }
}

pub async fn start(paths: AccountPaths) -> anyhow::Result<BrokerHandle> {
    let listener = TcpListener::bind(("127.0.0.1", BROKER_PORT))
        .await
        .map_err(|error| {
            anyhow::anyhow!("无法启动本机 API broker 127.0.0.1:{BROKER_PORT}: {error}")
        })?;
    let state = BrokerState {
        paths: Arc::new(paths),
    };
    let app = Router::new()
        .route("/health", get(|| async { "ok" }))
        .route("/v1/models", get(models))
        .route("/models", get(models))
        .route("/v1/responses", post(responses))
        .route("/responses", post(responses))
        .route("/v1/responses/compact", post(responses))
        .route("/responses/compact", post(responses))
        .with_state(state);
    let task = tokio::spawn(async move {
        axum::serve(listener, app)
            .await
            .map_err(anyhow::Error::from)
    });
    Ok(BrokerHandle { task })
}

async fn models(State(state): State<BrokerState>, headers: HeaderMap) -> Response<Body> {
    if !authorized(&headers) {
        return error_response(StatusCode::UNAUTHORIZED, "broker authorization failed");
    }
    match ProviderStore::load(&state.paths) {
        Ok(store) => {
            let data = store.catalog().into_iter().map(|model| json!({"id": model.route_id, "object": "model", "owned_by": model.provider_id})).collect::<Vec<_>>();
            json_response(StatusCode::OK, json!({"object":"list", "data":data}))
        }
        Err(error) => error_response(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string()),
    }
}

async fn responses(
    State(state): State<BrokerState>,
    headers: HeaderMap,
    request: Request<Body>,
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
    let store = match ProviderStore::load(&state.paths) {
        Ok(store) => store,
        Err(error) => return error_response(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string()),
    };
    let (profile, model) = match store.route(&route_id) {
        Some(route) => route,
        None => {
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
