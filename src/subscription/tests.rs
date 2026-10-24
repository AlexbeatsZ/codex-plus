use super::*;
use tempfile::TempDir;
use wiremock::matchers::{header, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

fn jwt(value: Value) -> String {
    format!(
        "header.{}.signature",
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(value.to_string())
    )
}
fn auth(id: &str, expired: bool) -> Vec<u8> {
    serde_json::to_vec(&json!({"auth_mode":"chatgpt","tokens":{
            "id_token":jwt(json!({"sub":id,"email":format!("{id}@example.test")})),
            "access_token":jwt(json!({"sub":id,"exp":if expired {1} else {unix_now()+3600},"client_id":"native-client"})),
            "refresh_token":format!("refresh-{id}"),"account_id":id
        }})).unwrap()
}
struct Fixture {
    _temp: TempDir,
    router: SubscriptionApi,
    config: SubscriptionConfig,
    ids: Vec<String>,
    server: MockServer,
}
async fn fixture() -> Fixture {
    let temp = tempfile::tempdir().unwrap();
    let paths = AccountPaths {
        codex_home: temp.path().join("home"),
        state_dir: temp.path().join("state"),
        usage_endpoint: String::new(),
    };
    let vault = AccountVault::new(paths.clone());
    let ids = ["a", "b"]
        .map(|id| vault.import_auth(&auth(id, false)).unwrap().record_id)
        .to_vec();
    let config = SubscriptionConfig {
        enabled: true,
        account_order: ids.clone(),
        models: vec![crate::providers::SaveModel {
            model_id: "gpt-test".into(),
            display_name: String::new(),
            visible: true,
        }],
        proxy_url: String::new(),
    };
    config.save(&paths).unwrap();
    let server = MockServer::start().await;
    let mut router = SubscriptionApi::new(paths);
    router.native_base = server.uri();
    router.refresh_url = format!("{}/oauth/token", server.uri());
    Fixture {
        _temp: temp,
        router,
        config,
        ids,
        server,
    }
}
fn event(value: Value) -> String {
    format!("data: {value}\n\n")
}
fn success() -> String {
    event(json!({"type":"response.created","response":{"id":"b-response"}}))
        + &event(json!({"type":"response.output_text.delta","delta":"OK"}))
        + &event(
            json!({"type":"response.completed","response":{"id":"b-response","status":"completed"}}),
        )
}
fn request() -> Value {
    json!({"model":route_id("gpt-test"),"stream":true,"input":[{"role":"user","content":"test"}]})
}
async fn send(f: &Fixture) -> (StatusCode, String) {
    let r = f.router.responses(HeaderMap::new(), request(), false).await;
    (
        r.status(),
        String::from_utf8(
            axum::body::to_bytes(r.into_body(), 2 * 1024 * 1024)
                .await
                .unwrap()
                .to_vec(),
        )
        .unwrap(),
    )
}
async fn mount(f: &Fixture, id: &str, status: u16, body: String) {
    Mock::given(method("POST"))
        .and(path("/responses"))
        .and(header("ChatGPT-Account-Id", id))
        .respond_with(ResponseTemplate::new(status).set_body_string(body))
        .mount(&f.server)
        .await;
}
#[tokio::test]
async fn default_is_off_and_order_roundtrips_without_tokens() {
    let mut f = fixture().await;
    assert!(!SubscriptionConfig::default().enabled);
    f.config.account_order.reverse();
    f.config.save(&f.router.paths).unwrap();
    assert_eq!(
        SubscriptionConfig::load(&f.router.paths)
            .unwrap()
            .account_order,
        f.config.account_order
    );
    let view = f.router.view().unwrap().to_string();
    assert!(!view.contains("access_token"));
    assert!(!view.contains("refresh_token"));
    assert_eq!(f.config.catalog()[0].route_id, route_id("gpt-test"));
    f.config
        .account_order
        .push(f.config.account_order[0].clone());
    assert!(f.config.save(&f.router.paths).is_err());
}
#[tokio::test]
async fn uses_saved_order_and_forwards_full_tool_context() {
    let mut f = fixture().await;
    f.config.account_order.reverse();
    f.config.save(&f.router.paths).unwrap();
    mount(&f, "b", 200, success()).await;
    let mut body = request();
    body["input"] =
        json!([{"type":"function_call_output","call_id":"call-1","output":"previous tool result"}]);
    let r = f.router.responses(HeaderMap::new(), body, false).await;
    assert_eq!(r.status(), StatusCode::OK);
    let requests = f.server.received_requests().await.unwrap();
    assert_eq!(requests.len(), 1);
    let b: Value = serde_json::from_slice(&requests[0].body).unwrap();
    assert_eq!(b["model"], "gpt-test");
    assert_eq!(b["input"][0]["call_id"], "call-1");
    assert_eq!(b["store"], false);
}
#[tokio::test]
async fn quota_fails_over_and_next_request_skips_cooled_account() {
    let f = fixture().await;
    mount(
        &f,
        "a",
        429,
        json!({"error":{"type":"usage_limit_reached","resets_at":unix_now()+120}}).to_string(),
    )
    .await;
    mount(&f, "b", 200, success()).await;
    assert_eq!(send(&f).await.0, StatusCode::OK);
    assert_eq!(send(&f).await.0, StatusCode::OK);
    let requests = f.server.received_requests().await.unwrap();
    assert_eq!(requests.len(), 3);
    assert!(f.router.cooling(&f.ids[0], "gpt-test"));
    assert!(!f.router.cooling(&f.ids[0], "other-model"));
}
#[tokio::test]
async fn http_200_quota_before_output_discards_failed_stream() {
    let f = fixture().await;
    mount(&f,"a",200,event(json!({"type":"response.created","response":{"id":"discard-a"}}))+&event(json!({"type":"response.failed","response":{"error":{"code":"usage_limit_reached"}}}))).await;
    mount(&f, "b", 200, success()).await;
    let (status, text) = send(&f).await;
    assert_eq!(status, StatusCode::OK);
    assert!(!text.contains("discard-a"));
    assert!(text.contains("b-response"));
}
#[tokio::test]
async fn never_replays_after_tool_or_text_output_even_with_same_chunk_failure() {
    let f = fixture().await;
    mount(&f,"a",200,event(json!({"type":"response.output_item.added","item":{"type":"function_call","name":"write_file"}}))+&event(json!({"type":"response.failed","response":{"error":{"code":"usage_limit_reached"}}}))).await;
    mount(&f, "b", 200, success()).await;
    let (_, text) = send(&f).await;
    assert!(text.contains("write_file"));
    assert!(text.contains("response.failed"));
    assert_eq!(f.server.received_requests().await.unwrap().len(), 1);
    assert!(f.router.cooling(&f.ids[0], "gpt-test"));
}
#[tokio::test]
async fn unknown_429_or_permission_errors_do_not_rotate_or_leak_body() {
    for status in [429, 403] {
        let f = fixture().await;
        mount(
            &f,
            "a",
            status,
            json!({"error":{"code":"unknown","message":"access-token-secret"}}).to_string(),
        )
        .await;
        mount(&f, "b", 200, success()).await;
        let (actual, text) = send(&f).await;
        assert_eq!(actual.as_u16(), status);
        assert!(!text.contains("access-token-secret"));
        assert_eq!(f.server.received_requests().await.unwrap().len(), 1);
    }
}
#[tokio::test]
async fn unfinished_stream_gets_explicit_failure_and_is_not_replayed() {
    let f = fixture().await;
    mount(
        &f,
        "a",
        200,
        event(json!({"type":"response.output_text.delta","delta":"partial"})),
    )
    .await;
    let (_, text) = send(&f).await;
    assert!(text.contains("upstream_stream_error"));
    assert_eq!(f.server.received_requests().await.unwrap().len(), 1);
}
#[tokio::test]
async fn disabled_deleted_and_stateful_requests_cannot_escape_the_pool() {
    let mut f = fixture().await;
    let mut body = request();
    body["previous_response_id"] = json!("private-a-response");
    assert_eq!(
        f.router
            .responses(HeaderMap::new(), body, false)
            .await
            .status(),
        StatusCode::BAD_REQUEST
    );
    f.config.enabled = false;
    f.config.save(&f.router.paths).unwrap();
    assert_eq!(send(&f).await.0, StatusCode::NOT_FOUND);
    assert!(f.server.received_requests().await.unwrap().is_empty());
    f.config.enabled = true;
    f.config.account_order = vec!["f".repeat(64)];
    assert!(f.config.save(&f.router.paths).is_err());
}
#[tokio::test]
async fn exhausted_accounts_are_bounded_and_report_machine_readable_error() {
    let f = fixture().await;
    for id in ["a", "b"] {
        mount(
            &f,
            id,
            429,
            json!({"error":{"code":"usage_limit_reached"}}).to_string(),
        )
        .await;
    }
    let (status, text) = send(&f).await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
    assert!(text.contains("subscription_exhausted"));
    assert_eq!(f.server.received_requests().await.unwrap().len(), 2);
}
#[test]
fn sse_handles_split_utf8_crlf_and_terminal_events() {
    let stream = event(json!({"type":"response.output_text.delta","delta":"你好"}))
        .replace('\n', "\r\n")
        + &event(json!({"type":"response.completed"}));
    let mut guard = SseGuard::default();
    for byte in stream.as_bytes() {
        guard.push(&[*byte]);
    }
    assert!(guard.committed);
    assert!(guard.terminal);
    assert!(guard.failure.is_none());
}
#[tokio::test]
async fn concurrent_expired_credentials_refresh_once_and_preserve_identity() {
    let f = fixture().await;
    let vault = AccountVault::new(f.router.paths.clone());
    let record = vault.import_auth(&auth("a", true)).unwrap();
    Mock::given(method("POST")).and(path("/oauth/token")).respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "access_token":jwt(json!({"sub":"a","exp":unix_now()+3600,"client_id":"native-client"})),"refresh_token":"new-refresh-a"
        }))).expect(1).mount(&f.server).await;
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let (a, b) = tokio::join!(
        vault.credential(&record.record_id, &client, &f.router.refresh_url, None),
        vault.credential(&record.record_id, &client, &f.router.refresh_url, None)
    );
    assert_eq!(a.unwrap().access_token, b.unwrap().access_token);
    let saved: Value = serde_json::from_slice(
        &std::fs::read(
            f.router
                .paths
                .accounts_dir()
                .join(format!("{}.json", record.record_id)),
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(saved["tokens"]["refresh_token"], "new-refresh-a");
    assert!(!f.router.paths.live_auth().exists());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(
                f.router
                    .paths
                    .accounts_dir()
                    .join(format!("{}.json", record.record_id))
            )
            .unwrap()
            .permissions()
            .mode()
                & 0o777,
            0o600
        );
    }
}
#[tokio::test]
async fn current_live_session_is_never_refreshed_or_written() {
    let f = fixture().await;
    let raw = auth("a", true);
    atomic_write(&f.router.paths.live_auth(), &raw).unwrap();
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    assert!(
        AccountVault::new(f.router.paths.clone())
            .credential(&f.ids[0], &client, &f.router.refresh_url, None)
            .await
            .is_err()
    );
    assert!(f.server.received_requests().await.unwrap().is_empty());
    assert_eq!(std::fs::read(f.router.paths.live_auth()).unwrap(), raw);
}
#[tokio::test]
async fn rejects_legacy_compact_and_exposes_native_pool_catalog_through_broker() {
    let f = fixture().await;
    let r = f.router.responses(HeaderMap::new(), request(), true).await;
    assert_eq!(r.status(), StatusCode::BAD_REQUEST);
    assert!(f.server.received_requests().await.unwrap().is_empty());
    let mut broker = crate::broker::start(
        0,
        crate::integrations::ApiIntegrations::with_subscription(
            f.router.paths.clone(),
            f.router.clone(),
        ),
    )
    .await
    .unwrap();
    let url = format!("http://127.0.0.1:{}/v1/models", broker.port());
    let response = reqwest::Client::new()
        .get(url)
        .bearer_auth(crate::config::BROKER_TOKEN)
        .send()
        .await
        .unwrap();
    let catalog: Value = response.json().await.unwrap();
    assert_eq!(catalog["data"][0]["id"], route_id("gpt-test"));
    assert_eq!(catalog["data"][0]["owned_by"], "chatgpt-subscription");
    broker.shutdown().await;
}

#[tokio::test]
async fn previous_model_compaction_is_routed_only_on_the_subscription_endpoint() {
    let mut f = fixture().await;
    mount(&f, "a", 200, success()).await;
    let mut broker = crate::broker::start(
        0,
        crate::integrations::ApiIntegrations::with_subscription(
            f.router.paths.clone(),
            f.router.clone(),
        ),
    )
    .await
    .unwrap();
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let base = format!("http://127.0.0.1:{}", broker.port());
    let body = json!({"model":"gpt-test","stream":true,"input":[
        {"role":"user","content":"history"},{"type":"compaction_trigger"}
    ]});
    let compact = client
        .post(format!("{base}/subscription/v1/responses"))
        .bearer_auth(crate::config::BROKER_TOKEN)
        .json(&body)
        .send()
        .await
        .unwrap();
    assert_eq!(compact.status(), StatusCode::OK);
    assert!(compact.text().await.unwrap().contains("response.completed"));
    let requests = f.server.received_requests().await.unwrap();
    let sent: Value = serde_json::from_slice(&requests[0].body).unwrap();
    assert_eq!(sent["model"], "gpt-test");
    assert_eq!(sent["input"], body["input"]);
    assert_eq!(requests.len(), 1);

    // No alias guessing on the ordinary API endpoint, and no cross-provider route.
    for (endpoint, model) in [
        ("/v1/responses", "gpt-test"),
        ("/subscription/v1/responses", "cp-external"),
        ("/subscription/v1/responses", "gpt-unknown"),
    ] {
        let r = client
            .post(format!("{base}{endpoint}"))
            .bearer_auth(crate::config::BROKER_TOKEN)
            .json(&json!({"model":model,"stream":true,"input":body["input"]}))
            .send()
            .await
            .unwrap();
        assert_eq!(r.status(), StatusCode::NOT_FOUND, "{endpoint} {model}");
    }
    f.config.models[0].visible = false;
    f.config.enabled = false;
    f.config.save(&f.router.paths).unwrap();
    let r = client
        .post(format!("{base}/subscription/v1/responses"))
        .bearer_auth(crate::config::BROKER_TOKEN)
        .json(&body)
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), StatusCode::NOT_FOUND);
    assert_eq!(f.server.received_requests().await.unwrap().len(), 1);
    broker.shutdown().await;
}

#[tokio::test]
async fn native_inherited_history_compaction_and_pool_turn() {
    let Some(binary) = std::env::var_os("CODEX_PLUS_NATIVE_BIN") else {
        return;
    };
    let f = fixture().await;
    Mock::given(method("POST")).and(path("/responses"))
        .respond_with(|request: &wiremock::Request| {
            let body: Value=serde_json::from_slice(&request.body).unwrap();
            let compact=body["input"].as_array().unwrap().iter().any(|i|i["type"]=="compaction_trigger");
            let item=if compact { json!({"type":"compaction","encrypted_content":"offline-fixture"}) }
                else { json!({"type":"message","id":"pool-message","role":"assistant","content":[{"type":"output_text","text":"READY"}]}) };
            let stream=event(json!({"type":"response.created","response":{"id":"pool"}}))
                + &event(json!({"type":"response.output_item.done","output_index":0,"item":item}))
                + &event(json!({"type":"response.completed","response":{"id":"pool","status":"completed","output":[item],"usage":{"input_tokens":30,"output_tokens":1,"total_tokens":31}}}));
            ResponseTemplate::new(200).set_body_string(stream)
        }).mount(&f.server).await;
    let mut broker = crate::broker::start(
        0,
        crate::integrations::ApiIntegrations::with_subscription(
            f.router.paths.clone(),
            f.router.clone(),
        ),
    )
    .await
    .unwrap();
    let output = tokio::process::Command::new("node")
        .arg(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("scripts/verify-native-pool-compaction.mjs"),
        )
        .arg(binary)
        .arg(format!(
            "http://127.0.0.1:{}/subscription/v1",
            broker.port()
        ))
        .output()
        .await
        .unwrap();
    broker.shutdown().await;
    assert!(
        output.status.success(),
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let requests = f.server.received_requests().await.unwrap();
    assert_eq!(requests.len(), 2);
    let compact: Value = serde_json::from_slice(&requests[0].body).unwrap();
    let turn: Value = serde_json::from_slice(&requests[1].body).unwrap();
    assert_eq!(compact["model"], "gpt-test");
    assert!(
        compact["input"]
            .as_array()
            .unwrap()
            .iter()
            .any(|i| i["type"] == "compaction_trigger")
    );
    assert!(
        turn["input"]
            .as_array()
            .unwrap()
            .iter()
            .any(|i| i["type"] == "compaction")
    );
}

#[tokio::test]
async fn second_401_skips_account_and_persists_rejection_across_models_and_config_saves() {
    let f = fixture().await;
    mount(
        &f,
        "a",
        401,
        json!({"error":{"code":"invalid_token"}}).to_string(),
    )
    .await;
    mount(&f, "b", 200, success()).await;
    Mock::given(method("POST")).and(path("/oauth/token")).respond_with(ResponseTemplate::new(200).set_body_json(json!({
        "access_token":jwt(json!({"sub":"a","exp":unix_now()+3600,"client_id":"native-client","generation":2})),"refresh_token":"rotated-a"
    }))).expect(1).mount(&f.server).await;
    assert_eq!(send(&f).await.0, StatusCode::OK);
    assert!(f.router.is_rejected_current(&f.ids[0]));
    f.router.save(f.config.clone()).unwrap();
    assert_eq!(send(&f).await.0, StatusCode::OK);
    let new_router = SubscriptionApi::new(f.router.paths.clone());
    assert!(new_router.is_rejected_current(&f.ids[0]));
    let requests = f.server.received_requests().await.unwrap();
    assert_eq!(
        requests
            .iter()
            .filter(|r| r.url.path() == "/responses"
                && r.headers
                    .get("ChatGPT-Account-Id")
                    .is_some_and(|v| v == "a"))
            .count(),
        2
    );
    let vault = AccountVault::new(f.router.paths.clone());
    vault.import_auth(&auth("a", false)).unwrap();
    assert!(!f.router.is_rejected_current(&f.ids[0]));
}

#[tokio::test]
async fn terminal_refresh_failure_is_account_wide_and_does_not_repeat() {
    let f = fixture().await;
    AccountVault::new(f.router.paths.clone())
        .import_auth(&auth("a", true))
        .unwrap();
    Mock::given(method("POST"))
        .and(path("/oauth/token"))
        .respond_with(ResponseTemplate::new(400).set_body_json(json!({"error":"invalid_grant"})))
        .expect(1)
        .mount(&f.server)
        .await;
    mount(&f, "b", 200, success()).await;
    assert_eq!(send(&f).await.0, StatusCode::OK);
    assert_eq!(send(&f).await.0, StatusCode::OK);
    assert!(f.router.is_rejected_current(&f.ids[0]));
    Mock::given(method("GET"))
        .and(path("/models"))
        .and(header("ChatGPT-Account-Id", "b"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(json!({"models":[{"slug":"gpt-test"}]})),
        )
        .expect(2)
        .mount(&f.server)
        .await;
    f.router.discover(f.config.clone()).await.unwrap();
    f.router.discover(f.config.clone()).await.unwrap();
    assert_eq!(
        f.server
            .received_requests()
            .await
            .unwrap()
            .iter()
            .filter(|r| r.url.path() == "/models"
                && r.headers
                    .get("ChatGPT-Account-Id")
                    .is_some_and(|v| v == "a"))
            .count(),
        0
    );
}

#[tokio::test]
async fn discovery_renews_once_after_401_and_preserves_model_settings() {
    let mut f = fixture().await;
    let token =
        jwt(json!({"sub":"a","exp":unix_now()+3600,"client_id":"native-client","generation":2}));
    Mock::given(method("GET"))
        .and(path("/models"))
        .respond_with(ResponseTemplate::new(401))
        .mount(&f.server)
        .await;
    Mock::given(method("GET"))
        .and(path("/models"))
        .and(header("Authorization", format!("Bearer {token}")))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(json!({"models":[{"slug":"gpt-test"}]})),
        )
        .with_priority(1)
        .expect(1)
        .mount(&f.server)
        .await;
    Mock::given(method("POST"))
        .and(path("/oauth/token"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_json(json!({"access_token":token,"refresh_token":"new-a"})),
        )
        .expect(1)
        .mount(&f.server)
        .await;
    f.config.models[0].display_name = "My alias".into();
    f.config.models[0].visible = false;
    let view = f.router.discover(f.config).await.unwrap();
    assert_eq!(view["models"][0]["displayName"], "My alias");
    assert_eq!(view["models"][0]["visible"], false);
    assert_eq!(f.server.received_requests().await.unwrap().len(), 3);
}

#[tokio::test]
async fn rejected_old_generation_cannot_block_a_concurrent_new_import() {
    let f = fixture().await;
    let vault = AccountVault::new(f.router.paths.clone());
    vault.import_auth(&auth("a", true)).unwrap();
    Mock::given(method("POST"))
        .and(path("/oauth/token"))
        .respond_with(ResponseTemplate::new(400).set_body_json(json!({"error":"invalid_grant"})))
        .expect(1)
        .mount(&f.server)
        .await;
    let result = vault
        .credential(
            &f.ids[0],
            &reqwest::Client::new(),
            &f.router.refresh_url,
            None,
        )
        .await;
    let error = result.err().expect("old refresh rejected");
    vault.import_auth(&auth("a", false)).unwrap();
    f.router.credential_failed(&f.ids[0], &error);
    assert!(!f.router.is_rejected_current(&f.ids[0]));
}

#[tokio::test]
async fn concurrent_401s_reuse_new_generation_instead_of_refreshing_twice() {
    let f = fixture().await;
    let vault = AccountVault::new(f.router.paths.clone());
    let current = vault
        .credential(
            &f.ids[0],
            &reqwest::Client::new(),
            &f.router.refresh_url,
            None,
        )
        .await
        .unwrap();
    Mock::given(method("POST")).and(path("/oauth/token")).respond_with(ResponseTemplate::new(200).set_body_json(json!({
        "access_token":jwt(json!({"sub":"a","exp":unix_now()+3600,"client_id":"native-client","generation":2})),"refresh_token":"new-a"
    })).set_delay(Duration::from_millis(50))).expect(1).mount(&f.server).await;
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let (a, b) = tokio::join!(
        vault.credential(
            &f.ids[0],
            &client,
            &f.router.refresh_url,
            Some(&current.access_token)
        ),
        vault.credential(
            &f.ids[0],
            &client,
            &f.router.refresh_url,
            Some(&current.access_token)
        )
    );
    assert_eq!(a.unwrap().revision, b.unwrap().revision);
}

#[tokio::test]
async fn manual_switch_waits_for_rotating_refresh_and_uses_renewed_credentials() {
    let f = fixture().await;
    let vault = AccountVault::new(f.router.paths.clone());
    vault.import_auth(&auth("a", true)).unwrap();
    Mock::given(method("POST")).and(path("/oauth/token")).respond_with(ResponseTemplate::new(200).set_body_json(json!({
        "access_token":jwt(json!({"sub":"a","exp":unix_now()+3600,"client_id":"native-client"})),"refresh_token":"new-a"
    })).set_delay(Duration::from_millis(150))).expect(1).mount(&f.server).await;
    let paths = f.router.paths.clone();
    let id = f.ids[0].clone();
    let url = f.router.refresh_url.clone();
    let refresh = tokio::spawn(async move {
        AccountVault::new(paths)
            .credential(&id, &reqwest::Client::new(), &url, None)
            .await
    });
    for _ in 0..100 {
        if !f.server.received_requests().await.unwrap().is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    let paths = f.router.paths.clone();
    let id = f.ids[0].clone();
    let switch =
        tokio::task::spawn_blocking(move || AccountVault::new(paths).switch_after_shutdown(&id));
    refresh.await.unwrap().unwrap();
    switch.await.unwrap().unwrap();
    let live: Value =
        serde_json::from_slice(&std::fs::read(f.router.paths.live_auth()).unwrap()).unwrap();
    assert_eq!(live["tokens"]["refresh_token"], "new-a");
}
