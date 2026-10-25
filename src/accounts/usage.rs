use super::*;
use reqwest::StatusCode;

const REFRESH_URL: &str = "https://auth.openai.com/oauth/token";
const QUERY_TIMEOUT: Duration = Duration::from_secs(25);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(8);

impl AccountVault {
    pub async fn fetch_usage(&self, record_id: &str) -> anyhow::Result<Usage> {
        validate_record_id(record_id)?;
        // Quota reads do not enable the pool or consume conversation quota. Reuse
        // its explicit/environment/system proxy policy, including desktop launches.
        let client = crate::subscription::SubscriptionConfig::load(&self.paths)?.client()?;
        self.fetch_usage_with_client(record_id, &client, REFRESH_URL)
            .await
    }

    pub(crate) async fn fetch_usage_with_client(
        &self,
        record_id: &str,
        client: &reqwest::Client,
        refresh_url: &str,
    ) -> anyhow::Result<Usage> {
        tokio::time::timeout(QUERY_TIMEOUT, async {
            let mut credential = self
                .usage_credential(record_id, client, refresh_url, None)
                .await?;
            let mut renewed = false;
            let mut retried = false;
            loop {
                let response = client
                    .get(&self.paths.usage_endpoint)
                    .bearer_auth(&credential.access_token)
                    .header("chatgpt-account-id", &credential.account_id)
                    .header("accept", "application/json")
                    .timeout(REQUEST_TIMEOUT)
                    .send()
                    .await;
                let response = match response {
                    Ok(response) => response,
                    Err(error) => {
                        if !retried
                            && (error.is_timeout() || error.is_connect() || error.is_request())
                        {
                            retried = true;
                            tokio::time::sleep(Duration::from_millis(250)).await;
                            continue;
                        }
                        return Err(network_error(&error));
                    }
                };
                let status = response.status();
                if status == StatusCode::UNAUTHORIZED && !renewed {
                    // The existing vault transaction serializes refreshes and
                    // prefers current live auth; it never renews a live session.
                    credential = self
                        .usage_credential(
                            record_id,
                            client,
                            refresh_url,
                            Some(&credential.access_token),
                        )
                        .await?;
                    renewed = true;
                    continue;
                }
                if !retried && (status.is_server_error() || status == StatusCode::REQUEST_TIMEOUT) {
                    retried = true;
                    tokio::time::sleep(Duration::from_millis(250)).await;
                    continue;
                }
                if !status.is_success() {
                    let message = match status {
                        StatusCode::UNAUTHORIZED => {
                            "账户登录凭据已失效，请重新登录或导入新的 auth.json"
                        }
                        StatusCode::FORBIDDEN => "官方服务拒绝额度查询，请检查账户权限和代理后重试",
                        StatusCode::TOO_MANY_REQUESTS => "额度查询过于频繁，请稍后重试",
                        _ => "官方额度接口暂不可用，请稍后重试",
                    };
                    anyhow::bail!("{message}（HTTP {}）", status.as_u16());
                }
                match response.json::<Usage>().await {
                    Ok(usage) => return Ok(usage),
                    Err(error) if !error.is_decode() && !retried => {
                        retried = true;
                        tokio::time::sleep(Duration::from_millis(250)).await;
                    }
                    Err(error) if error.is_decode() => {
                        return Err(AccountError::InvalidUsage.into());
                    }
                    Err(error) => return Err(network_error(&error)),
                }
            }
        })
        .await
        .map_err(|_| anyhow::anyhow!("额度查询超时，请检查网络或代理后重试"))?
    }

    async fn usage_credential(
        &self,
        record_id: &str,
        client: &reqwest::Client,
        refresh_url: &str,
        rejected_token: Option<&str>,
    ) -> anyhow::Result<AccountCredential> {
        self.credential(record_id, client, refresh_url, rejected_token)
            .await
            .map_err(|error| {
                if matches!(
                    error.downcast_ref::<CredentialFailure>(),
                    Some(CredentialFailure::LiveExpired)
                ) {
                    anyhow::anyhow!("当前账户登录凭据已过期，请在官方 Codex 中重新登录后重试")
                } else {
                    error
                }
            })
    }
}

fn network_error(error: &reqwest::Error) -> anyhow::Error {
    if error.is_timeout() {
        anyhow::anyhow!("额度查询超时，请检查网络或代理后重试")
    } else {
        anyhow::anyhow!("额度查询网络请求失败，请检查网络或代理后重试")
    }
}
