use super::*;
use wiremock::matchers::{body_partial_json, header, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

struct Fixture {
    _temp: tempfile::TempDir,
    api: SubscriptionApi,
    config: SubscriptionConfig,
    ids: Vec<String>,
    server: MockServer,
}

fn usage() -> Usage {
    serde_json::from_value(json!({"rate_limit": {
        "primary_window": {"used_percent":0,"limit_window_seconds":FIVE_HOURS,"reset_at":unix_now()+FIVE_HOURS},
        "secondary_window": {"used_percent":50,"limit_window_seconds":WEEK,"reset_at":unix_now()+WEEK}
    }})).unwrap()
}

async fn fixture() -> Fixture {
    let temp = tempfile::tempdir().unwrap();
    let server = MockServer::start().await;
    let paths = AccountPaths {
        codex_home: temp.path().join("home"),
        state_dir: temp.path().join("state"),
        usage_endpoint: format!("{}/usage", server.uri()),
    };
    let vault = AccountVault::new(paths.clone());
    let ids = ["a", "b", "c"]
        .map(|id| {
            let jwt = |value: Value| {
                format!(
                    "header.{}.signature",
                    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(value.to_string())
                )
            };
            vault
                .import_auth(
                    &serde_json::to_vec(&json!({"auth_mode":"chatgpt","tokens":{
                        "id_token":jwt(json!({"sub":id,"email":format!("{id}@example.test")})),
                        "access_token":jwt(json!({"sub":id,"exp":unix_now()+3600})),
                        "refresh_token":format!("refresh-{id}"),"account_id":id
                    }}))
                    .unwrap(),
                )
                .unwrap()
                .record_id
        })
        .to_vec();
    vault.switch_after_shutdown(&ids[0]).unwrap();
    let config = SubscriptionConfig {
        enabled: true,
        auto_activate: true,
        account_order: ids[..2].to_vec(),
        models: vec![crate::providers::SaveModel {
            model_id: "gpt-test".into(),
            display_name: String::new(),
            visible: true,
        }],
        ..SubscriptionConfig::default()
    };
    config.save(&paths).unwrap();
    let mut api = SubscriptionApi::new(paths);
    api.native_base = server.uri();
    Fixture {
        _temp: temp,
        api,
        config,
        ids,
        server,
    }
}

async fn mount_usage(fixture: &Fixture, value: Usage) {
    Mock::given(method("GET"))
        .and(path("/usage"))
        .respond_with(ResponseTemplate::new(200).set_body_json(value))
        .mount(&fixture.server)
        .await;
}

async fn mount_response(fixture: &Fixture, status: u16) {
    Mock::given(method("POST"))
        .and(path("/responses"))
        .and(header("chatgpt-account-id", "b"))
        .and(body_partial_json(
            json!({"model":"gpt-test","store":false,"stream":true,"tools":[]}),
        ))
        .respond_with(ResponseTemplate::new(status).set_body_string(
            "data: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\"}}\n\n",
        ))
        .mount(&fixture.server)
        .await;
}

async fn posts(fixture: &Fixture) -> usize {
    fixture
        .server
        .received_requests()
        .await
        .unwrap()
        .iter()
        .filter(|request| request.method == "POST")
        .count()
}

#[test]
fn eligibility_requires_exact_fresh_five_hour_and_week_windows() {
    assert!(eligible(&usage(), None, unix_now()));
    let mut reversed = usage();
    let rate = reversed.rate_limit.as_mut().unwrap();
    std::mem::swap(&mut rate.primary_window, &mut rate.secondary_window);
    assert!(eligible(&reversed, None, unix_now()));
    for (field, value) in [
        ("used_percent", json!(0.1)),
        ("used_percent", json!(-1)),
        ("used_percent", Value::Null),
        ("limit_window_seconds", json!(3600)),
        ("reset_at", json!(unix_now() - 1)),
        ("reset_at", Value::Null),
    ] {
        let mut invalid = serde_json::to_value(usage()).unwrap();
        invalid["rate_limit"]["primary_window"][field] = value;
        assert!(
            !eligible(&serde_json::from_value(invalid).unwrap(), None, unix_now()),
            "{field}"
        );
    }
    for (field, value) in [
        ("used_percent", json!(100)),
        ("used_percent", json!(101)),
        ("used_percent", json!(-1)),
        ("used_percent", Value::Null),
        ("limit_window_seconds", json!(86400)),
        ("reset_at", json!(unix_now() - 1)),
    ] {
        let mut invalid = serde_json::to_value(usage()).unwrap();
        invalid["rate_limit"]["secondary_window"][field] = value;
        assert!(
            !eligible(&serde_json::from_value(invalid).unwrap(), None, unix_now()),
            "{field}"
        );
    }
    let mut blocked = usage();
    blocked.rate_limit.as_mut().unwrap().allowed = Some(false);
    assert!(!eligible(&blocked, None, unix_now()));
    blocked.rate_limit.as_mut().unwrap().allowed = None;
    blocked.rate_limit.as_mut().unwrap().limit_reached = Some(true);
    assert!(!eligible(&blocked, None, unix_now()));
    assert!(!eligible(
        &Usage {
            rate_limit: None,
            ..usage()
        },
        None,
        unix_now()
    ));
    assert!(!eligible(
        &usage(),
        Some(&config::AccountReserve {
            short_term_percent: None,
            long_term_percent: Some(50)
        }),
        unix_now()
    ));
}

#[tokio::test]
async fn activation_is_opt_in_and_requires_enabled_pool() {
    let mut fixture = fixture().await;
    fixture.config.auto_activate = false;
    fixture.config.save(&fixture.api.paths).unwrap();
    fixture.api.activate_idle_accounts().await.unwrap();
    fixture.config.auto_activate = true;
    fixture.config.enabled = false;
    fixture.config.save(&fixture.api.paths).unwrap();
    fixture.api.activate_idle_accounts().await.unwrap();
    assert!(fixture.server.received_requests().await.unwrap().is_empty());
    assert!(
        !serde_json::from_value::<SubscriptionConfig>(json!({}))
            .unwrap()
            .auto_activate
    );
}

#[tokio::test]
async fn activation_only_targets_selected_idle_accounts_and_survives_restart() {
    let fixture = fixture().await;
    mount_usage(&fixture, usage()).await;
    mount_response(&fixture, 200).await;
    fixture.api.activate_idle_accounts().await.unwrap();
    assert_eq!(posts(&fixture).await, 1);
    let mut restarted = SubscriptionApi::new(fixture.api.paths.clone());
    restarted.native_base = fixture.server.uri();
    restarted.activate_idle_accounts().await.unwrap();
    assert_eq!(posts(&fixture).await, 1);
    assert_eq!(
        fixture
            .server
            .received_requests()
            .await
            .unwrap()
            .iter()
            .filter(|request| request.method == "GET")
            .count(),
        1
    );
}

#[tokio::test]
async fn failed_requests_are_not_replayed_even_if_quota_stays_at_zero_used() {
    let fixture = fixture().await;
    mount_usage(&fixture, usage()).await;
    mount_response(&fixture, 500).await;
    fixture.api.activate_idle_accounts().await.unwrap();
    fixture.api.activate_idle_accounts().await.unwrap();
    assert_eq!(posts(&fixture).await, 1);
}

#[tokio::test]
async fn used_exhausted_unknown_reserved_and_cooled_accounts_are_skipped() {
    for invalid in [
        json!({"rate_limit":{"primary_window":{"used_percent":1,"limit_window_seconds":FIVE_HOURS,"reset_at":unix_now()+FIVE_HOURS}}}),
        json!({"rate_limit":null}),
    ] {
        let fixture = fixture().await;
        mount_usage(&fixture, serde_json::from_value(invalid).unwrap()).await;
        fixture.api.activate_idle_accounts().await.unwrap();
        assert_eq!(posts(&fixture).await, 0);
    }
    let mut fixture = fixture().await;
    mount_usage(&fixture, usage()).await;
    fixture.config.account_reserves.insert(
        fixture.ids[1].clone(),
        config::AccountReserve {
            short_term_percent: Some(100),
            long_term_percent: None,
        },
    );
    fixture.config.save(&fixture.api.paths).unwrap();
    fixture.api.activate_idle_accounts().await.unwrap();
    assert_eq!(posts(&fixture).await, 0);
    fixture.config.account_reserves.clear();
    fixture.config.save(&fixture.api.paths).unwrap();
    fixture.api.cool(
        &fixture.ids[1],
        "gpt-test",
        "请求频率限制",
        unix_now() + 300,
    );
    fixture.api.activate_idle_accounts().await.unwrap();
    assert_eq!(posts(&fixture).await, 0);
}

#[tokio::test]
async fn recent_and_inflight_pool_accounts_are_not_activated() {
    let mut fixture = fixture().await;
    fixture.config.account_order.push(fixture.ids[2].clone());
    fixture.config.save(&fixture.api.paths).unwrap();
    let busy = fixture.api.begin_foreground(&fixture.ids[1]);
    let recent = fixture.api.begin_foreground(&fixture.ids[2]);
    drop(recent);
    fixture.api.activate_idle_accounts().await.unwrap();
    assert!(fixture.server.received_requests().await.unwrap().is_empty());
    drop(busy);
    assert!(fixture.api.activation_idle(&fixture.ids[1]).unwrap());
    assert!(!fixture.api.activation_idle(&fixture.ids[2]).unwrap());
}

#[tokio::test]
async fn corrupt_ledger_fails_closed_and_cross_process_lock_skips_checks() {
    let fixture = fixture().await;
    let ledger = fixture
        .api
        .paths
        .state_dir
        .join("subscription-activation.json");
    std::fs::write(&ledger, "invalid").unwrap();
    assert!(fixture.api.activate_idle_accounts().await.is_err());
    std::fs::write(&ledger, "{}").unwrap();
    let lock = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(
            fixture
                .api
                .paths
                .state_dir
                .join("subscription-activation.lock"),
        )
        .unwrap();
    lock.lock_exclusive().unwrap();
    fixture.api.activate_idle_accounts().await.unwrap();
    assert!(fixture.server.received_requests().await.unwrap().is_empty());
}

#[tokio::test]
async fn changed_selection_during_quota_query_prevents_post() {
    let fixture = fixture().await;
    let started = Arc::new(tokio::sync::Notify::new());
    let signal = started.clone();
    Mock::given(method("GET"))
        .and(path("/usage"))
        .respond_with(move |_: &wiremock::Request| {
            signal.notify_one();
            ResponseTemplate::new(200)
                .set_body_json(usage())
                .set_delay(Duration::from_millis(200))
        })
        .mount(&fixture.server)
        .await;
    let api = fixture.api.clone();
    let worker = tokio::spawn(async move { api.activate_idle_accounts().await });
    tokio::time::timeout(Duration::from_secs(5), started.notified())
        .await
        .unwrap();
    fixture
        .api
        .save(SubscriptionConfig {
            auto_activate: false,
            ..fixture.config.clone()
        })
        .unwrap();
    worker.await.unwrap().unwrap();
    assert_eq!(posts(&fixture).await, 0);
}

#[tokio::test]
async fn expired_attempt_ledger_allows_one_new_attempt_without_changing_live_auth() {
    let fixture = fixture().await;
    mount_usage(&fixture, usage()).await;
    mount_response(&fixture, 200).await;
    let auth_before = std::fs::read(fixture.api.paths.live_auth()).unwrap();
    std::fs::write(
        fixture
            .api
            .paths
            .state_dir
            .join("subscription-activation.json"),
        serde_json::to_vec(&HashMap::from([(fixture.ids[1].clone(), unix_now() - 1)])).unwrap(),
    )
    .unwrap();
    fixture.api.activate_idle_accounts().await.unwrap();
    fixture.api.activate_idle_accounts().await.unwrap();
    assert_eq!(posts(&fixture).await, 1);
    assert_eq!(
        std::fs::read(fixture.api.paths.live_auth()).unwrap(),
        auth_before
    );
    let requests = fixture.server.received_requests().await.unwrap();
    let request = requests
        .iter()
        .find(|request| request.method == "POST")
        .unwrap();
    let body: Value = serde_json::from_slice(&request.body).unwrap();
    assert_eq!(
        body["input"],
        json!([{"role":"user","content":"Reply only with OK."}])
    );
    for key in ["previous_response_id", "conversation", "thread_id"] {
        assert!(body.get(key).is_none());
    }
}

#[tokio::test]
async fn foreground_request_interrupts_pending_background_generation() {
    let fixture = fixture().await;
    mount_usage(&fixture, usage()).await;
    let started = Arc::new(tokio::sync::Notify::new());
    let signal = started.clone();
    Mock::given(method("POST"))
        .and(path("/responses"))
        .respond_with(move |_: &wiremock::Request| {
            signal.notify_one();
            ResponseTemplate::new(200).set_delay(Duration::from_secs(5))
        })
        .mount(&fixture.server)
        .await;
    let api = fixture.api.clone();
    let worker = tokio::spawn(async move { api.activate_idle_accounts().await });
    tokio::time::timeout(Duration::from_secs(5), started.notified())
        .await
        .unwrap();
    let foreground = fixture.api.begin_foreground(&fixture.ids[1]);
    tokio::time::timeout(Duration::from_secs(1), worker)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    drop(foreground);
    let log = std::fs::read_to_string(fixture.api.paths.log_path()).unwrap();
    assert!(log.contains("interrupted"));
}
