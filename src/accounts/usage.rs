use super::*;
use reqwest::{Method, StatusCode};
use serde::de::DeserializeOwned;

const QUERY_TIMEOUT: Duration = Duration::from_secs(25);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(8);

/// 一次按账户凭据访问官方 `wham` 接口的请求描述。
struct WhamRequest<'a> {
    method: Method,
    url: String,
    body: Option<&'a Value>,
    /// 中文动作名，用于错误提示（如“额度查询”）。
    label: &'static str,
    /// 只有幂等读取才在网络错误、5xx 时自动重试一次；
    /// 401 续期重试对所有请求都安全，因为服务端在鉴权阶段就已拒绝。
    retry_transient: bool,
}

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
        let request = WhamRequest {
            method: Method::GET,
            url: self.paths.usage_endpoint.clone(),
            body: None,
            label: "额度查询",
            retry_transient: true,
        };
        self.wham_json(record_id, client, refresh_url, request)
            .await
            .map_err(|error| match error.downcast::<serde_json::Error>() {
                Ok(_) => AccountError::InvalidUsage.into(),
                Err(error) => error,
            })
    }

    /// 读取任一已保存账户的额度重置卡列表；使用该账户自己的凭据，不切换当前账户。
    pub async fn fetch_reset_credits(&self, record_id: &str) -> anyhow::Result<Value> {
        validate_record_id(record_id)?;
        let client = crate::subscription::SubscriptionConfig::load(&self.paths)?.client()?;
        let request = WhamRequest {
            method: Method::GET,
            url: self.wham_url("rate-limit-reset-credits"),
            body: None,
            label: "重置卡查询",
            retry_transient: true,
        };
        self.wham_json(record_id, &client, REFRESH_URL, request)
            .await
    }

    /// 使用指定账户的一张重置卡。`redeem_request_id` 由页面生成，同一次尝试的重试必须复用，
    /// 服务端据此去重；因此这里不做传输层自动重试，避免与页面重试叠加。
    pub async fn consume_reset_credit(
        &self,
        record_id: &str,
        credit_id: Option<&str>,
        redeem_request_id: &str,
    ) -> anyhow::Result<Value> {
        validate_record_id(record_id)?;
        let client = crate::subscription::SubscriptionConfig::load(&self.paths)?.client()?;
        let body = serde_json::json!({
            "credit_id": credit_id,
            "redeem_request_id": redeem_request_id,
        });
        let request = WhamRequest {
            method: Method::POST,
            url: self.wham_url("rate-limit-reset-credits/consume"),
            body: Some(&body),
            label: "使用重置卡",
            retry_transient: false,
        };
        self.wham_json(record_id, &client, REFRESH_URL, request)
            .await
    }

    /// 与 usage 端点同源的其他 `wham` 接口地址（测试会把 usage 端点指向 mock 服务）。
    fn wham_url(&self, suffix: &str) -> String {
        let base = self
            .paths
            .usage_endpoint
            .strip_suffix("/usage")
            .unwrap_or(&self.paths.usage_endpoint);
        format!("{base}/{suffix}")
    }

    async fn wham_json<T: DeserializeOwned>(
        &self,
        record_id: &str,
        client: &reqwest::Client,
        refresh_url: &str,
        request: WhamRequest<'_>,
    ) -> anyhow::Result<T> {
        let label = request.label;
        tokio::time::timeout(QUERY_TIMEOUT, async {
            let mut credential = self
                .usage_credential(record_id, client, refresh_url, None)
                .await?;
            let mut renewed = false;
            let mut retried = false;
            loop {
                let mut builder = client
                    .request(request.method.clone(), &request.url)
                    .bearer_auth(&credential.access_token)
                    .header("chatgpt-account-id", &credential.account_id)
                    .header("accept", "application/json")
                    .timeout(REQUEST_TIMEOUT);
                if let Some(body) = request.body {
                    builder = builder.json(body);
                }
                let response = match builder.send().await {
                    Ok(response) => response,
                    Err(error) => {
                        if request.retry_transient
                            && !retried
                            && (error.is_timeout() || error.is_connect() || error.is_request())
                        {
                            retried = true;
                            tokio::time::sleep(Duration::from_millis(250)).await;
                            continue;
                        }
                        return Err(network_error(&error, label));
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
                if request.retry_transient
                    && !retried
                    && (status.is_server_error() || status == StatusCode::REQUEST_TIMEOUT)
                {
                    retried = true;
                    tokio::time::sleep(Duration::from_millis(250)).await;
                    continue;
                }
                if !status.is_success() {
                    let message = match status {
                        StatusCode::UNAUTHORIZED => {
                            "账户登录凭据已失效，请重新登录或导入新的 auth.json".to_string()
                        }
                        StatusCode::FORBIDDEN => {
                            format!("官方服务拒绝{label}，请检查账户权限和代理后重试")
                        }
                        StatusCode::TOO_MANY_REQUESTS => format!("{label}过于频繁，请稍后重试"),
                        StatusCode::NOT_FOUND => format!("该账户暂不支持{label}"),
                        _ => format!("官方{label}接口暂不可用，请稍后重试"),
                    };
                    anyhow::bail!("{message}（HTTP {}）", status.as_u16());
                }
                let bytes = match response.bytes().await {
                    Ok(bytes) => bytes,
                    Err(_) if request.retry_transient && !retried => {
                        retried = true;
                        tokio::time::sleep(Duration::from_millis(250)).await;
                        continue;
                    }
                    Err(error) => return Err(network_error(&error, label)),
                };
                return serde_json::from_slice::<T>(&bytes).map_err(anyhow::Error::from);
            }
        })
        .await
        .map_err(|_| anyhow::anyhow!("{label}超时，请检查网络或代理后重试"))?
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

fn network_error(error: &reqwest::Error, label: &str) -> anyhow::Error {
    if error.is_timeout() {
        anyhow::anyhow!("{label}超时，请检查网络或代理后重试")
    } else {
        anyhow::anyhow!("{label}网络请求失败，请检查网络或代理后重试")
    }
}
