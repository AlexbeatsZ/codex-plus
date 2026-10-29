use super::*;

pub(crate) fn unix_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

#[derive(Debug, thiserror::Error)]
pub(crate) enum CredentialFailure {
    #[error("账户凭据已失效，请重新导入或登录")]
    Rejected(String),
    #[error("当前登录会话等待官方客户端更新凭据")]
    LiveExpired,
}

// Deliberately no Debug/Serialize: credentials never cross the renderer bridge.
pub(crate) struct AccountCredential {
    pub access_token: String,
    pub account_id: String,
    pub revision: String,
}

impl AccountVault {
    pub(crate) fn live_credential(&self) -> Result<Option<AccountCredential>> {
        read_live_chatgpt(&self.paths.live_auth()).map(|auth| {
            auth.map(|auth| AccountCredential {
                revision: credential_revision(&auth),
                access_token: auth.access_token,
                account_id: auth.account_id,
            })
        })
    }
    pub(super) fn credential_lock(&self, id: &str) -> Result<File> {
        validate_record_id(id)?;
        ensure_vault_dir(&self.paths.accounts_dir())?;
        let guard = File::options()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(
                self.paths
                    .accounts_dir()
                    .join(format!(".refresh-{id}.lock")),
            )?;
        guard.lock_exclusive()?;
        Ok(guard)
    }

    pub(crate) fn credential_revision(&self, id: &str) -> Result<String> {
        let _guard = self.lock_vault()?;
        let auth = read_live_chatgpt(&self.paths.live_auth())?
            .filter(|a| a.record_id == id)
            .map(Ok)
            .unwrap_or_else(|| self.load_unlocked(id))?;
        Ok(credential_revision(&auth))
    }
    pub(crate) async fn credential(
        &self,
        record_id: &str,
        client: &reqwest::Client,
        refresh_endpoint: &str,
        rejected_token: Option<&str>,
    ) -> anyhow::Result<AccountCredential> {
        validate_record_id(record_id)?;
        let paths = self.paths.clone();
        let id = record_id.to_string();
        // A separate lock serializes renewals without holding the CRUD vault lock
        // during network IO. Acquire blocking filesystem locks off the async worker.
        let (auth, live, _refresh_guard) =
            tokio::task::spawn_blocking(move || -> anyhow::Result<_> {
                let vault = Self::new(paths);
                let guard = vault.credential_lock(&id)?;
                let _vault_guard = vault.lock_vault()?;
                let current = read_live_chatgpt(&vault.paths.live_auth())?;
                if let Some(current) = current.filter(|a| a.record_id == id) {
                    Ok((current, true, guard))
                } else {
                    Ok((vault.load_unlocked(&id)?, false, guard))
                }
            })
            .await??;
        let claims = parse_jwt_claims(&auth.access_token).unwrap_or(Value::Null);
        let expired = claims
            .get("exp")
            .and_then(Value::as_u64)
            .is_some_and(|exp| exp <= unix_now() + 60);
        let revision = credential_revision(&auth);
        if !expired && rejected_token.is_none_or(|old| old != auth.access_token) {
            return Ok(AccountCredential {
                revision,
                access_token: auth.access_token,
                account_id: auth.account_id,
            });
        }
        if live {
            return Err(CredentialFailure::LiveExpired.into());
        }
        let mut raw: Value = serde_json::from_slice(&auth.raw)?;
        let old_refresh = raw["tokens"]["refresh_token"]
            .as_str()
            .unwrap_or("")
            .to_string();
        let client_id = claims
            .get("client_id")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
            .ok_or_else(|| CredentialFailure::Rejected(revision.clone()))?;
        let response = client.post(refresh_endpoint).timeout(Duration::from_secs(20))
            .json(&serde_json::json!({"grant_type":"refresh_token", "refresh_token":old_refresh, "client_id":client_id}))
            .send().await.map_err(|_| anyhow::anyhow!("账户凭据续期网络请求失败"))?;
        if !response.status().is_success() {
            let status = response.status();
            let value = response.json::<Value>().await.unwrap_or(Value::Null);
            let code = value["error"]
                .as_str()
                .or_else(|| value.pointer("/error/code").and_then(Value::as_str))
                .unwrap_or("");
            if status == reqwest::StatusCode::UNAUTHORIZED
                || matches!(
                    code,
                    "invalid_grant"
                        | "invalid_client"
                        | "invalid_refresh_token"
                        | "refresh_token_expired"
                        | "refresh_token_reused"
                        | "refresh_token_invalidated"
                )
            {
                return Err(CredentialFailure::Rejected(revision).into());
            }
            anyhow::bail!("账户凭据续期失败（HTTP {}），请重新登录", status.as_u16());
        }
        let renewed: Value = response
            .json()
            .await
            .map_err(|_| anyhow::anyhow!("账户续期响应无效"))?;
        for field in ["access_token", "refresh_token"] {
            let token = renewed[field]
                .as_str()
                .filter(|s| !s.is_empty())
                .ok_or_else(|| anyhow::anyhow!("账户续期响应缺少必要凭据"))?;
            raw["tokens"][field] = Value::String(token.to_string());
        }
        if let Some(id_token) = renewed["id_token"].as_str().filter(|s| !s.is_empty()) {
            raw["tokens"]["id_token"] = Value::String(id_token.to_string());
        }
        let updated = parse_auth(&serde_json::to_vec(&raw)?)?;
        if updated.record_id != record_id {
            anyhow::bail!("账户续期返回了不同席位，已拒绝替换凭据");
        }
        let paths = self.paths.clone();
        tokio::task::spawn_blocking(move || -> anyhow::Result<_> {
            let vault = Self::new(paths);
            let _guard = vault.lock_vault()?;
            if read_live_chatgpt(&vault.paths.live_auth())?
                .is_some_and(|a| a.record_id == updated.record_id)
            {
                anyhow::bail!("账户在续期期间成为当前登录账户，已停止写入");
            }
            let existing = vault.load_unlocked(&updated.record_id)?;
            let previous: Value = serde_json::from_slice(&existing.raw)?;
            if previous["tokens"]["refresh_token"].as_str() != Some(&old_refresh) {
                anyhow::bail!("账户凭据已在其他进程更新，请重试");
            }
            vault.store_unlocked(&updated)?;
            Ok(AccountCredential {
                revision: credential_revision(&updated),
                access_token: updated.access_token,
                account_id: updated.account_id,
            })
        })
        .await?
    }
}

fn credential_revision(auth: &AuthDocument) -> String {
    // Generation changes only when actual credentials change, not metadata or ordering.
    let mut hash = Sha256::new();
    hash.update(&auth.access_token);
    if let Ok(raw) = serde_json::from_slice::<Value>(&auth.raw) {
        hash.update(raw["tokens"]["refresh_token"].as_str().unwrap_or(""));
    }
    format!("{:x}", hash.finalize())
}
