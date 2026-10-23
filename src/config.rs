use std::fs;

use anyhow::Context as _;
use toml_edit::{DocumentMut, Item, Table, value};

use crate::accounts::{AccountPaths, atomic_write};

pub const BROKER_PROVIDER_ID: &str = "codex-plus-api";
pub const POOL_PROVIDER_ID: &str = "codex-plus-account-pool";
pub const BROKER_TOKEN: &str = "codex-plus-loopback";

pub fn reconcile_codex_config(paths: &AccountPaths, port: u16) -> anyhow::Result<()> {
    let path = paths.codex_config();
    let original = match fs::read_to_string(&path) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(error) => return Err(error).context("无法读取 Codex config.toml"),
    };
    let mut document = if original.trim().is_empty() {
        DocumentMut::new()
    } else {
        original
            .parse::<DocumentMut>()
            .context("Codex config.toml 无效")?
    };
    if !document.as_table().contains_key("model_providers") {
        document["model_providers"] = Item::Table(Table::new());
    }
    let providers = document["model_providers"]
        .as_table_mut()
        .context("model_providers 不是 TOML 表")?;
    let mut managed = Table::new();
    managed.set_implicit(false);
    managed["name"] = value("codex-plus API broker");
    managed["base_url"] = value(format!("http://127.0.0.1:{port}/v1"));
    managed["wire_api"] = value("responses");
    managed["experimental_bearer_token"] = value(BROKER_TOKEN);
    providers[BROKER_PROVIDER_ID] = Item::Table(managed);
    let mut pool = Table::new();
    pool["name"] = value("codex-plus ChatGPT account pool");
    pool["base_url"] = value(format!("http://127.0.0.1:{port}/v1"));
    pool["wire_api"] = value("responses");
    pool["experimental_bearer_token"] = value(BROKER_TOKEN);
    pool["requires_openai_auth"] = value(false);
    pool["supports_websockets"] = value(false);
    pool["capabilities"]["remote_compaction"] = value("v2");
    providers[POOL_PROVIDER_ID] = Item::Table(pool);
    let rendered = document.to_string();
    if rendered == original {
        return Ok(());
    }

    if !original.is_empty() {
        let backup = path.with_file_name("config.toml.codex-plus.bak");
        if !backup.exists() {
            atomic_write(&backup, original.as_bytes())
                .map_err(anyhow::Error::from)
                .context("无法备份 Codex 配置")?;
        }
    }
    atomic_write(&path, rendered.as_bytes())
        .map_err(anyhow::Error::from)
        .context("无法更新 Codex provider 配置")
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn preserves_unmanaged_config_and_top_level_provider() {
        let temp = TempDir::new().unwrap();
        let paths = AccountPaths {
            codex_home: temp.path().join("codex"),
            state_dir: temp.path().join("state"),
            usage_endpoint: String::new(),
        };
        fs::create_dir_all(&paths.codex_home).unwrap();
        fs::write(paths.codex_config(), "model = \"official\"\nmodel_provider = \"openai\"\n[features]\nfoo = true\n[model_providers.other]\nbase_url = \"https://example.test\"\n").unwrap();
        reconcile_codex_config(&paths, 57321).unwrap();
        let output = fs::read_to_string(paths.codex_config()).unwrap();
        assert!(output.contains("model_provider = \"openai\""));
        assert!(output.contains("[model_providers.other]"));
        assert!(output.contains("[model_providers.codex-plus-api]"));
        let config: DocumentMut = output.parse().unwrap();
        assert_eq!(
            config["model_providers"][POOL_PROVIDER_ID]["capabilities"]["remote_compaction"]
                .as_str(),
            Some("v2")
        );
        assert!(
            config["model_providers"][BROKER_PROVIDER_ID]
                .get("capabilities")
                .is_none()
        );
        assert!(output.contains("wire_api = \"responses\""));
        assert!(output.contains("base_url = \"http://127.0.0.1:57321/v1\""));
        assert!(paths.codex_home.join("config.toml.codex-plus.bak").exists());
    }
}
