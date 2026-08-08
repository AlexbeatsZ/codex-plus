use std::time::Duration;

use anyhow::{Context as _, bail};
use futures_util::{SinkExt as _, StreamExt as _};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

use crate::service::AccountService;

const BINDING_NAME: &str = "codexPlusAccountsBridgeV1";
const RENDERER_SCRIPT: &str = include_str!("../assets/renderer.js");

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

async fn run_target_session(target: &Target, service: AccountService) -> anyhow::Result<()> {
    let websocket_url = target
        .web_socket_debugger_url
        .as_deref()
        .ok_or_else(|| anyhow::anyhow!("Codex target 缺少 WebSocket 地址"))?;
    let (mut socket, _) = tokio_tungstenite::connect_async(websocket_url)
        .await
        .context("无法连接 Codex CDP WebSocket")?;
    let mut next_id = 1_u64;

    command(&mut socket, &mut next_id, "Runtime.enable", json!({})).await?;
    command(&mut socket, &mut next_id, "Page.enable", json!({})).await?;
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
    for script in [&bridge_script, RENDERER_SCRIPT] {
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
    let health = evaluate(
        &mut socket,
        &mut next_id,
        "window.__codexPlusAccounts?.health?.() || null",
    )
    .await?;
    if !health
        .get("result")
        .and_then(|value| value.get("result"))
        .and_then(|value| value.get("value"))
        .and_then(Value::as_object)
        .is_some_and(|value| {
            value.get("ready").and_then(Value::as_bool) == Some(true)
                && value.get("observerReady").and_then(Value::as_bool) == Some(true)
        })
    {
        bail!("renderer 注入健康检查失败：{health}");
    }
    crate::runtime::append_log(service.paths(), "injection.ready", json!({}));

    let (responses_tx, mut responses_rx) = mpsc::unbounded_channel::<(String, Value)>();
    let mut heartbeat = tokio::time::interval(Duration::from_secs(2));
    loop {
        tokio::select! {
            next = socket.next() => {
                let Some(next) = next else { bail!("CDP WebSocket 已关闭") };
                let message = next.context("读取 CDP 消息失败")?;
                let Message::Text(text) = message else { continue };
                let value: Value = serde_json::from_str(text.as_str()).context("CDP 消息不是 JSON")?;
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
                send_evaluate_without_wait(&mut socket, &mut next_id, &expression).await?;
            }
            _ = heartbeat.tick() => {
                send_evaluate_without_wait(
                    &mut socket,
                    &mut next_id,
                    "window.__codexPlusAccounts?.install?.(); true",
                ).await?;
            }
        }
    }
}

fn browser_bridge_script() -> String {
    format!(
        r#"(() => {{
  const bindingName = {binding};
  if (window.__codexPlusBridgeVersion === 1 && typeof window.codexPlusInvoke === "function") return;
  const pending = new Map();
  let sequence = 0;
  window.__codexPlusBridgeVersion = 1;
  window.codexPlusInvoke = (path, payload = {{}}) => new Promise((resolve, reject) => {{
    const id = `${{Date.now()}}-${{++sequence}}-${{Math.random().toString(16).slice(2)}}`;
    pending.set(id, {{ resolve, reject }});
    try {{
      window[bindingName](JSON.stringify({{ id, path, payload }}));
    }} catch (error) {{
      pending.delete(id);
      reject(error);
    }}
  }});
  window.__codexPlusBridgeResolve = (id, value) => {{
    const entry = pending.get(String(id));
    if (!entry) return false;
    pending.delete(String(id));
    entry.resolve(value);
    return true;
  }};
}})()"#,
        binding = serde_json::to_string(BINDING_NAME).expect("binding name is serializable")
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
    socket
        .send(Message::Text(
            serde_json::to_string(&json!({"id": id, "method": method, "params": params}))?.into(),
        ))
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

async fn send_evaluate_without_wait<S>(
    socket: &mut tokio_tungstenite::WebSocketStream<S>,
    next_id: &mut u64,
    expression: &str,
) -> anyhow::Result<()>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    let id = *next_id;
    *next_id += 1;
    socket
        .send(Message::Text(
            serde_json::to_string(&json!({
                "id": id,
                "method": "Runtime.evaluate",
                "params": {"expression": expression, "returnByValue": true}
            }))?
            .into(),
        ))
        .await?;
    Ok(())
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
        assert!(!script.contains("access_token"));
        assert!(!script.contains("refresh_token"));
    }
}
