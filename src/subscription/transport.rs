use super::*;

pub(super) fn native_request(
    client: &reqwest::Client,
    credential: &AccountCredential,
    url: &str,
    post: bool,
) -> reqwest::RequestBuilder {
    let request = if post {
        client.post(url)
    } else {
        client.get(url)
    };
    request
        .bearer_auth(&credential.access_token)
        .header("ChatGPT-Account-Id", &credential.account_id)
        .header("originator", "codex_cli_rs")
        .header(
            "Accept",
            if post {
                "text/event-stream"
            } else {
                "application/json"
            },
        )
}

pub(super) async fn read_bounded(
    response: reqwest::Response,
    limit: usize,
) -> anyhow::Result<Vec<u8>> {
    let mut stream = response.bytes_stream();
    let mut bytes = Vec::new();
    while let Some(chunk) = tokio::time::timeout(IDLE_TIMEOUT, stream.next()).await? {
        let chunk = chunk?;
        if bytes.len() + chunk.len() > limit {
            bail!("upstream body too large");
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

pub(super) fn recoverable(value: &Value, retry_after: Option<u64>) -> Option<(&'static str, u64)> {
    let e = value
        .get("error")
        .or_else(|| value.pointer("/response/error"))
        .unwrap_or(value);
    let code = e["code"]
        .as_str()
        .or_else(|| e["type"].as_str())
        .unwrap_or("");
    let reason = match code {
        "usage_limit_reached"
        | "usage_limit_exceeded"
        | "insufficient_quota"
        | "subscription_sharing_usage_limit_exceeded" => "额度限制",
        "rate_limit_exceeded" => "请求频率限制",
        "model_not_found" | "model_not_available" | "unsupported_model" => "该账户不可用此模型",
        _ => return None,
    };
    let reset = e["resets_at"]
        .as_u64()
        .or_else(|| e["reset_at"].as_u64())
        .or_else(|| value["resets_at"].as_u64());
    let until = reset
        .filter(|t| *t > unix_now())
        .unwrap_or_else(|| unix_now() + retry_after.unwrap_or(60).clamp(1, 300));
    Some((reason, until))
}

type ByteStream = Pin<Box<dyn Stream<Item = Result<Bytes, reqwest::Error>> + Send>>;
pub(super) enum Prepared {
    Retry(Value),
    Stream {
        prefix: Vec<u8>,
        tail: ByteStream,
        guard: SseGuard,
    },
}

#[derive(Default)]
pub(super) struct SseGuard {
    pub(super) buffer: Vec<u8>,
    pub(super) committed: bool,
    pub(super) terminal: bool,
    pub(super) failure: Option<Value>,
    pub(super) quota_update: Option<crate::accounts::Usage>,
}
impl SseGuard {
    pub(super) fn push(&mut self, bytes: &[u8]) {
        self.buffer.extend_from_slice(bytes);
        while let Some(end) = self.buffer.iter().position(|b| *b == b'\n') {
            let line: Vec<_> = self.buffer.drain(..=end).collect();
            let line = String::from_utf8_lossy(&line);
            let Some(data) = line.trim_end().strip_prefix("data:").map(str::trim_start) else {
                continue;
            };
            let Ok(value) = serde_json::from_str::<Value>(data) else {
                continue;
            };
            let kind = value["type"].as_str().unwrap_or("");
            if kind == "codex.rate_limits"
                && let Some(usage) = quota::usage_event(&value)
            {
                self.quota_update = Some(usage);
            }
            if matches!(kind, "response.failed" | "error") {
                self.failure = Some(value);
                self.terminal = true;
            } else if matches!(kind, "response.completed" | "response.incomplete") {
                self.terminal = true;
            } else if kind.starts_with("response.output_item.") || kind.ends_with(".delta") {
                self.committed = true;
            }
        }
        if self.buffer.len() > PRELUDE_LIMIT {
            self.committed = true;
            self.buffer.clear();
        }
    }
}

pub(super) async fn prepare_stream(response: reqwest::Response) -> anyhow::Result<Prepared> {
    let mut tail: ByteStream = Box::pin(response.bytes_stream());
    let mut prefix = Vec::new();
    let mut guard = SseGuard::default();
    let deadline = tokio::time::Instant::now() + IDLE_TIMEOUT;
    while let Some(bytes) = tokio::time::timeout_at(deadline, tail.next()).await? {
        let bytes = bytes?;
        prefix.extend_from_slice(&bytes);
        guard.push(&bytes);
        // Commitment wins if a chunk contains both output and a later failure.
        if guard.committed || prefix.len() >= PRELUDE_LIMIT {
            return Ok(Prepared::Stream {
                prefix,
                tail,
                guard,
            });
        }
        if let Some(failure) = guard.failure {
            return Ok(Prepared::Retry(failure));
        }
        if guard.terminal {
            return Ok(Prepared::Stream {
                prefix,
                tail,
                guard,
            });
        }
    }
    bail!("upstream stream ended without terminal event")
}

pub(super) fn error(status: StatusCode, code: &str, message: &str) -> Response<Body> {
    response_body(
        status,
        "application/json",
        Body::from(
            json!({"error":{"type":"codex_plus_subscription_error","code":code,"message":message}})
                .to_string(),
        ),
    )
}
pub(super) fn response_body(status: StatusCode, content_type: &str, body: Body) -> Response<Body> {
    Response::builder()
        .status(status)
        .header("Content-Type", content_type)
        .header("Cache-Control", "no-cache")
        .body(body)
        .unwrap()
}
