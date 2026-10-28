use super::*;
use crate::subscription::route_id;
use wiremock::matchers::{header, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

fn usage(short: f64, long: f64) -> Usage {
    serde_json::from_value(json!({"rate_limit": {
        "primary_window":{"used_percent":short,"limit_window_seconds":18000,"reset_at":unix_now()+3600},
        "secondary_window":{"used_percent":long,"limit_window_seconds":604800,"reset_at":unix_now()+86400}
    }})).unwrap()
}

struct Fixture {
    _temp: tempfile::TempDir,
    router: SubscriptionApi,
    config: SubscriptionConfig,
    ids: Vec<String>,
    server: MockServer,
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
    let mut ids = Vec::new();
    for id in ["a", "b"] {
        let jwt = |value: Value| {
            format!(
                "header.{}.signature",
                base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(value.to_string())
            )
        };
        ids.push(
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
                .record_id,
        );
    }
    let config = SubscriptionConfig {
        enabled: true,
        account_order: ids.clone(),
        models: vec![crate::providers::SaveModel {
            model_id: "gpt-test".into(),
            display_name: String::new(),
            visible: true,
        }],
        proxy_url: String::new(),
        account_reserves: HashMap::from([(
            ids[0].clone(),
            AccountReserve {
                short_term_percent: Some(21),
                long_term_percent: Some(30),
            },
        )]),
    };
    config.save(&paths).unwrap();
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

async fn mount_usage(f: &Fixture, status: u16, value: Value) {
    Mock::given(method("GET"))
        .and(path("/usage"))
        .and(header("chatgpt-account-id", "a"))
        .respond_with(ResponseTemplate::new(status).set_body_json(value))
        .mount(&f.server)
        .await;
}

fn success() -> String {
    "data: {\"type\":\"response.output_text.delta\",\"delta\":\"OK\"}\n\ndata: {\"type\":\"response.completed\"}\n\n".into()
}

async fn mount_response(f: &Fixture, id: &str, body: String) {
    Mock::given(method("POST"))
        .and(path("/responses"))
        .and(header("chatgpt-account-id", id))
        .respond_with(ResponseTemplate::new(200).set_body_string(body))
        .mount(&f.server)
        .await;
}

async fn send(f: &Fixture) -> (StatusCode, String, String) {
    let response = f
        .router
        .responses(
            HeaderMap::new(),
            json!({"model":route_id("gpt-test"),"stream":true,"input":[]}),
            false,
        )
        .await;
    let status = response.status();
    let id = response
        .headers()
        .get("x-codex-plus-account-record")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_owned();
    let body = axum::body::to_bytes(response.into_body(), 1024 * 1024)
        .await
        .unwrap();
    (status, id, String::from_utf8(body.to_vec()).unwrap())
}

#[test]
fn thresholds_use_remaining_percent_and_actual_window_duration() {
    let reserve = AccountReserve {
        short_term_percent: Some(21),
        long_term_percent: Some(30),
    };
    assert_eq!(evaluate(&usage(78.9, 69.9), &reserve), ReserveStatus::Ready);
    assert!(matches!(
        evaluate(&usage(79.0, 0.0), &reserve),
        ReserveStatus::Reserved(_)
    ));
    assert!(matches!(
        evaluate(&usage(0.0, 70.0), &reserve),
        ReserveStatus::Reserved(_)
    ));
    let mut weekly_primary = usage(0.0, 70.0);
    let rate = weekly_primary.rate_limit.as_mut().unwrap();
    rate.primary_window = rate.secondary_window.take();
    assert!(matches!(
        evaluate(&weekly_primary, &reserve),
        ReserveStatus::Reserved(_)
    ));
    let zero = AccountReserve {
        short_term_percent: Some(0),
        long_term_percent: None,
    };
    assert_eq!(evaluate(&usage(99.9, 100.0), &zero), ReserveStatus::Ready);
    assert!(matches!(
        evaluate(&usage(100.0, 0.0), &zero),
        ReserveStatus::Reserved(_)
    ));
    for value in [
        json!({}),
        json!({"rate_limit":{"primary_window":{"used_percent":5}}}),
        json!({"rate_limit":{"primary_window":{"used_percent":null,"limit_window_seconds":18000}}}),
    ] {
        assert_eq!(
            evaluate(&serde_json::from_value(value).unwrap(), &reserve),
            ReserveStatus::Unknown
        );
    }
}

#[tokio::test]
async fn config_is_backward_compatible_and_validates_each_account() {
    let mut f = fixture().await;
    let old: SubscriptionConfig = serde_json::from_value(
        json!({"enabled":false,"accountOrder":[],"models":[],"proxyUrl":""}),
    )
    .unwrap();
    assert!(old.account_reserves.is_empty());
    assert_eq!(SubscriptionConfig::load(&f.router.paths).unwrap(), f.config);
    f.config
        .account_reserves
        .get_mut(&f.ids[0])
        .unwrap()
        .short_term_percent = Some(101);
    assert!(f.config.save(&f.router.paths).is_err());
    for value in [json!(-1), json!(20.5), json!(256)] {
        assert!(
            serde_json::from_value::<AccountReserve>(json!({"shortTermPercent":value})).is_err()
        );
    }
    f.config.account_reserves = HashMap::from([("deleted".into(), AccountReserve::default())]);
    assert!(f.config.save(&f.router.paths).is_err());
}

#[tokio::test]
async fn reserve_boundary_skips_account_and_cached_check_does_not_query_other_accounts() {
    let f = fixture().await;
    mount_usage(&f, 200, serde_json::to_value(usage(79.0, 0.0)).unwrap()).await;
    mount_response(&f, "b", success()).await;
    for _ in 0..2 {
        let response = send(&f).await;
        assert_eq!(response.0, StatusCode::OK);
        assert_eq!(response.1, f.ids[1]);
    }
    let requests = f.server.received_requests().await.unwrap();
    assert_eq!(requests.iter().filter(|r| r.method == "GET").count(), 1);
    assert_eq!(requests.iter().filter(|r| r.method == "POST").count(), 2);
    assert_eq!(
        f.router.view().unwrap()["quotaStates"][0]["status"],
        "reserved"
    );
    let live = f.router.paths.live_auth();
    assert!(
        !live.exists(),
        "reserve checks must not switch the live login"
    );
}

#[tokio::test]
async fn all_reserved_and_unknown_have_distinct_errors_without_upstream_text() {
    for (status, body, expected) in [
        (
            200,
            serde_json::to_value(usage(0.0, 70.0)).unwrap(),
            "subscription_reserve_reached",
        ),
        (
            403,
            json!({"secret":"sensitive upstream body"}),
            "subscription_quota_unknown",
        ),
        (200, json!({}), "subscription_quota_unknown"),
    ] {
        let mut f = fixture().await;
        f.config.account_order.truncate(1);
        f.config.save(&f.router.paths).unwrap();
        mount_usage(&f, status, body).await;
        let response = send(&f).await;
        assert!(response.2.contains(expected));
        assert!(!response.2.contains("sensitive"));
        assert!(
            f.server
                .received_requests()
                .await
                .unwrap()
                .iter()
                .all(|r| r.method == "GET")
        );
    }
}

#[tokio::test]
async fn unknown_quota_skips_account_and_coalesces_concurrent_queries() {
    let f = fixture().await;
    mount_usage(&f, 403, json!({})).await;
    mount_response(&f, "b", success()).await;
    let (a, b) = tokio::join!(send(&f), send(&f));
    assert_eq!(a.1, f.ids[1]);
    assert_eq!(b.1, f.ids[1]);
    assert_eq!(
        f.server
            .received_requests()
            .await
            .unwrap()
            .iter()
            .filter(|r| r.method == "GET")
            .count(),
        1
    );
}

#[tokio::test]
async fn reset_requeries_and_saved_threshold_changes_take_effect_without_cooldown() {
    let mut f = fixture().await;
    let mut expired = usage(90.0, 0.0);
    expired
        .rate_limit
        .as_mut()
        .unwrap()
        .primary_window
        .as_mut()
        .unwrap()
        .reset_at = Some(unix_now() as i64 - 1);
    f.router.quota.record(&f.ids[0], Some(expired));
    mount_usage(&f, 200, serde_json::to_value(usage(0.0, 0.0)).unwrap()).await;
    mount_response(&f, "a", success()).await;
    assert_eq!(send(&f).await.1, f.ids[0]);
    f.config
        .account_reserves
        .get_mut(&f.ids[0])
        .unwrap()
        .short_term_percent = Some(100);
    f.router.save(f.config.clone()).unwrap();
    mount_response(&f, "b", success()).await;
    assert_eq!(send(&f).await.1, f.ids[1]);
    f.config.account_reserves.clear();
    f.router.save(f.config.clone()).unwrap();
    assert_eq!(send(&f).await.1, f.ids[0]);
}

#[tokio::test]
async fn disabled_or_unselected_reserves_never_query_or_consume_unselected_accounts() {
    let mut f = fixture().await;
    f.config.account_order = vec![f.ids[1].clone()];
    f.config.save(&f.router.paths).unwrap();
    mount_response(&f, "b", success()).await;
    assert_eq!(send(&f).await.1, f.ids[1]);
    assert_eq!(f.server.received_requests().await.unwrap().len(), 1);
    f.config.enabled = false;
    f.config.save(&f.router.paths).unwrap();
    assert_eq!(send(&f).await.0, StatusCode::NOT_FOUND);
    assert_eq!(f.server.received_requests().await.unwrap().len(), 1);
}

#[tokio::test]
async fn quota_events_stop_future_requests_without_replaying_delivered_output() {
    let f = fixture().await;
    mount_usage(&f, 200, serde_json::to_value(usage(10.0, 10.0)).unwrap()).await;
    let event = json!({"type":"codex.rate_limits","rate_limits":{"primary":{"used_percent":79,"window_minutes":300,"reset_at":unix_now()+3600}}});
    let body = format!(
        "data: {{\"type\":\"response.output_text.delta\",\"delta\":\"FIRST\"}}\n\ndata: {event}\n\ndata: {{\"type\":\"response.completed\"}}\n\n"
    );
    mount_response(&f, "a", body).await;
    mount_response(&f, "b", success()).await;
    let first = send(&f).await;
    assert_eq!(first.1, f.ids[0]);
    assert!(first.2.contains("FIRST"));
    assert!(!first.2.contains("OK"));
    assert_eq!(send(&f).await.1, f.ids[1]);
    assert_eq!(
        f.server
            .received_requests()
            .await
            .unwrap()
            .iter()
            .filter(|r| r.method == "POST")
            .count(),
        2
    );
}

#[test]
fn partial_headers_keep_other_window_and_old_concurrent_updates_do_not_reopen_account() {
    let tracker = QuotaTracker::default();
    let previous = usage(10.0, 80.0);
    let reset = previous
        .rate_limit
        .as_ref()
        .unwrap()
        .primary_window
        .as_ref()
        .unwrap()
        .reset_at
        .unwrap();
    tracker.record("a", Some(previous.clone()));
    let mut headers = HeaderMap::new();
    headers.insert(
        "x-codex-primary-used-percent",
        HeaderValue::from_static("79"),
    );
    headers.insert(
        "x-codex-primary-window-minutes",
        HeaderValue::from_static("300"),
    );
    headers.insert(
        "x-codex-primary-reset-at",
        HeaderValue::from_str(&reset.to_string()).unwrap(),
    );
    tracker.observe_headers("a", &headers);
    let mut late = previous;
    let rate = late.rate_limit.as_mut().unwrap();
    rate.primary_window.as_mut().unwrap().used_percent = Some(0.0);
    rate.primary_window.as_mut().unwrap().reset_at = None;
    rate.secondary_window.as_mut().unwrap().used_percent = Some(0.0);
    tracker.observe_event("a", Some(late));
    let snapshot = tracker.observations.lock().unwrap();
    let observed = snapshot["a"].usage.as_ref().unwrap();
    assert_eq!(
        observed
            .rate_limit
            .as_ref()
            .unwrap()
            .primary_window
            .as_ref()
            .unwrap()
            .used_percent,
        Some(79.0)
    );
    assert_eq!(
        observed
            .rate_limit
            .as_ref()
            .unwrap()
            .secondary_window
            .as_ref()
            .unwrap()
            .used_percent,
        Some(80.0)
    );
    assert!(usage_event(&json!({"type":"codex.rate_limits","metered_limit_name":"other","rate_limits":{"primary":{"used_percent":100}}})).is_none());
}

#[test]
fn near_threshold_cache_expires_sooner_and_invalid_events_do_not_refresh_it() {
    let tracker = QuotaTracker::default();
    let reserve = AccountReserve {
        short_term_percent: Some(21),
        long_term_percent: None,
    };
    tracker.record("near", Some(usage(75.0, 0.0)));
    tracker.record("far", Some(usage(10.0, 0.0)));
    for entry in tracker.observations.lock().unwrap().values_mut() {
        entry.at = Instant::now() - Duration::from_secs(4);
    }
    assert!(tracker.cached("near", &reserve).is_none());
    assert_eq!(tracker.cached("far", &reserve), Some(ReserveStatus::Ready));
    assert!(usage_event(&json!({"type":"codex.rate_limits","rate_limits":{"primary":{"used_percent":null,"window_minutes":300}}})).is_none());
}

#[test]
fn late_usage_query_cannot_overwrite_quota_observed_while_it_was_in_flight() {
    let tracker = QuotaTracker::default();
    let before = usage(10.0, 0.0);
    let mut during = before.clone();
    during
        .rate_limit
        .as_mut()
        .unwrap()
        .primary_window
        .as_mut()
        .unwrap()
        .used_percent = Some(79.0);
    let started = Instant::now() - Duration::from_secs(1);
    tracker.observe_event("a", Some(during));
    let observed = tracker.observe("a", Some(before), Some(started)).unwrap();
    let reserve = AccountReserve {
        short_term_percent: Some(21),
        long_term_percent: None,
    };
    assert!(matches!(
        evaluate(&observed, &reserve),
        ReserveStatus::Reserved(_)
    ));
}

#[tokio::test]
async fn spent_query_budget_skips_unknown_but_can_still_use_fresh_cached_quota() {
    let f = fixture().await;
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let reserve = f.config.account_reserves.get(&f.ids[0]).unwrap();
    let deadline = tokio::time::Instant::now() - Duration::from_secs(1);
    assert_eq!(
        f.router
            .check_reserve(&f.ids[0], reserve, &client, deadline)
            .await,
        ReserveStatus::Unknown
    );
    f.router.quota.record(&f.ids[0], Some(usage(0.0, 0.0)));
    assert_eq!(
        f.router
            .check_reserve(&f.ids[0], reserve, &client, deadline)
            .await,
        ReserveStatus::Ready
    );
    assert!(f.server.received_requests().await.unwrap().is_empty());
}

#[tokio::test]
async fn quota_cooldown_retries_before_the_original_five_hour_reset() {
    let f = fixture().await;
    let now = unix_now();
    f.router
        .cool(&f.ids[0], "gpt-test", "额度限制", now + 18000);
    assert!(f.router.cooling(&f.ids[0], "gpt-test"));
    let retry_at = f.router.view().unwrap()["accountStates"][0]["retryAt"]
        .as_u64()
        .unwrap();
    assert!(
        retry_at <= now + 60,
        "quota retry is still locked until {retry_at}"
    );
    f.router
        .state
        .lock()
        .unwrap()
        .get_mut(&(f.ids[0].clone(), "gpt-test".into()))
        .unwrap()
        .retry_at = now - 1;
    mount_usage(&f, 200, serde_json::to_value(usage(0.0, 0.0)).unwrap()).await;
    mount_response(&f, "a", success()).await;
    let (status, id, _) = send(&f).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(id, f.ids[0]);
}

#[tokio::test]
async fn account_usage_refresh_reactivates_quota_and_replaces_reserve_cache() {
    let f = fixture().await;
    f.router.quota.record(&f.ids[0], Some(usage(100.0, 0.0)));
    f.router
        .cool(&f.ids[0], "gpt-test", "额度限制", unix_now() + 18000);
    mount_usage(&f, 200, serde_json::to_value(usage(0.0, 0.0)).unwrap()).await;
    mount_response(&f, "a", success()).await;
    mount_response(&f, "b", success()).await;
    let mut service = crate::service::BridgeService::new(f.router.paths.clone());
    service.apis = crate::integrations::ApiIntegrations::with_subscription(
        f.router.paths.clone(),
        f.router.clone(),
    );
    let result = service
        .handle("/accounts/usage", json!({"recordId":f.ids[0]}))
        .await;
    assert_eq!(result["status"], "ok", "{result}");
    assert!(!f.router.cooling(&f.ids[0], "gpt-test"));
    let (status, id, _) = send(&f).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(id, f.ids[0]);
}

#[test]
fn quota_retry_keeps_shorter_resets_and_does_not_shorten_other_restrictions() {
    let temp = tempfile::tempdir().unwrap();
    let router = SubscriptionApi::new(AccountPaths {
        codex_home: temp.path().join("home"),
        state_dir: temp.path().join("state"),
        usage_endpoint: String::new(),
    });
    let now = unix_now();
    router.cool("a", "quota", "额度限制", now + 10);
    router.cool("a", "rate", "请求频率限制", now + 3600);
    router.cool("a", "model", "该账户不可用此模型", now + 3600);
    let states = router.state.lock().unwrap();
    assert_eq!(states[&("a".into(), "quota".into())].retry_at, now + 10);
    assert_eq!(states[&("a".into(), "rate".into())].retry_at, now + 3600);
    assert_eq!(states[&("a".into(), "model".into())].retry_at, now + 3600);
}

#[tokio::test]
async fn quota_refresh_keeps_unavailable_unknown_and_failed_accounts_cooled() {
    for (status, value) in [
        (200, serde_json::to_value(usage(100.0, 0.0)).unwrap()),
        (200, json!({})),
        (
            200,
            json!({"rate_limit":{"allowed":false,"primary_window":{
                "used_percent":0,"limit_window_seconds":604800
            }}}),
        ),
        (
            200,
            json!({"rate_limit":{"limit_reached":true,"primary_window":{
                "used_percent":0,"limit_window_seconds":604800
            }}}),
        ),
        (403, json!({"error":"denied"})),
    ] {
        let f = fixture().await;
        f.router
            .cool(&f.ids[0], "gpt-test", "额度限制", unix_now() + 18000);
        mount_usage(&f, status, value).await;
        let result = f.router.fetch_usage(&f.ids[0]).await;
        assert_eq!(result.is_ok(), status == 200);
        assert!(f.router.cooling(&f.ids[0], "gpt-test"));
    }
}

#[tokio::test]
async fn weekly_quota_refresh_preserves_rate_model_and_credential_restrictions() {
    let f = fixture().await;
    f.router
        .cool(&f.ids[0], "gpt-test", "额度限制", unix_now() + 18000);
    f.router
        .cool(&f.ids[0], "rate", "请求频率限制", unix_now() + 3600);
    f.router
        .cool(&f.ids[0], "model", "该账户不可用此模型", unix_now() + 3600);
    f.router
        .cool(&f.ids[0], "*", "凭据暂时不可用", unix_now() + 60);
    let revision = AccountVault::new(f.router.paths.clone())
        .credential_revision(&f.ids[0])
        .unwrap();
    f.router.reject(&f.ids[0], revision);
    mount_usage(
        &f,
        200,
        json!({"rate_limit":{"allowed":true,"primary_window":{
            "used_percent":0,"limit_window_seconds":604800,"reset_at":unix_now()+604800
        }}}),
    )
    .await;
    f.router.fetch_usage(&f.ids[0]).await.unwrap();
    let states = f.router.state.lock().unwrap();
    assert!(!states.contains_key(&(f.ids[0].clone(), "gpt-test".into())));
    for model in ["rate", "model", "*"] {
        assert!(states.contains_key(&(f.ids[0].clone(), model.into())));
    }
    drop(states);
    assert!(f.router.is_rejected_current(&f.ids[0]));
}

#[tokio::test]
async fn refreshed_quota_still_obeys_the_account_reserve() {
    let f = fixture().await;
    f.router
        .cool(&f.ids[0], "gpt-test", "额度限制", unix_now() + 18000);
    mount_usage(&f, 200, serde_json::to_value(usage(85.0, 0.0)).unwrap()).await;
    mount_response(&f, "b", success()).await;
    f.router.fetch_usage(&f.ids[0]).await.unwrap();
    assert!(!f.router.cooling(&f.ids[0], "gpt-test"));
    let (status, id, _) = send(&f).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(id, f.ids[1]);
    assert_eq!(f.server.received_requests().await.unwrap().len(), 2);
}

#[tokio::test]
async fn usage_query_started_before_a_new_quota_failure_cannot_clear_it() {
    let f = fixture().await;
    Mock::given(method("GET"))
        .and(path("/usage"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_json(serde_json::to_value(usage(0.0, 0.0)).unwrap())
                .set_delay(Duration::from_millis(75)),
        )
        .mount(&f.server)
        .await;
    let (result, ()) = tokio::join!(f.router.fetch_usage(&f.ids[0]), async {
        tokio::time::sleep(Duration::from_millis(25)).await;
        f.router
            .cool(&f.ids[0], "gpt-test", "额度限制", unix_now() + 18000);
    });
    result.unwrap();
    assert!(f.router.cooling(&f.ids[0], "gpt-test"));
}
