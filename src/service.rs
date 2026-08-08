use std::sync::Arc;

use anyhow::Context as _;
use serde_json::{Value, json};

use crate::accounts::{AccountPaths, AccountVault};

#[derive(Clone)]
pub struct AccountService {
    paths: Arc<AccountPaths>,
}

impl AccountService {
    pub fn new(paths: AccountPaths) -> Self {
        Self {
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
            "/accounts/switch" => self.switch(payload).await,
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
        let account_id = required_id(&payload)?;
        let usage = AccountVault::new(self.paths.as_ref().clone())
            .fetch_usage(&account_id)
            .await?;
        Ok(json!({"status": "ok", "accountId": account_id, "usage": usage}))
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
        let account_id = required_id(&payload)?;
        let paths = self.paths.as_ref().clone();
        let validate_id = account_id.clone();
        tokio::task::spawn_blocking(move || {
            AccountVault::new(paths)
                .validate_switch(&validate_id)
                .map_err(anyhow::Error::from)
        })
        .await
        .context("账户切换验证任务失败")??;
        crate::runtime::queue_switch(self.paths(), &account_id)?;
        Ok(json!({
            "status": "accepted",
            "accountId": account_id,
            "message": "正在切换账户并重新启动 Codex…"
        }))
    }
}

fn required_id(payload: &Value) -> anyhow::Result<String> {
    let value = payload
        .get("accountId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| anyhow::anyhow!("缺少账户 ID"))?;
    if value.len() > 512 || value.chars().any(char::is_control) {
        anyhow::bail!("账户 ID 无效");
    }
    Ok(value.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_are_strictly_validated() {
        assert!(required_id(&json!({"accountId": "account"})).is_ok());
        assert!(required_id(&json!({"accountId": ""})).is_err());
        assert!(required_id(&json!({"accountId": "bad\nvalue"})).is_err());
    }
}
