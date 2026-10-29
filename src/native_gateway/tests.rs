use super::*;
use crate::providers::{ProviderStore, SaveRequest};
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

fn paths(temp: &tempfile::TempDir) -> AccountPaths {
    AccountPaths {
        codex_home: temp.path().join("home"),
        state_dir: temp.path().join("state"),
        usage_endpoint: String::new(),
    }
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
    for name in ["one", "two"] {
        let request: SaveRequest = serde_json::from_value(json!({"name":name,"baseUrl":"https://example.test/v1","apiKey":"PRIVATE","protocol":"responses","enabled":true,"models":[{"modelId":"known","displayName":"alias","visible":true},{"modelId":"unknown","visible":true}]})).unwrap();
        store.upsert(request).unwrap();
    }
    store.save(&paths).unwrap();
    let apis = ApiIntegrations::new(paths.clone());
    let settings = Settings::load(&paths).unwrap().unwrap();
    let result = catalog(&paths, &apis, &settings).unwrap();
    let models = result["models"].as_array().unwrap();
    assert_eq!(models.len(), 5);
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
        2
    );
    assert!(models[1..].iter().all(|m| m["use_responses_lite"] == false));
    assert!(
        apis.catalog()
            .unwrap()
            .iter()
            .all(|m| m.native_provider_id == "openai")
    );
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
    remember_route(&paths, &a, "codex-auto-review", false).unwrap();
    assert_eq!(remember_route(&paths, &a, "real", true).unwrap(), "cp-api");
    assert_eq!(remember_route(&paths, &b, "real", true).unwrap(), "real");
    remember_route(&paths, &a, "official", false).unwrap();
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
    store.upsert(serde_json::from_value(json!({"name":"external","baseUrl":external.uri(),"apiKey":"external-secret","protocol":"responses","enabled":true,"models":[{"modelId":"same","visible":true}]})).unwrap()).unwrap();
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
    assert_eq!(send(route.clone()).await.unwrap().status(), StatusCode::OK);
    assert_eq!(
        send("codex-auto-review".into()).await.unwrap().status(),
        StatusCode::OK
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
