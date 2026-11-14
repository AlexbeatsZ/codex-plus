//! Response helpers and request guards shared by the local HTTP servers.
use axum::body::Body;
use axum::extract::Request;
use axum::http::{HeaderMap, HeaderValue, Response, StatusCode, header};
use axum::middleware::Next;
use serde_json::{Value, json};

/// Largest request body any local endpoint accepts, before or after zstd.
pub const BODY_LIMIT: usize = 32 * 1024 * 1024;

pub fn response(status: StatusCode, content_type: &str, body: Body) -> Response<Body> {
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

pub fn json(status: StatusCode, value: &Value) -> Response<Body> {
    response(
        status,
        "application/json; charset=utf-8",
        Body::from(value.to_string()),
    )
}

/// `{"error":{"type","code"?,"message"}}`, the shape every Codex client parses.
pub fn error(status: StatusCode, kind: &str, code: Option<&str>, message: &str) -> Response<Body> {
    let mut error = json!({"type": kind, "message": message});
    if let Some(code) = code {
        error["code"] = json!(code);
    }
    json(status, &json!({ "error": error }))
}

pub fn bearer_matches(headers: &HeaderMap, token: &str) -> bool {
    let Some(value) = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
    else {
        return false;
    };
    let Some(presented) = value.strip_prefix("Bearer ") else {
        return false;
    };
    // Constant-time comparison: the token is the only local secret.
    presented.len() == token.len()
        && presented
            .bytes()
            .zip(token.bytes())
            .fold(0_u8, |acc, (a, b)| acc | (a ^ b))
            == 0
}

/// Browsers can be pointed at 127.0.0.1 through DNS rebinding; they then send
/// the attacker's hostname. Local clients always name the loopback host.
pub async fn loopback_host_only(request: Request, next: Next) -> Response<Body> {
    if is_loopback_host(request.headers()) {
        next.run(request).await
    } else {
        error(
            StatusCode::FORBIDDEN,
            "codex_plus_host_rejected",
            None,
            "只接受本机回环地址请求",
        )
    }
}

fn is_loopback_host(headers: &HeaderMap) -> bool {
    let Some(host) = headers.get(header::HOST).and_then(|v| v.to_str().ok()) else {
        // HTTP/2 prior-knowledge clients omit Host; only loopback sockets reach us.
        return true;
    };
    let name = if let Some(rest) = host.strip_prefix('[') {
        rest.split(']').next().unwrap_or("")
    } else {
        host.rsplit_once(':').map_or(host, |(name, _)| name)
    };
    matches!(
        name.to_ascii_lowercase().as_str(),
        "127.0.0.1" | "localhost" | "::1"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_guard_accepts_only_loopback_names() {
        let host = |value: &str| {
            let mut headers = HeaderMap::new();
            headers.insert(header::HOST, value.parse().unwrap());
            is_loopback_host(&headers)
        };
        assert!(host("127.0.0.1:43121"));
        assert!(host("localhost"));
        assert!(host("[::1]:9"));
        assert!(!host("evil.example:43121"));
        assert!(!host("127.0.0.1.evil.example"));
    }

    #[test]
    fn bearer_requires_the_exact_token() {
        let mut headers = HeaderMap::new();
        headers.insert(header::AUTHORIZATION, "Bearer secret".parse().unwrap());
        assert!(bearer_matches(&headers, "secret"));
        assert!(!bearer_matches(&headers, "secreT"));
        assert!(!bearer_matches(&headers, "secret2"));
        assert!(!bearer_matches(&HeaderMap::new(), "secret"));
    }
}
