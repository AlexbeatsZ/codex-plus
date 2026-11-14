use super::*;
use crate::providers::{ProviderStore, SaveRequest};
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

#[test]
fn fixed_prompt_guard_does_not_confuse_history_or_images_with_fixed_tools() {
    let huge = "fixed tool description ".repeat(12000);
    assert!(
        check_fixed_prompt(
            &json!({"tools":[{"type":"function","description":huge}]}),
            32768
        )
        .is_err()
    );
    assert!(check_fixed_prompt(&json!({"instructions":huge}), 32768).is_err());
    assert!(
        check_fixed_prompt(
            &json!({"input":[{"role":"developer","content":huge}]}),
            32768
        )
        .is_err()
    );
    // Large history remains the native client's compaction responsibility.
    assert!(check_fixed_prompt(&json!({"input":[{"role":"user","content":huge}]}), 32768).is_ok());
    assert!(
        check_fixed_prompt(
            &json!({"input":[{"type":"input_image","image_url":huge}]}),
            32768
        )
        .is_ok()
    );
    assert!(check_fixed_prompt(&json!({"instructions":huge}), 128000).is_ok());
    assert!(check_fixed_prompt_at_limit(&json!({"instructions":huge}), 128000, 20000).is_err());
}

#[tokio::test]
async fn oversized_tools_never_reach_any_upstream_including_compaction_and_legacy_routes() {
    let temp = tempfile::tempdir().unwrap();
    let paths = paths(&temp);
    let upstream = MockServer::start().await;
    let mut store = ProviderStore::default();
    store.upsert(serde_json::from_value(json!({"name":"test","baseUrl":upstream.uri(),"apiKey":"fake","protocol":"responses","models":[{"modelId":"unknown","visible":true,"contextWindow":32768,"toolMode":"direct"},{"modelId":"unset","visible":true}]})).unwrap()).unwrap();
    let route = store.catalog()[0].route_id.clone();
    let unset = store.catalog()[1].route_id.clone();
    store.save(&paths).unwrap();
    let mut broker = crate::broker::start_on_port(paths.clone(), 0)
        .await
        .unwrap();
    let mut config = DocumentMut::new();
    Settings::reconcile(&paths, &mut config, broker.port()).unwrap();
    let settings = Settings::load(&paths).unwrap().unwrap();
    // The guard budgets against the catalog entry the client received.
    fs::create_dir_all(&paths.codex_home).unwrap();
    fs::write(
        paths.codex_home.join("models_cache.json"),
        json!({"models":[{"slug":"unknown","context_window":32768}]}).to_string(),
    )
    .unwrap();
    fs::write(paths.state_dir.join("subscription.json"), json!({"enabled":true,"accountOrder":["fake"],"models":[{"modelId":"unknown","visible":true}]}).to_string()).unwrap();
    let pool = crate::subscription::route_id("unknown");
    let native = format!("/native/{}/backend-api/codex", settings.capability);
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    for (endpoint, model) in [
        (format!("{native}/responses"), route.clone()),
        (format!("{native}/responses/compact"), route.clone()),
        ("/v1/responses".into(), route),
        ("/subscription/v1/responses".into(), "unknown".into()),
        (format!("{native}/responses"), pool),
    ] {
        for _ in 0..2 {
            let response = client.post(format!("http://127.0.0.1:{}{endpoint}", broker.port()))
                .bearer_auth(broker.token())
                .json(&json!({"model":model,"input":[],"tools":[{"type":"function","description":"fixed tool description ".repeat(12000)}]}))
                .send().await.unwrap();
            assert_eq!(response.status(), StatusCode::BAD_REQUEST, "{endpoint}");
            assert!(response.text().await.unwrap().contains("请求未发送"));
        }
    }
    // Even a tiny request is refused for an unconfigured route: sending it
    // would mean guessing the window and the relay's tool support.
    for endpoint in [format!("{native}/responses"), "/v1/responses".to_string()] {
        let response = client
            .post(format!("http://127.0.0.1:{}{endpoint}", broker.port()))
            .bearer_auth(broker.token())
            .json(&json!({"model":unset,"input":[]}))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST, "{endpoint}");
        assert!(response.text().await.unwrap().contains("尚未配置"));
    }
    assert!(upstream.received_requests().await.unwrap().is_empty());
    broker.shutdown().await;
}

#[test]
fn explicit_window_and_chat_protocol_preserve_consistent_capabilities() {
    let temp = tempfile::tempdir().unwrap();
    let paths = paths(&temp);
    let mut store = ProviderStore::default();
    store.upsert(serde_json::from_value(json!({"name":"chat","baseUrl":"https://example.test","apiKey":"fake","protocol":"chatCompletions","models":[{"modelId":"known","visible":true,"contextWindow":64000}]})).unwrap()).unwrap();
    store.save(&paths).unwrap();
    let settings = Settings {
        capability: "test".into(),
        original_base: None,
        original_catalog: None,
    };
    let result = catalog_with(&paths,&ApiIntegrations::new(paths.clone()),&settings,vec![json!({"slug":"known","context_window":500000,"max_context_window":900000,"auto_compact_token_limit":450000,"tool_mode":"code_mode_only","supports_search_tool":true})]).unwrap();
    let model = &result["models"][1];
    assert_eq!(model["context_window"], 64000);
    assert_eq!(model["max_context_window"], 64000);
    assert_eq!(model["auto_compact_token_limit"], 57600);
    assert_eq!(model["tool_mode"], "direct");
    assert_eq!(model["supports_search_tool"], false);
}

fn paths(temp: &tempfile::TempDir) -> AccountPaths {
    AccountPaths {
        codex_home: temp.path().join("home"),
        state_dir: temp.path().join("state"),
        usage_endpoint: String::new(),
    }
}

#[test]
fn simultaneous_catalog_versions_cannot_lose_archived_models() {
    let temp = tempfile::tempdir().unwrap();
    let paths = paths(&temp);
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(8));
    std::thread::scope(|scope| {
        for index in 0..8 {
            let paths = &paths;
            let barrier = barrier.clone();
            scope.spawn(move || {
                barrier.wait();
                archive_templates(
                    paths,
                    &[json!({"slug":format!("model-{index}"),"context_window":500000})],
                )
                .unwrap();
            });
        }
    });
    assert_eq!(
        read_entries(&paths.state_dir.join(TEMPLATE_ARCHIVE)).len(),
        8
    );
}

#[test]
fn config_preserves_identity_original_endpoint_and_unknown_settings() {
    let temp = tempfile::tempdir().unwrap();
    let paths = paths(&temp);
    let mut config: DocumentMut =
        "openai_base_url='https://original.example/v1'\nmodel_provider='openai'\nfoo='preserved'\n"
            .parse()
            .unwrap();
    Settings::reconcile(&paths, &mut config, 1234).unwrap();
    let settings = Settings::load(&paths).unwrap().unwrap();
    assert_eq!(
        settings.original_base.as_deref(),
        Some("https://original.example/v1")
    );
    assert_eq!(config["model_provider"].as_str(), Some("openai"));
    assert_eq!(config["foo"].as_str(), Some("preserved"));
    Settings::reconcile(&paths, &mut config, 2345).unwrap();
    assert_eq!(
        Settings::load(&paths).unwrap().unwrap().capability,
        settings.capability
    );
    assert!(
        config["openai_base_url"]
            .as_str()
            .unwrap()
            .contains(":2345/")
    );
    config["openai_base_url"] = value("https://external-change.example");
    assert!(Settings::reconcile(&paths, &mut config, 3456).is_err());
    assert!(!paths.live_auth().exists());
}

#[test]
fn catalog_uses_real_capabilities_and_keeps_same_name_channels_distinct() {
    let temp = tempfile::tempdir().unwrap();
    let paths = paths(&temp);
    fs::create_dir_all(&paths.codex_home).unwrap();
    fs::write(paths.codex_home.join("models_cache.json"), json!({"models":[{"slug":"known","context_window":123456,"input_modalities":["text","image"],"use_responses_lite":true},{"slug":"cp-stale"}]}).to_string()).unwrap();
    let mut config = DocumentMut::new();
    Settings::reconcile(&paths, &mut config, 1).unwrap();
    let mut store = ProviderStore::default();
    // "two" leaves its unmatched model unconfigured, so nothing is guessed for it.
    for (name, unknown) in [
        (
            "one",
            json!({"modelId":"unknown","visible":true,"contextWindow":32768,"toolMode":"direct"}),
        ),
        ("two", json!({"modelId":"unknown","visible":true})),
    ] {
        let request: SaveRequest = serde_json::from_value(json!({"name":name,"baseUrl":"https://example.test/v1","apiKey":"PRIVATE","protocol":"responses","enabled":true,"models":[{"modelId":"known","displayName":"alias","visible":true,"toolMode":"direct"},unknown]})).unwrap();
        store.upsert(request).unwrap();
    }
    store.save(&paths).unwrap();
    let apis = ApiIntegrations::new(paths.clone());
    let settings = Settings::load(&paths).unwrap().unwrap();
    let result = catalog(&paths, &apis, &settings).unwrap();
    let models = result["models"].as_array().unwrap();
    assert_eq!(models.len(), 4);
    assert!(!result.to_string().contains("PRIVATE"));
    assert!(models.iter().all(|m| m["slug"] != "cp-stale"));
    assert_eq!(
        models
            .iter()
            .filter(|m| m["context_window"] == 123456)
            .count(),
        3
    );
    assert_eq!(
        models
            .iter()
            .filter(|m| m["context_window"] == 32768)
            .count(),
        1
    );
    assert!(models[1..].iter().all(|m| m["use_responses_lite"] == false));
    assert!(
        apis.catalog()
            .iter()
            .all(|m| m.native_provider_id == "openai")
    );
}

#[test]
fn subscription_keeps_deferred_tools_and_routes_never_shrink_to_fallback() {
    let temp = tempfile::tempdir().unwrap();
    let paths = paths(&temp);
    fs::create_dir_all(&paths.codex_home).unwrap();
    let native = |slug: &str, window: u64| json!({"slug":slug,"context_window":window,"max_context_window":window,"input_modalities":["text","image"],"use_responses_lite":true,"tool_mode":"code_mode_only","supports_search_tool":true,"experimental_supported_tools":["clock"]});
    fs::write(
        paths.codex_home.join("models_cache.json"),
        json!({"models":[native("small", 272000), native("big", 500000)]}).to_string(),
    )
    .unwrap();
    let mut config = DocumentMut::new();
    Settings::reconcile(&paths, &mut config, 1).unwrap();
    let settings = Settings::load(&paths).unwrap().unwrap();
    fs::write(
        paths.state_dir.join("subscription.json"),
        json!({"enabled":true,"accountOrder":["seat"],"models":[{"modelId":"big","visible":true},{"modelId":"future","visible":true}]}).to_string(),
    )
    .unwrap();
    let mut store = ProviderStore::default();
    store.upsert(serde_json::from_value(json!({"name":"relay","baseUrl":"https://example.test/v1","apiKey":"PRIVATE","protocol":"responses","enabled":true,"models":[{"modelId":"vendor/big","visible":true,"toolMode":"deferred"},{"modelId":"vendor/small","visible":true}]})).unwrap()).unwrap();
    store.save(&paths).unwrap();
    let apis = ApiIntegrations::new(paths.clone());
    let find = |result: &Value, slug: &str| {
        result["models"]
            .as_array()
            .unwrap()
            .iter()
            .find(|m| m["slug"] == slug)
            .cloned()
            .unwrap()
    };
    let relay = store.catalog()[0].route_id.clone();
    let pool = crate::subscription::route_id("big");
    // A later official refresh omits "big"; archived capabilities still apply.
    archive_templates(&paths, &[native("small", 272000), native("big", 500000)]).unwrap();
    fs::remove_file(paths.codex_home.join("models_cache.json")).unwrap();
    let result = catalog_with(&paths, &apis, &settings, vec![native("small", 272000)]).unwrap();
    let subscription = find(&result, &pool);
    assert_eq!(subscription["context_window"], 500000);
    assert_eq!(subscription["tool_mode"], "code_mode_only");
    assert_eq!(subscription["supports_search_tool"], true);
    assert_eq!(
        subscription["experimental_supported_tools"],
        json!(["clock"])
    );
    assert_eq!(subscription["use_responses_lite"], false);
    // Neither an unknown subscription model nor a relay whose tool support was
    // never declared is offered with borrowed capabilities.
    let slugs = result.to_string();
    assert!(!slugs.contains(&crate::subscription::route_id("future")));
    assert!(!slugs.contains(&store.catalog()[1].route_id));
    // A matched window is a model fact; deferred tools are the user's declaration.
    let external = find(&result, &relay);
    assert_eq!(external["context_window"], 500000);
    assert_eq!(external["tool_mode"], "code_mode_only");
    assert_eq!(external["supports_search_tool"], true);
    assert_eq!(external["experimental_supported_tools"], json!([]));
    assert!(!result.to_string().contains("PRIVATE"));
}

#[test]
fn zstd_decodes_before_routing_and_original_body_stays_opaque() {
    let raw = br#"{"model":"cp-test","input":[]}"#;
    let bytes = Bytes::from(zstd::stream::encode_all(raw.as_slice(), 1).unwrap());
    let mut headers = HeaderMap::new();
    headers.insert(header::CONTENT_ENCODING, "zstd".parse().unwrap());
    assert_eq!(decode(&headers, &bytes).unwrap()["model"], "cp-test");
    assert!(decode(&headers, &Bytes::from_static(b"invalid")).is_err());
}

#[test]
fn live_login_cannot_be_injected_into_a_third_party_original_endpoint() {
    let temp = tempfile::tempdir().unwrap();
    let paths = paths(&temp);
    let settings = Settings {
        capability: "test".into(),
        original_base: Some("https://external.example/v1".into()),
        original_catalog: None,
    };
    assert!(!settings.may_use_live_login());
    assert!(official_headers(&paths, &settings, &HeaderMap::new()).is_err());
    let mut own = HeaderMap::new();
    own.insert(
        header::AUTHORIZATION,
        "Bearer explicit-own-key".parse().unwrap(),
    );
    assert_eq!(
        official_headers(&paths, &settings, &own).unwrap()[header::AUTHORIZATION],
        "Bearer explicit-own-key"
    );
}

#[test]
fn compaction_route_is_per_thread_persistent_and_reviewer_does_not_replace_it() {
    let temp = tempfile::tempdir().unwrap();
    let paths = paths(&temp);
    let mut a = HeaderMap::new();
    a.insert("thread-id", "a".parse().unwrap());
    let mut b = HeaderMap::new();
    b.insert("thread-id", "b".parse().unwrap());
    assert_eq!(
        remember_route(&paths, &a, "cp-api", false).unwrap(),
        "cp-api"
    );
    assert_eq!(
        remember_route(&paths, &a, "codex-auto-review", false).unwrap(),
        "cp-api"
    );
    assert_eq!(
        remember_route(&paths, &b, "codex-auto-review", false).unwrap(),
        "codex-auto-review"
    );
    let mut guardian = HeaderMap::new();
    guardian.insert("thread-id", "guardian-child".parse().unwrap());
    guardian.insert("session-id", "a".parse().unwrap());
    guardian.insert("x-codex-parent-thread-id", "a".parse().unwrap());
    assert_eq!(
        remember_route(&paths, &guardian, "codex-auto-review", false).unwrap(),
        "cp-api"
    );
    guardian.insert(
        "x-codex-parent-thread-id",
        "unknown-parent".parse().unwrap(),
    );
    assert_eq!(
        remember_route(&paths, &guardian, "codex-auto-review", false).unwrap(),
        "codex-auto-review"
    );
    guardian.remove("x-codex-parent-thread-id");
    assert_eq!(
        remember_route(&paths, &guardian, "codex-auto-review", false).unwrap(),
        "cp-api"
    );
    assert_eq!(remember_route(&paths, &a, "real", true).unwrap(), "cp-api");
    assert_eq!(remember_route(&paths, &b, "real", true).unwrap(), "real");
    remember_route(&paths, &a, "official", false).unwrap();
    assert_eq!(
        remember_route(&paths, &a, "codex-auto-review", false).unwrap(),
        "codex-auto-review"
    );
    assert_eq!(remember_route(&paths, &a, "real", true).unwrap(), "real");
}

#[tokio::test]
async fn native_gateway_auth_routing_and_official_credentials_are_separate() {
    let temp = tempfile::tempdir().unwrap();
    let paths = paths(&temp);
    let official = MockServer::start().await;
    let external = MockServer::start().await;
    for server in [&official, &external] {
        Mock::given(method("POST"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(json!({"output":[],"marker":"passed"})),
            )
            .mount(server)
            .await;
    }
    fs::create_dir_all(&paths.codex_home).unwrap();
    fs::write(
        paths.codex_config(),
        format!("openai_base_url='{}'\n", official.uri()),
    )
    .unwrap();
    let mut store = ProviderStore::default();
    store.upsert(serde_json::from_value(json!({"name":"external","baseUrl":external.uri(),"apiKey":"external-secret","protocol":"responses","enabled":true,"models":[{"modelId":"same","visible":true,"toolMode":"direct"}]})).unwrap()).unwrap();
    let route = store.catalog()[0].route_id.clone();
    store.save(&paths).unwrap();
    let mut broker = crate::broker::start_on_port(paths.clone(), 0)
        .await
        .unwrap();
    crate::config::reconcile_codex_config(&paths, broker.port()).unwrap();
    let settings = Settings::load(&paths).unwrap().unwrap();
    let base = format!(
        "http://127.0.0.1:{}/native/{}/backend-api/codex",
        broker.port(),
        settings.capability
    );
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let send = |model: String| {
        client
            .post(format!("{base}/responses"))
            .bearer_auth("official-secret")
            .header("thread-id", "fixture-thread")
            .json(&json!({"model":model,"stream":false,"input":[]}))
            .send()
    };
    assert_eq!(send("same".into()).await.unwrap().status(), StatusCode::OK);
    assert_eq!(
        send("codex-auto-review".into()).await.unwrap().status(),
        StatusCode::OK
    );
    assert_eq!(send(route.clone()).await.unwrap().status(), StatusCode::OK);
    // This managed-parent reviewer must not silently consume the logged-in
    // account, nor be sent to the external provider. The pool is disabled here.
    let review = send("codex-auto-review".into()).await.unwrap();
    assert_eq!(review.status(), StatusCode::NOT_FOUND);
    assert!(
        review
            .text()
            .await
            .unwrap()
            .contains("pool_review_unavailable")
    );
    assert_eq!(
        send("cp-deleted".into()).await.unwrap().status(),
        StatusCode::NOT_FOUND
    );
    let bad = base.replace(&settings.capability, "wrong");
    assert_eq!(
        client
            .post(format!("{bad}/responses"))
            .json(&json!({"model":"same"}))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );
    let official_requests = official.received_requests().await.unwrap();
    assert_eq!(official_requests.len(), 2);
    assert!(
        official_requests
            .iter()
            .all(|r| r.headers["authorization"] == "Bearer official-secret")
    );
    let external_requests = external.received_requests().await.unwrap();
    assert_eq!(external_requests.len(), 1);
    assert_eq!(
        external_requests[0].headers["authorization"],
        "Bearer external-secret"
    );
    assert_eq!(
        serde_json::from_slice::<Value>(&external_requests[0].body).unwrap()["model"],
        "same"
    );
    // web.run's search endpoint keeps official ownership; local routes cannot borrow it.
    let search = |model: &str| {
        client
            .post(format!("{base}/alpha/search?probe=1"))
            .bearer_auth("official-secret")
            .json(&json!({"model":model,"commands":{"search_query":[{"q":"fixture"}]}}))
            .send()
    };
    assert_eq!(search("same").await.unwrap().status(), StatusCode::OK);
    assert_eq!(
        search(&route).await.unwrap().status(),
        StatusCode::BAD_REQUEST
    );
    let searches: Vec<_> = official
        .received_requests()
        .await
        .unwrap()
        .into_iter()
        .filter(|r| r.url.path() == "/alpha/search")
        .collect();
    assert_eq!(searches.len(), 1);
    assert_eq!(searches[0].url.query(), Some("probe=1"));
    assert_eq!(
        searches[0].headers["authorization"],
        "Bearer official-secret"
    );
    assert_eq!(external.received_requests().await.unwrap().len(), 1);
    assert_eq!(
        client
            .get(format!("{base}/responses"))
            .bearer_auth("official-secret")
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::UPGRADE_REQUIRED
    );
    // Native catalog preserves aliases for HTTP clients independently of renderer injection.
    Mock::given(method("GET"))
        .and(path("/models"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_json(json!({"models":[{"slug":"same","context_window":100000}]})),
        )
        .mount(&official)
        .await;
    let catalog: Value = client
        .get(format!("{base}/models"))
        .bearer_auth("official-secret")
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(
        catalog["models"]
            .as_array()
            .unwrap()
            .iter()
            .any(|m| m["slug"] == route)
    );
    broker.shutdown().await;
}

#[test]
fn thread_routes_accept_the_legacy_format_and_survive_corruption() {
    let temp = tempfile::tempdir().unwrap();
    let paths = paths(&temp);
    std::fs::create_dir_all(&paths.state_dir).unwrap();
    let file = paths.state_dir.join("native-thread-routes.json");
    std::fs::write(&file, json!({"old": "cp-legacy"}).to_string()).unwrap();
    let mut old = HeaderMap::new();
    old.insert("thread-id", "old".parse().unwrap());
    // Pre-0.3.14 entries still recover their channel for compaction.
    assert_eq!(
        remember_route(&paths, &old, "gpt-real", true).unwrap(),
        "cp-legacy"
    );
    // A damaged file is moved aside and treated like a missing record (the
    // same as a thread never seen before) instead of failing every request.
    std::fs::write(&file, "{broken").unwrap();
    assert_eq!(
        remember_route(&paths, &old, "gpt-real", false).unwrap(),
        "gpt-real"
    );
    let stored: Value = serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap();
    assert_eq!(stored["old"]["route"], "gpt-real");
    // An unchanged turn does not rewrite the file.
    let before = std::fs::metadata(&file).unwrap().modified().unwrap();
    std::thread::sleep(std::time::Duration::from_millis(20));
    remember_route(&paths, &old, "gpt-real", false).unwrap();
    assert_eq!(
        std::fs::metadata(&file).unwrap().modified().unwrap(),
        before
    );
}

#[test]
fn thread_routes_are_pruned_by_age_and_count() {
    let mut routes = HashMap::new();
    let now = 10_000_000_u64;
    routes.insert(
        "stale".to_string(),
        ThreadRoute::Timed {
            route: "cp-a".into(),
            at: now - THREAD_ROUTE_TTL_SECS - 1,
        },
    );
    for index in 0..(THREAD_ROUTE_LIMIT + 10) {
        routes.insert(
            format!("t{index}"),
            ThreadRoute::Timed {
                route: "cp-a".into(),
                at: now - 1000 + index as u64,
            },
        );
    }
    prune_thread_routes(&mut routes, now);
    assert!(!routes.contains_key("stale"));
    assert!(routes.len() <= THREAD_ROUTE_LIMIT);
    assert!(routes.contains_key(&format!("t{}", THREAD_ROUTE_LIMIT + 9)));
}
