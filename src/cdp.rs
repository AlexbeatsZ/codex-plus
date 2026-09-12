use std::time::Duration;

use anyhow::{Context as _, bail};
use futures_util::{SinkExt as _, StreamExt as _};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::mpsc;
use tokio::time::Instant;
use tokio_tungstenite::tungstenite::Message;

use crate::service::AccountService;

const BINDING_NAME: &str = "codexPlusAccountsBridgeV1";
const BINDING_PLACEHOLDER: &str = "\"__CODEX_PLUS_BINDING_NAME__\"";
const BRIDGE_SCRIPT: &str = include_str!("../assets/bridge.js");
const RENDERER_SCRIPT: &str = include_str!("../assets/renderer.js");
const API_PROVIDERS_SCRIPT: &str = include_str!("../assets/api-providers.js");
const MODEL_ROUTING_SCRIPT: &str = include_str!("../assets/model-routing.js");

/// 心跳保持 15 秒一次：健康检查只做一次极轻量 evaluate，不应变成固定频率的 DOM 扫描。
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(15);
/// macOS 睡眠唤醒后，launcher 保留的旧 CDP socket 会长期保持 ESTABLISHED 却不再回包。
/// 心跳必须要求回包，超过该时限即判定连接假存活，丢弃 socket 并重新注入。
const HEARTBEAT_TIMEOUT: Duration = Duration::from_secs(45);
const LIVENESS_INTERVAL: Duration = Duration::from_secs(5);
/// 对端完全停止读取时 socket 写缓冲最终会写满，写入本身也必须有时限。
const WRITE_TIMEOUT: Duration = Duration::from_secs(10);
const HEARTBEAT_SCRIPT: &str = "(() => { const health = window.__codexPlusAccounts?.health?.(); if (!health?.ready || !health?.observerReady) window.__codexPlusAccounts?.install?.(); return true; })()";

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Target {
    id: String,
    #[serde(rename = "type")]
    kind: String,
    title: String,
    url: String,
    web_socket_debugger_url: Option<String>,
}

#[derive(Debug, Deserialize)]
struct BridgeRequest {
    id: String,
    path: String,
    #[serde(default)]
    payload: Value,
}

pub async fn endpoint_available(port: u16) -> bool {
    let Ok(client) = local_client() else {
        return false;
    };
    client
        .get(format!("http://127.0.0.1:{port}/json"))
        .timeout(Duration::from_secs(1))
        .send()
        .await
        .is_ok()
}

pub async fn run_watchdog(port: u16, service: AccountService) -> anyhow::Result<()> {
    loop {
        match discover_main_target(port).await {
            Ok(target) => {
                crate::runtime::append_log(
                    service.paths(),
                    "injection.target.found",
                    json!({"targetId": target.id, "title": target.title}),
                );
                if let Err(error) = run_target_session(&target, service.clone()).await {
                    crate::runtime::append_log(
                        service.paths(),
                        "injection.session.failed",
                        json!({"message": error.to_string()}),
                    );
                }
            }
            Err(error) => {
                crate::runtime::append_log(
                    service.paths(),
                    "injection.target.waiting",
                    json!({"message": error.to_string()}),
                );
            }
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
}

async fn discover_main_target(port: u16) -> anyhow::Result<Target> {
    let targets = local_client()?
        .get(format!("http://127.0.0.1:{port}/json"))
        .timeout(Duration::from_secs(2))
        .send()
        .await
        .context("CDP 尚未就绪")?
        .error_for_status()
        .context("CDP target 列表不可用")?
        .json::<Vec<Target>>()
        .await
        .context("CDP target 列表无效")?;
    pick_main_target(targets).ok_or_else(|| anyhow::anyhow!("没有找到 Codex 主页面"))
}

fn pick_main_target(targets: Vec<Target>) -> Option<Target> {
    targets.into_iter().find(|target| {
        target.kind == "page"
            && target.web_socket_debugger_url.is_some()
            && (target.url == "app://-/index.html"
                || (target.url.starts_with("app://-/index.html?")
                    && !target.url.contains("avatar-overlay")))
    })
}

/// 会话内部的时限参数。默认值是正式运行使用的常量，测试可以缩短以便快速验证失活检测。
#[derive(Debug, Clone, Copy)]
struct SessionTuning {
    heartbeat: Duration,
    heartbeat_timeout: Duration,
    liveness: Duration,
}

impl Default for SessionTuning {
    fn default() -> Self {
        Self {
            heartbeat: HEARTBEAT_INTERVAL,
            heartbeat_timeout: HEARTBEAT_TIMEOUT,
            liveness: LIVENESS_INTERVAL,
        }
    }
}

async fn run_target_session(target: &Target, service: AccountService) -> anyhow::Result<()> {
    run_target_session_with_tuning(target, service, SessionTuning::default()).await
}

async fn run_target_session_with_tuning(
    target: &Target,
    service: AccountService,
    tuning: SessionTuning,
) -> anyhow::Result<()> {
    let websocket_url = target
        .web_socket_debugger_url
        .as_deref()
        .ok_or_else(|| anyhow::anyhow!("Codex target 缺少 WebSocket 地址"))?;
    let (mut socket, _) = tokio_tungstenite::connect_async(websocket_url)
        .await
        .context("无法连接 Codex CDP WebSocket")?;
    let mut next_id = 1_u64;

    command(&mut socket, &mut next_id, "Runtime.enable", json!({})).await?;
    let _ = command(
        &mut socket,
        &mut next_id,
        "Runtime.removeBinding",
        json!({"name": BINDING_NAME}),
    )
    .await;
    command(
        &mut socket,
        &mut next_id,
        "Runtime.addBinding",
        json!({"name": BINDING_NAME}),
    )
    .await?;

    let bridge_script = browser_bridge_script();
    for script in [
        &bridge_script,
        RENDERER_SCRIPT,
        API_PROVIDERS_SCRIPT,
        MODEL_ROUTING_SCRIPT,
    ] {
        command(
            &mut socket,
            &mut next_id,
            "Page.addScriptToEvaluateOnNewDocument",
            json!({"source": script}),
        )
        .await?;
    }
    evaluate(&mut socket, &mut next_id, &bridge_script).await?;
    evaluate(&mut socket, &mut next_id, RENDERER_SCRIPT).await?;
    evaluate(&mut socket, &mut next_id, API_PROVIDERS_SCRIPT).await?;
    evaluate(&mut socket, &mut next_id, MODEL_ROUTING_SCRIPT).await?;
    let health = evaluate(
        &mut socket,
        &mut next_id,
        "({accounts:window.__codexPlusAccounts?.health?.()||null,api:!!window.__codexPlusApi,models:!!window.__codexPlusModelRouting})",
    )
    .await?;
    if !health
        .get("result")
        .and_then(|value| value.get("result"))
        .and_then(|value| value.get("value"))
        .and_then(Value::as_object)
        .is_some_and(|value| {
            value
                .get("accounts")
                .and_then(|accounts| accounts.get("ready"))
                .and_then(Value::as_bool)
                == Some(true)
                && value
                    .get("accounts")
                    .and_then(|accounts| accounts.get("observerReady"))
                    .and_then(Value::as_bool)
                    == Some(true)
                && value.get("api").and_then(Value::as_bool) == Some(true)
                && value.get("models").and_then(Value::as_bool) == Some(true)
        })
    {
        bail!("renderer 注入健康检查失败：{health}");
    }
    crate::runtime::append_log(service.paths(), "injection.ready", json!({}));

    let (responses_tx, mut responses_rx) = mpsc::unbounded_channel::<(String, Value)>();
    let mut heartbeat = tokio::time::interval(tuning.heartbeat);
    let mut liveness = tokio::time::interval(tuning.liveness);
    let mut pending_heartbeat: Option<u64> = None;
    let mut heartbeat_deadline = Instant::now() + tuning.heartbeat_timeout;
    loop {
        tokio::select! {
            next = socket.next() => {
                let Some(next) = next else { bail!("CDP WebSocket 已关闭") };
                let message = next.context("读取 CDP 消息失败")?;
                let Message::Text(text) = message else { continue };
                let value: Value = serde_json::from_str(text.as_str()).context("CDP 消息不是 JSON")?;
                if value.get("id").and_then(Value::as_u64) == pending_heartbeat {
                    pending_heartbeat = None;
                }
                if value.get("method").and_then(Value::as_str) == Some("Runtime.bindingCalled") {
                    let name = value.pointer("/params/name").and_then(Value::as_str);
                    if name != Some(BINDING_NAME) { continue; }
                    let raw = value.pointer("/params/payload").and_then(Value::as_str).unwrap_or_default();
                    let request = match serde_json::from_str::<BridgeRequest>(raw) {
                        Ok(request) => request,
                        Err(_) => continue,
                    };
                    let tx = responses_tx.clone();
                    let service = service.clone();
                    tokio::spawn(async move {
                        let result = service.handle(&request.path, request.payload).await;
                        let _ = tx.send((request.id, result));
                    });
                } else if value.get("id").is_some()
                    && (value.get("error").is_some() || value.pointer("/result/exceptionDetails").is_some())
                {
                    crate::runtime::append_log(service.paths(), "cdp.command.failed", json!({"response": value}));
                }
            }
            Some((request_id, value)) = responses_rx.recv() => {
                let expression = format!(
                    "window.__codexPlusBridgeResolve?.({},{})",
                    serde_json::to_string(&request_id)?,
                    serde_json::to_string(&value)?
                );
                send_evaluate_async(&mut socket, &mut next_id, &expression).await?;
            }
            _ = liveness.tick() => {
                // 心跳已发出但没有回包：socket 可能仍然 ESTABLISHED，渲染器却不再处理消息。
                if pending_heartbeat.is_some() && Instant::now() >= heartbeat_deadline {
                    crate::runtime::append_log(
                        service.paths(),
                        "injection.heartbeat.stalled",
                        json!({"timeoutSeconds": tuning.heartbeat_timeout.as_secs()}),
                    );
                    bail!(
                        "CDP 心跳超过 {} 秒未回包，连接进入假存活状态",
                        tuning.heartbeat_timeout.as_secs()
                    );
                }
            }
            _ = heartbeat.tick() => {
                if pending_heartbeat.is_none() {
                    let id = send_evaluate_async(&mut socket, &mut next_id, HEARTBEAT_SCRIPT).await?;
                    pending_heartbeat = Some(id);
                    heartbeat_deadline = Instant::now() + tuning.heartbeat_timeout;
                }
            }
        }
    }
}

fn browser_bridge_script() -> String {
    BRIDGE_SCRIPT.replace(
        BINDING_PLACEHOLDER,
        &serde_json::to_string(BINDING_NAME).expect("binding name is serializable"),
    )
}

async fn evaluate<S>(
    socket: &mut tokio_tungstenite::WebSocketStream<S>,
    next_id: &mut u64,
    expression: &str,
) -> anyhow::Result<Value>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    command(
        socket,
        next_id,
        "Runtime.evaluate",
        json!({"expression": expression, "returnByValue": true, "awaitPromise": true}),
    )
    .await
}

async fn command<S>(
    socket: &mut tokio_tungstenite::WebSocketStream<S>,
    next_id: &mut u64,
    method: &str,
    params: Value,
) -> anyhow::Result<Value>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    let id = *next_id;
    *next_id += 1;
    write_message(
        socket,
        Message::Text(
            serde_json::to_string(&json!({"id": id, "method": method, "params": params}))?.into(),
        ),
    )
    .await?;
    loop {
        let message = tokio::time::timeout(Duration::from_secs(8), socket.next())
            .await
            .context("CDP 命令超时")?
            .ok_or_else(|| anyhow::anyhow!("CDP WebSocket 已关闭"))??;
        let Message::Text(text) = message else {
            continue;
        };
        let response: Value = serde_json::from_str(text.as_str())?;
        if response.get("id").and_then(Value::as_u64) != Some(id) {
            continue;
        }
        if let Some(error) = response.get("error") {
            bail!("CDP {method} 失败：{error}");
        }
        if let Some(exception) = response.pointer("/result/exceptionDetails") {
            bail!("CDP {method} 执行异常：{exception}");
        }
        return Ok(response);
    }
}

/// 发送但不等待回包的 `Runtime.evaluate`，返回本次命令的 id，
/// 便于调用方（例如心跳）在后续消息里确认它确实被执行过。
async fn send_evaluate_async<S>(
    socket: &mut tokio_tungstenite::WebSocketStream<S>,
    next_id: &mut u64,
    expression: &str,
) -> anyhow::Result<u64>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    let id = *next_id;
    *next_id += 1;
    write_message(
        socket,
        Message::Text(
            serde_json::to_string(&json!({
                "id": id,
                "method": "Runtime.evaluate",
                "params": {"expression": expression, "returnByValue": true}
            }))?
            .into(),
        ),
    )
    .await?;
    Ok(id)
}

async fn write_message<S>(
    socket: &mut tokio_tungstenite::WebSocketStream<S>,
    message: Message,
) -> anyhow::Result<()>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    tokio::time::timeout(WRITE_TIMEOUT, socket.send(message))
        .await
        .context("CDP 写入超时，连接已失效")?
        .context("写入 CDP 消息失败")
}

fn local_client() -> anyhow::Result<reqwest::Client> {
    reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(3))
        .build()
        .context("无法创建本地 CDP client")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::accounts::AccountPaths;

    fn target(url: &str, kind: &str) -> Target {
        Target {
            id: url.to_string(),
            kind: kind.to_string(),
            title: "Codex".to_string(),
            url: url.to_string(),
            web_socket_debugger_url: Some("ws://localhost/devtools/page/1".to_string()),
        }
    }

    #[test]
    fn main_target_excludes_webviews_and_avatar_overlay() {
        let picked = pick_main_target(vec![
            target("https://chatgpt.com", "webview"),
            target("app://-/index.html?initialRoute=%2Favatar-overlay", "page"),
            target("app://-/index.html", "page"),
        ])
        .unwrap();
        assert_eq!(picked.url, "app://-/index.html");
    }

    #[test]
    fn bridge_script_does_not_embed_credentials() {
        let script = browser_bridge_script();
        assert!(script.contains(BINDING_NAME));
        assert!(!script.contains(BINDING_PLACEHOLDER));
        assert!(!script.contains("access_token"));
        assert!(!script.contains("refresh_token"));
    }

    #[test]
    fn bridge_script_fails_stalled_requests() {
        let script = browser_bridge_script();
        assert!(script.contains("__codexPlusPending"));
        assert!(script.contains("请求超时"));
        assert!(script.contains("桥已重新连接"));
    }

    #[test]
    fn injected_scripts_do_not_embed_provider_keys() {
        assert!(!API_PROVIDERS_SCRIPT.contains("secret-value"));
        assert!(!MODEL_ROUTING_SCRIPT.contains("apiKey"));
    }

    fn test_service(state_dir: &std::path::Path) -> AccountService {
        AccountService::new(AccountPaths {
            codex_home: state_dir.join("codex-home"),
            state_dir: state_dir.to_path_buf(),
            usage_endpoint: "http://127.0.0.1:1/usage".to_string(),
        })
    }

    fn healthy_health_payload(id: Value) -> Value {
        json!({
            "id": id,
            "result": {
                "result": {
                    "type": "object",
                    "value": {
                        "accounts": {"ready": true, "observerReady": true},
                        "api": true,
                        "models": true,
                    }
                }
            }
        })
    }

    /// 模拟 macOS 睡眠唤醒后的真实故障：CDP socket 仍然 ESTABLISHED、握手命令也成功，
    /// 但渲染器不再处理消息（心跳没有回包）。会话必须在心跳超时后主动报错退出，
    /// 这样 watchdog 才能丢弃旧 socket 并重新注入。
    #[tokio::test]
    async fn session_fails_when_heartbeat_stops_being_answered() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
            let mut evaluates = 0_u32;
            while let Some(Ok(message)) = socket.next().await {
                let Message::Text(text) = message else { continue };
                let value: Value = serde_json::from_str(text.as_str()).unwrap();
                let id = value.get("id").cloned().unwrap_or(Value::Null);
                let is_evaluate =
                    value.get("method").and_then(Value::as_str) == Some("Runtime.evaluate");
                if is_evaluate {
                    evaluates += 1;
                    // 前 5 次 evaluate 是注入脚本与注入健康检查，之后模拟渲染器停止回包。
                    if evaluates > 5 {
                        continue;
                    }
                }
                let response = healthy_health_payload(id);
                if socket
                    .send(Message::Text(response.to_string().into()))
                    .await
                    .is_err()
                {
                    break;
                }
            }
        });

        let state_dir = tempfile::tempdir().unwrap();
        let service = test_service(state_dir.path());
        let mut injected_target = target("app://-/index.html", "page");
        injected_target.web_socket_debugger_url =
            Some(format!("ws://127.0.0.1:{port}/devtools/page/1"));
        let tuning = SessionTuning {
            heartbeat: Duration::from_millis(50),
            heartbeat_timeout: Duration::from_millis(200),
            liveness: Duration::from_millis(50),
        };

        let result = tokio::time::timeout(
            Duration::from_secs(5),
            run_target_session_with_tuning(&injected_target, service, tuning),
        )
        .await
        .expect("心跳失活后会话必须自行结束，而不是永久挂起")
        .expect_err("心跳没有回包时会话必须报错");
        assert!(result.to_string().contains("心跳"), "{result}");
        server.abort();
    }
}
