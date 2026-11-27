use super::*;
use crate::subscription::config::{AccountReserve, AccountTemporary, TemporaryResetTarget};
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

struct Fixture {
    _temp: tempfile::TempDir,
    api: SubscriptionApi,
    config: SubscriptionConfig,
    ids: Vec<String>,
    server: MockServer,
}

fn usage(short_used: f64, weekly_used: f64, days: u64) -> Usage {
    serde_json::from_value(json!({"rate_limit":{
        "primary_window":{"used_percent":short_used,"limit_window_seconds":18000,"reset_at":unix_now()+3600},
        "secondary_window":{"used_percent":weekly_used,"limit_window_seconds":604800,"reset_at":unix_now()+days*86400}
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
    let jwt = |v: Value| {
        format!(
            "header.{}.signature",
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(v.to_string())
        )
    };
    let ids: Vec<_> = ["a","b","c"].iter().map(|id| {
        vault.import_auth(&serde_json::to_vec(&json!({"auth_mode":"chatgpt","tokens":{
            "id_token":jwt(json!({"sub":id,"email":format!("{id}@test.invalid")})),
            "access_token":jwt(json!({"sub":id,"exp":unix_now()+3600})),"refresh_token":format!("refresh-{id}"),"account_id":id
        }})).unwrap()).unwrap().record_id
    }).collect();
    let config = SubscriptionConfig {
        enabled: true,
        account_order: ids.clone(),
        models: vec![crate::providers::SaveModel {
            model_id: "gpt-test".into(),
            display_name: String::new(),
            visible: true,
            context_window: None,
            tool_mode: None,
        }],
        ..Default::default()
    };
    config.save(&paths).unwrap();
    crate::native_gateway::archive_official(
        &paths,
        &json!({"models":[{"slug":"gpt-test","context_window":272000}]}),
    )
    .unwrap();
    let mut api = SubscriptionApi::new(paths);
    api.native_base = server.uri();
    for (id, u) in ids
        .iter()
        .zip([usage(20., 40., 1), usage(10., 20., 4), usage(60., 10., 6)])
    {
        api.quota.observe_event(id, Some(u));
    }
    Mock::given(method("POST")).and(path("/responses"))
        .respond_with(ResponseTemplate::new(200).set_body_string("data: {\"type\":\"response.output_text.delta\",\"delta\":\"OK\"}\n\ndata: {\"type\":\"response.completed\"}\n\n"))
        .mount(&server).await;
    Fixture {
        _temp: temp,
        api,
        config,
        ids,
        server,
    }
}

async fn send(f: &Fixture, session: &str) -> (StatusCode, String) {
    let mut headers = HeaderMap::new();
    headers.insert("thread-id", HeaderValue::from_str(session).unwrap());
    let response = f
        .api
        .responses(
            headers,
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
    axum::body::to_bytes(response.into_body(), 1024 * 1024)
        .await
        .unwrap();
    (status, id)
}

#[tokio::test]
async fn weekly_score_ranks_new_sessions_and_short_window_only_gates_availability() {
    let f = fixture().await;
    assert_eq!(send(&f, "new-a").await, (StatusCode::OK, f.ids[0].clone()));
    f.api
        .quota
        .observe_event(&f.ids[0], Some(usage(100., 40., 1)));
    assert_eq!(send(&f, "new-b").await, (StatusCode::OK, f.ids[1].clone()));
    let current = SubscriptionConfig::load(&f.api.paths).unwrap();
    assert_eq!(current.account_order, f.ids);
}

#[tokio::test]
async fn priority_order_affinity_force_and_restart_use_the_same_policy() {
    let mut f = fixture().await;
    assert_eq!(send(&f, "sticky").await.1, f.ids[0]);
    f.config.account_priority = vec![f.ids[2].clone(), f.ids[1].clone()];
    f.config.save(&f.api.paths).unwrap();
    assert_eq!(send(&f, "sticky").await.1, f.ids[0]);
    assert_eq!(send(&f, "new-priority").await.1, f.ids[2]);
    // Recreate the broker: account affinity survives without copying credentials.
    let mut api = SubscriptionApi::new(f.api.paths.clone());
    api.native_base = f.server.uri();
    for id in &f.ids {
        api.quota.observe_event(id, Some(usage(20., 20., 1)));
    }
    f.api = api;
    assert_eq!(send(&f, "sticky").await.1, f.ids[0]);
    f.config.force_priority = true;
    f.config.save(&f.api.paths).unwrap();
    assert_eq!(send(&f, "sticky").await.1, f.ids[2]);
    f.api
        .quota
        .observe_event(&f.ids[2], Some(usage(100., 20., 1)));
    assert_eq!(send(&f, "new-fallback").await.1, f.ids[1]);
    assert_eq!(
        SubscriptionConfig::load(&f.api.paths)
            .unwrap()
            .account_priority,
        f.config.account_priority
    );
}

#[tokio::test]
async fn completed_weekly_target_returns_to_auto_and_does_not_reapply_stale_policy() {
    let mut f = fixture().await;
    f.config.account_priority = vec![f.ids[2].clone()];
    f.config.account_temporary.insert(
        f.ids[2].clone(),
        AccountTemporary {
            weekly_remaining_percent: Some(10),
            ..Default::default()
        },
    );
    f.config.save(&f.api.paths).unwrap();
    assert_eq!(send(&f, "before").await.1, f.ids[2]);
    f.api
        .observe_event_and_temporary(&f.ids[2], Some(usage(80., 90., 6)));
    let current = SubscriptionConfig::load(&f.api.paths).unwrap();
    assert!(current.account_priority.is_empty());
    assert!(!current.account_temporary.contains_key(&f.ids[2]));
    assert_eq!(current.account_order, f.ids);
    assert_eq!(send(&f, "after").await.1, f.ids[0]);
    // The prior session still has affinity to c, which remains legally available.
    assert_eq!(send(&f, "before").await.1, f.ids[2]);
}

#[tokio::test]
async fn scheduling_can_complete_a_goal_and_select_auto_in_the_same_request() {
    let mut f = fixture().await;
    f.config.account_priority = vec![f.ids[2].clone()];
    f.config.account_temporary.insert(
        f.ids[2].clone(),
        AccountTemporary {
            weekly_remaining_percent: Some(10),
            ..Default::default()
        },
    );
    f.config.save(&f.api.paths).unwrap();
    // Store an observation directly so no UI/query reconciliation runs beforehand.
    f.api
        .quota
        .observe_event(&f.ids[2], Some(usage(20., 90., 6)));
    assert_eq!(send(&f, "goal-during-send").await.1, f.ids[0]);
    let current = SubscriptionConfig::load(&f.api.paths).unwrap();
    assert_eq!(current.account_order, f.ids);
    assert!(current.account_priority.is_empty());
    assert!(current.account_temporary.is_empty());
}

#[tokio::test]
async fn duration_and_week_reset_exit_priority_but_short_exhaustion_does_not() {
    let mut f = fixture().await;
    let id = f.ids[2].clone();
    f.config.account_priority = vec![id.clone()];
    f.config.account_temporary.insert(
        id.clone(),
        AccountTemporary {
            until_reset: Some(TemporaryResetTarget::Long),
            ..Default::default()
        },
    );
    f.config.save(&f.api.paths).unwrap();
    assert_eq!(send(&f, "week-before").await.1, id);
    f.api
        .observe_event_and_temporary(&id, Some(usage(100., 20., 6)));
    assert_eq!(
        SubscriptionConfig::load(&f.api.paths)
            .unwrap()
            .account_priority,
        vec![id.clone()]
    );
    f.api
        .observe_event_and_temporary(&id, Some(usage(0., 0., 7)));
    assert!(
        SubscriptionConfig::load(&f.api.paths)
            .unwrap()
            .account_priority
            .is_empty()
    );
    f.config.account_temporary.insert(
        id.clone(),
        AccountTemporary {
            duration_minutes: Some(1),
            ..Default::default()
        },
    );
    f.api.save(f.config.clone()).unwrap();
    f.api
        .quota
        .temporary
        .lock()
        .unwrap()
        .get_mut(&id)
        .unwrap()
        .expires_at = Some(unix_now() as i64);
    let view = f.api.view().unwrap();
    assert_eq!(view["config"]["accountPriority"], json!([]));
    assert_eq!(view["config"]["accountOrder"], json!(f.ids));
}

#[tokio::test]
async fn reserves_unknown_quota_and_cooldown_override_priority_and_affinity() {
    let mut f = fixture().await;
    assert_eq!(send(&f, "sticky").await.1, f.ids[0]);
    f.config.account_priority = vec![f.ids[2].clone()];
    f.config.force_priority = true;
    f.config.account_reserves.insert(
        f.ids[2].clone(),
        AccountReserve {
            long_term_percent: Some(95),
            ..Default::default()
        },
    );
    f.config.save(&f.api.paths).unwrap();
    f.api
        .cool(&f.ids[0], "gpt-test", CoolReason::Quota, unix_now() + 60);
    assert_eq!(send(&f, "sticky").await.1, f.ids[1]);
    f.api.quota.record(&f.ids[1], None);
    assert_eq!(send(&f, "unknown").await.0, StatusCode::SERVICE_UNAVAILABLE);
}

#[test]
fn weekly_score_uses_window_duration_instead_of_primary_secondary_position() {
    let mut value = usage(99., 40., 1);
    let rate = value.rate_limit.as_mut().unwrap();
    std::mem::swap(&mut rate.primary_window, &mut rate.secondary_window);
    assert!((weekly_score(&value).unwrap() - 60.).abs() < 0.01);
    assert!(available(&value));
    value.rate_limit.as_mut().unwrap().allowed = Some(false);
    assert!(!available(&value));
}
