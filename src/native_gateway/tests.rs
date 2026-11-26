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
    let invalid = decode(&headers, &Bytes::from_static(b"invalid")).unwrap_err();
    assert_eq!(invalid.status(), StatusCode::BAD_REQUEST);
}

#[test]
fn oversized_zstd_body_is_reported_as_too_large_not_malformed() {
    let mut raw = br#"{"model":"cp-test","input":""#.to_vec();
    raw.resize(LIMIT + 16, b'A');
    raw.extend_from_slice(br#""}"#);
    let bytes = Bytes::from(zstd::stream::encode_all(raw.as_slice(), 1).unwrap());
    assert!(bytes.len() < LIMIT);
    let mut headers = HeaderMap::new();
    headers.insert(header::CONTENT_ENCODING, "zstd".parse().unwrap());
    let error = decode(&headers, &bytes).unwrap_err();
    assert!(matches!(error, DecodeError::TooLarge));
    assert_eq!(error.status(), StatusCode::PAYLOAD_TOO_LARGE);
    assert!(!error.to_string().contains("格式无效"));

    headers.insert(header::CONTENT_ENCODING, "br".parse().unwrap());
    let error = decode(&headers, &Bytes::from_static(b"{}")).unwrap_err();
    assert_eq!(error.status(), StatusCode::UNSUPPORTED_MEDIA_TYPE);
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

#[test]
fn spawned_children_follow_the_parent_managed_channel() {
    let temp = tempfile::tempdir().unwrap();
    let paths = paths(&temp);
    let pool_parent = crate::subscription::route_id("gpt-parent");
    let pool_child = crate::subscription::route_id("gpt-child");
    let headers = |thread: &str, parent: Option<&str>| {
        let mut h = HeaderMap::new();
        h.insert("thread-id", thread.parse().unwrap());
        if let Some(parent) = parent {
            h.insert("x-codex-parent-thread-id", parent.parse().unwrap());
            h.insert("x-openai-subagent", "collab_spawn".parse().unwrap());
        }
        h
    };
    let only_child = |r: &str| r == pool_child;
    remember_route(&paths, &headers("pool", None), &pool_parent, false).unwrap();
    remember_route(&paths, &headers("api", None), "cp-api", false).unwrap();
    remember_route(&paths, &headers("official", None), "gpt-child", false).unwrap();
    // A pool parent keeps the child's chosen model inside the pool.
    assert_eq!(
        remember_route_with(
            &paths,
            &headers("c1", Some("pool")),
            "gpt-child",
            false,
            &only_child
        )
        .unwrap(),
        pool_child
    );
    // The pool does not offer the chosen model: use the parent's pool model.
    assert_eq!(
        remember_route_with(
            &paths,
            &headers("c2", Some("pool")),
            "gpt-other",
            false,
            &only_child
        )
        .unwrap(),
        pool_parent
    );
    assert_eq!(
        remember_route(&paths, &headers("c3", Some("api")), "gpt-child", false).unwrap(),
        "cp-api"
    );
    // Official parents and unknown parents keep official ownership.
    assert_eq!(
        remember_route(&paths, &headers("c4", Some("official")), "gpt-child", false).unwrap(),
        "gpt-child"
    );
    assert_eq!(
        remember_route(&paths, &headers("c5", Some("missing")), "gpt-child", false).unwrap(),
        "gpt-child"
    );
    // Only spawn_agent children inherit; other subagent kinds do not.
    let mut memory = headers("c6", Some("pool"));
    memory.insert("x-openai-subagent", "memory_consolidation".parse().unwrap());
    assert_eq!(
        remember_route(&paths, &memory, "gpt-child", false).unwrap(),
        "gpt-child"
    );
    // Grandchildren inherit through the recorded child, and compaction stays.
    assert_eq!(
        remember_route_with(
            &paths,
            &headers("g1", Some("c1")),
            "gpt-child",
            false,
            &only_child
        )
        .unwrap(),
        pool_child
    );
    assert_eq!(
        remember_route(&paths, &headers("c1", None), "gpt-child", true).unwrap(),
        pool_child
    );
    // The client mirrors the identity into client_metadata.
    let body = json!({"client_metadata":{"x-codex-parent-thread-id":"api","x-openai-subagent":"collab_spawn"}});
    let mirrored = routing_headers(&headers("c7", None), &body);
    assert!(is_spawned_child(&mirrored));
    assert_eq!(
        remember_route(&paths, &mirrored, "gpt-child", false).unwrap(),
        "cp-api"
    );
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

#[test]
fn newest_client_version_wins_regardless_of_refresh_order() {
    assert!(newer_version(None, "0.162.1"));
    assert!(newer_version(Some("0.162.1"), "0.169.0"));
    assert!(!newer_version(Some("0.169.0"), "0.162.1"));
    assert!(newer_version(Some("0.99.0"), "0.169.0"));
    assert!(!newer_version(Some("0.169.0"), "0.169.0-alpha.11"));
    assert_eq!(
        client_version_from_query("a=1&client_version=0.169.0"),
        Some("0.169.0")
    );
    assert_eq!(client_version_from_query("client_version=../x"), None);
    assert_eq!(client_version_from_query("client_version=a/b"), None);
}

#[tokio::test]
async fn failed_refresh_serves_the_same_versions_last_list_not_another_clients() {
    use wiremock::matchers::query_param;
    let temp = tempfile::tempdir().unwrap();
    let paths = paths(&temp);
    let official = MockServer::start().await;
    fs::create_dir_all(&paths.codex_home).unwrap();
    fs::write(
        paths.codex_config(),
        format!("openai_base_url='{}'\n", official.uri()),
    )
    .unwrap();
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
    let new = json!({"models":[{"slug":"gpt-new","context_window":500000},{"slug":"gpt-old","context_window":272000}]});
    let old = json!({"models":[{"slug":"gpt-old","context_window":272000}]});
    for (version, body) in [("9.169.0", &new), ("9.162.1", &old)] {
        Mock::given(method("GET"))
            .and(path("/models"))
            .and(query_param("client_version", version))
            .respond_with(ResponseTemplate::new(200).set_body_json(body))
            .mount(&official)
            .await;
    }
    let slugs = |version: &'static str| {
        let request = client
            .get(format!("{base}/models?client_version={version}"))
            .bearer_auth("official-secret")
            .send();
        async move {
            let doc: Value = request.await.unwrap().json().await.unwrap();
            doc["models"]
                .as_array()
                .unwrap()
                .iter()
                .filter_map(|m| m["slug"].as_str().map(str::to_string))
                .collect::<Vec<_>>()
        }
    };
    // The newer desktop refreshes first, then an older client overwrites the
    // shared snapshot, exactly the order that dropped gpt-new in production.
    assert!(slugs("9.169.0").await.contains(&"gpt-new".to_string()));
    assert!(!slugs("9.162.1").await.contains(&"gpt-new".to_string()));
    assert_eq!(native_client_version(), "9.169.0");

    official.reset().await;
    Mock::given(method("GET"))
        .and(path("/models"))
        .respond_with(ResponseTemplate::new(503))
        .mount(&official)
        .await;
    assert!(slugs("9.169.0").await.contains(&"gpt-new".to_string()));
    assert!(!slugs("9.162.1").await.contains(&"gpt-new".to_string()));
    let log = fs::read_to_string(paths.log_path()).unwrap_or_default();
    assert!(log.contains("native.models.refresh_failed"));
    assert!(log.contains("version_snapshot"));
    broker.shutdown().await;
}

fn catalog_model(tool_mode: Option<ToolMode>) -> crate::providers::CatalogModel {
    crate::providers::CatalogModel {
        route_id: "cp-pool-x".into(),
        model_id: "gpt-x".into(),
        display_name: "gpt-x".into(),
        provider_id: crate::integrations::SUBSCRIPTION_ID.into(),
        provider_name: "ChatGPT".into(),
        native_provider_id: "openai".into(),
        context_window: None,
        tool_mode,
        protocol: None,
    }
}

#[test]
fn fallback_metadata_requests_are_refused_before_inlining_every_tool() {
    let entry = catalog_model(None);
    let code_mode = json!({"slug":"cp-pool-x","tool_mode":"code_mode_only"});
    let exec = json!({"type":"custom","name":"exec","format":{"type":"grammar"}});
    let inlined = json!({"type":"function","name":"mcp__docs__read","parameters":{}});
    // The fallback client sends direct tools without exec: refused locally.
    let error = check_client_metadata(&entry, &code_mode, &json!({"tools":[inlined.clone()]}))
        .unwrap_err()
        .to_string();
    assert!(error.contains("请求未发送") && error.contains("新建任务"));
    // A real code-mode turn always carries exec, possibly beside other tools.
    assert!(
        check_client_metadata(
            &entry,
            &code_mode,
            &json!({"tools":[exec, inlined.clone()]})
        )
        .is_ok()
    );
    // Tool-less requests (compaction, titles) cost nothing extra.
    assert!(check_client_metadata(&entry, &code_mode, &json!({"tools":[]})).is_ok());
    assert!(check_client_metadata(&entry, &code_mode, &json!({"input":[]})).is_ok());
    // Direct routes legitimately inline tools.
    let direct = json!({"slug":"cp-pool-x","tool_mode":"direct"});
    assert!(check_client_metadata(&entry, &direct, &json!({"tools":[inlined]})).is_ok());
}

#[test]
fn compressed_model_lists_decode_and_unknown_encodings_fail() {
    use std::io::Write as _;
    let raw = br#"{"models":[{"slug":"gpt-x"}]}"#;
    let mut gzip = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
    gzip.write_all(raw).unwrap();
    let gzip = gzip.finish().unwrap();
    let mut br = Vec::new();
    brotli::BrotliCompress(&mut &raw[..], &mut br, &Default::default()).unwrap();
    for (encoding, body) in [
        ("", raw.to_vec()),
        ("identity", raw.to_vec()),
        ("gzip", gzip),
        ("br", br),
    ] {
        let decoded = decode_models_body(encoding, Bytes::from(body)).unwrap();
        assert_eq!(decoded.as_ref(), raw, "{encoding}");
    }
    assert!(decode_models_body("zstd", Bytes::from_static(b"x")).is_err());
    assert!(decode_models_body("br", Bytes::from_static(b"not brotli")).is_err());
}

#[tokio::test]
async fn model_refresh_replaces_client_encoding_and_decodes_compressed_lists() {
    use std::io::Write as _;
    let temp = tempfile::tempdir().unwrap();
    let paths = paths(&temp);
    let official = MockServer::start().await;
    fs::create_dir_all(&paths.codex_home).unwrap();
    fs::write(
        paths.codex_config(),
        format!("openai_base_url='{}'\n", official.uri()),
    )
    .unwrap();
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
    let list = json!({"models":[{"slug":"gpt-compressed","context_window":500000}]});
    let mut gzip = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
    gzip.write_all(&serde_json::to_vec(&list).unwrap()).unwrap();
    Mock::given(method("GET"))
        .and(path("/models"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", "application/json")
                .insert_header("content-encoding", "gzip")
                .set_body_bytes(gzip.finish().unwrap()),
        )
        .mount(&official)
        .await;
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    // The official client advertises encodings this gateway cannot decode. A
    // low version keeps the process-wide newest version other tests assert.
    let response = client
        .get(format!("{base}/models?client_version=0.0.1"))
        .bearer_auth("official-secret")
        .header(header::ACCEPT_ENCODING, "gzip, deflate, br, zstd")
        .send()
        .await
        .unwrap();
    assert!(response.headers().get(header::CONTENT_ENCODING).is_none());
    let doc: Value = response.json().await.unwrap();
    assert!(
        doc["models"]
            .as_array()
            .unwrap()
            .iter()
            .any(|m| m["slug"] == "gpt-compressed")
    );
    let requests = official.received_requests().await.unwrap();
    let sent: Vec<_> = requests[0]
        .headers
        .get_all(header::ACCEPT_ENCODING)
        .iter()
        .map(|v| v.to_str().unwrap().to_string())
        .collect();
    assert_eq!(sent, vec![MODELS_ACCEPT_ENCODING.to_string()]);
    // The stored snapshot is plain JSON for later fallbacks.
    let stored = fs::read(paths.state_dir.join("official-models.json")).unwrap();
    assert!(serde_json::from_slice::<Value>(&stored).is_ok());
    let log = fs::read_to_string(paths.log_path()).unwrap_or_default();
    assert!(!log.contains("native.models.refresh_failed"));
    broker.shutdown().await;
}

#[tokio::test]
async fn fallback_shaped_pool_requests_never_leave_the_broker() {
    let temp = tempfile::tempdir().unwrap();
    let paths = paths(&temp);
    let upstream = MockServer::start().await;
    let mut broker = crate::broker::start_on_port(paths.clone(), 0)
        .await
        .unwrap();
    let mut config = DocumentMut::new();
    Settings::reconcile(&paths, &mut config, broker.port()).unwrap();
    let settings = Settings::load(&paths).unwrap().unwrap();
    fs::create_dir_all(&paths.codex_home).unwrap();
    fs::write(
        paths.codex_home.join("models_cache.json"),
        json!({"models":[{"slug":"gpt-x","context_window":500000,"tool_mode":"code_mode_only","supports_search_tool":true}]}).to_string(),
    )
    .unwrap();
    fs::write(paths.state_dir.join("subscription.json"), json!({"enabled":true,"accountOrder":["fake"],"models":[{"modelId":"gpt-x","visible":true}]}).to_string()).unwrap();
    let pool = crate::subscription::route_id("gpt-x");
    let native = format!("/native/{}/backend-api/codex", settings.capability);
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    for (endpoint, model) in [
        (format!("{native}/responses"), pool),
        ("/subscription/v1/responses".into(), "gpt-x".into()),
    ] {
        let response = client
            .post(format!("http://127.0.0.1:{}{endpoint}", broker.port()))
            .bearer_auth(broker.token())
            .json(&json!({"model":model,"input":[],"tools":[{"type":"function","name":"mcp__docs__read","parameters":{}}]}))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST, "{endpoint}");
        assert!(response.text().await.unwrap().contains("新建任务"));
    }
    assert!(upstream.received_requests().await.unwrap().is_empty());
    broker.shutdown().await;
}
