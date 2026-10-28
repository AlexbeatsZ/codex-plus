use std::sync::Arc;

use anyhow::Context as _;
use serde_json::{Value, json};

use crate::accounts::{AccountPaths, AccountVault};
use crate::integrations::ApiIntegrations;
use crate::providers::{DiscoverRequest, SaveRequest};
use crate::subscription::SubscriptionConfig;

#[derive(Clone)]
pub struct BridgeService {
    paths: Arc<AccountPaths>,
    pub apis: ApiIntegrations,
}

impl BridgeService {
    pub fn new(paths: AccountPaths) -> Self {
        Self {
            apis: ApiIntegrations::new(paths.clone()),
            paths: Arc::new(paths),
        }
    }

    pub fn paths(&self) -> &AccountPaths {
        self.paths.as_ref()
    }

    pub async fn handle(&self, path: &str, payload: Value) -> Value {
        let result = match path {
            "/accounts/list" => self.list().await,
            "/accounts/usage" => self.usage(payload).await,
            "/accounts/import" => self.import(payload).await,
            "/accounts/delete" => self.delete(payload).await,
            "/accounts/switch" => self.switch(payload).await,
            "/accounts/web-login" => self.web_login().await,
            "/api-providers/subscription/get" => self.apis.subscription.view(),
            "/api-providers/subscription/save" => {
                match serde_json::from_value::<SubscriptionConfig>(payload) {
                    Ok(config) => self.apis.subscription.save(config),
                    Err(_) => Err(anyhow::anyhow!("账户池配置参数无效")),
                }
            }
            "/api-providers/subscription/discover" => {
                match serde_json::from_value::<SubscriptionConfig>(payload) {
                    Ok(config) => self.apis.subscription.discover(config).await,
                    Err(_) => Err(anyhow::anyhow!("账户池模型发现参数无效")),
                }
            }
            "/api-providers/list" => self.api_list().await,
            "/api-providers/discover" => self.api_discover(payload).await,
            "/api-providers/save" => self.api_save(payload).await,
            "/api-providers/delete" => self.api_delete(payload).await,
            "/api-providers/catalog" => self.api_catalog().await,
            _ => Err(anyhow::anyhow!("未知的 codex-plus 请求")),
        };
        match result {
            Ok(value) => value,
            Err(error) => {
                crate::runtime::append_log(
                    self.paths(),
                    "bridge.request.failed",
                    json!({"path": path, "message": error.to_string()}),
                );
                json!({"status": "failed", "message": error.to_string()})
            }
        }
    }

    async fn list(&self) -> anyhow::Result<Value> {
        let paths = self.paths.as_ref().clone();
        let accounts = tokio::task::spawn_blocking(move || {
            AccountVault::new(paths)
                .list_accounts()
                .map_err(anyhow::Error::from)
        })
        .await
        .context("账户读取任务失败")??;
        Ok(json!({"status": "ok", "accounts": accounts}))
    }

    async fn usage(&self, payload: Value) -> anyhow::Result<Value> {
        let record_id = required_record_id(&payload)?;
        let usage = self.apis.subscription.fetch_usage(&record_id).await?;
        Ok(json!({"status": "ok", "recordId": record_id, "usage": usage}))
    }

    async fn import(&self, payload: Value) -> anyhow::Result<Value> {
        let contents = payload
            .get("authContents")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| anyhow::anyhow!("请输入 auth.json 内容"))?
            .as_bytes()
            .to_vec();
        let paths = self.paths.as_ref().clone();
        let account = tokio::task::spawn_blocking(move || {
            AccountVault::new(paths)
                .import_auth(&contents)
                .map_err(anyhow::Error::from)
        })
        .await
        .context("账户导入任务失败")??;
        Ok(json!({"status": "ok", "account": account}))
    }

    async fn switch(&self, payload: Value) -> anyhow::Result<Value> {
        let record_id = required_record_id(&payload)?;
        let paths = self.paths.as_ref().clone();
        let validate_id = record_id.clone();
        tokio::task::spawn_blocking(move || {
            AccountVault::new(paths)
                .validate_switch(&validate_id)
                .map_err(anyhow::Error::from)
        })
        .await
        .context("账户切换验证任务失败")??;
        crate::runtime::queue_switch(self.paths(), &record_id)?;
        Ok(json!({
            "status": "accepted",
            "recordId": record_id,
            "message": "正在切换账户并重新启动 Codex…"
        }))
    }

    async fn delete(&self, payload: Value) -> anyhow::Result<Value> {
        let record_id = required_record_id(&payload)?;
        let paths = self.paths.as_ref().clone();
        let delete_id = record_id.clone();
        tokio::task::spawn_blocking(move || {
            AccountVault::new(paths)
                .delete_account(&delete_id)
                .map_err(anyhow::Error::from)
        })
        .await
        .context("账户删除任务失败")??;
        Ok(json!({"status": "ok", "recordId": record_id}))
    }

    async fn web_login(&self) -> anyhow::Result<Value> {
        let paths = self.paths.as_ref().clone();
        tokio::task::spawn_blocking(move || {
            AccountVault::new(paths)
                .validate_web_login()
                .map_err(anyhow::Error::from)
        })
        .await
        .context("网页登录验证任务失败")??;
        crate::runtime::queue_web_login(self.paths())?;
        Ok(json!({
            "status": "accepted",
            "message": "正在保存当前账户并重新启动到登录页面…"
        }))
    }

    async fn api_list(&self) -> anyhow::Result<Value> {
        Ok(json!({"status":"ok", "providers":self.apis.list()?}))
    }

    async fn api_discover(&self, payload: Value) -> anyhow::Result<Value> {
        let request: DiscoverRequest =
            serde_json::from_value(payload).context("模型发现参数无效")?;
        self.apis.discover_external(request).await
    }

    async fn api_save(&self, payload: Value) -> anyhow::Result<Value> {
        let request: SaveRequest = serde_json::from_value(payload).context("API 保存参数无效")?;
        let providers = self.apis.save_external(request)?;
        Ok(json!({"status":"ok", "providers":providers}))
    }

    async fn api_delete(&self, payload: Value) -> anyhow::Result<Value> {
        let id = required_provider_id(&payload)?;
        let providers = self.apis.delete_external(&id)?;
        Ok(json!({"status":"ok", "providers":providers}))
    }

    async fn api_catalog(&self) -> anyhow::Result<Value> {
        Ok(json!({"status":"ok", "models":self.apis.catalog()?}))
    }
}

fn required_record_id(payload: &Value) -> anyhow::Result<String> {
    let value = payload
        .get("recordId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| anyhow::anyhow!("缺少账户记录 ID"))?;
    if value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        anyhow::bail!("账户记录 ID 无效");
    }
    Ok(value.to_string())
}

fn required_provider_id(payload: &Value) -> anyhow::Result<String> {
    let id = payload
        .get("providerId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .ok_or_else(|| anyhow::anyhow!("缺少 API ID"))?;
    if id.len() > 80 || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        anyhow::bail!("API ID 无效");
    }
    Ok(id.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_are_strictly_validated() {
        assert!(required_record_id(&json!({"recordId": "a".repeat(64)})).is_ok());
        assert!(required_record_id(&json!({"recordId": ""})).is_err());
        assert!(required_record_id(&json!({"recordId": "bad\nvalue"})).is_err());
    }
}
