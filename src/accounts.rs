use std::fs::{self, File};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

use base64::Engine as _;
use fs2::FileExt as _;
use reqwest::header::{ACCEPT, AUTHORIZATION, HeaderMap, HeaderValue};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use thiserror::Error;
use uuid::Uuid;

const MAX_AUTH_BYTES: usize = 2 * 1024 * 1024;
const DEFAULT_USAGE_ENDPOINT: &str = "https://chatgpt.com/backend-api/wham/usage";

#[derive(Debug, Error)]
pub enum AccountError {
    #[error("auth.json 不是有效的 JSON 对象")]
    InvalidJson,
    #[error("auth.json 不是 ChatGPT 登录凭据")]
    NotChatGpt,
    #[error("auth.json 缺少字段：{0}")]
    MissingField(&'static str),
    #[error("auth.json 大小无效")]
    InvalidSize,
    #[error("账户不存在")]
    NotFound,
    #[error("账户存储目录不安全")]
    UnsafeVault,
    #[error("Codex 当前使用 {0} 保存凭据，无法通过 auth.json 切换账户")]
    UnsupportedCredentialStore(String),
    #[error("Codex config.toml 无效")]
    InvalidConfig,
    #[error("额度接口返回 HTTP {0}")]
    UsageStatus(u16),
    #[error("额度响应无效")]
    InvalidUsage,
    #[error("网络请求失败")]
    Network,
    #[error("文件操作失败：{0}")]
    Io(#[from] io::Error),
}

pub type Result<T> = std::result::Result<T, AccountError>;

#[derive(Debug, Clone)]
pub struct AccountPaths {
    pub codex_home: PathBuf,
    pub state_dir: PathBuf,
    pub usage_endpoint: String,
}

impl AccountPaths {
    pub fn discover() -> anyhow::Result<Self> {
        let codex_home = std::env::var_os("CODEX_HOME")
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .or_else(|| {
                std::env::var_os("USERPROFILE")
                    .filter(|value| !value.is_empty())
                    .map(|value| PathBuf::from(value).join(".codex"))
            })
            .ok_or_else(|| anyhow::anyhow!("无法定位 Codex 用户目录"))?;
        let state_dir = std::env::var_os("LOCALAPPDATA")
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .ok_or_else(|| anyhow::anyhow!("无法定位 LOCALAPPDATA"))?
            .join("codex-plus");
        Ok(Self {
            codex_home,
            state_dir,
            usage_endpoint: DEFAULT_USAGE_ENDPOINT.to_string(),
        })
    }

    pub fn live_auth(&self) -> PathBuf {
        self.codex_home.join("auth.json")
    }

    pub fn codex_config(&self) -> PathBuf {
        self.codex_home.join("config.toml")
    }

    pub fn accounts_dir(&self) -> PathBuf {
        self.state_dir.join("accounts")
    }

    pub fn pending_action(&self) -> PathBuf {
        self.state_dir.join("pending-action.json")
    }

    pub fn launcher_lock(&self) -> PathBuf {
        self.state_dir.join("launcher.lock")
    }

    pub fn log_path(&self) -> PathBuf {
        self.state_dir.join("codex-plus.log")
    }

    pub fn providers_path(&self) -> PathBuf {
        self.state_dir.join("providers.json")
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AccountSummary {
    pub account_id: String,
    pub email: Option<String>,
    pub name: Option<String>,
    pub plan: Option<String>,
    pub last_refresh: Option<String>,
    pub active: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Usage {
    #[serde(default)]
    pub plan_type: Option<String>,
    #[serde(default)]
    pub rate_limit: Option<RateLimit>,
    #[serde(default)]
    pub credits: Option<Credits>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RateLimit {
    #[serde(default)]
    pub allowed: Option<bool>,
    #[serde(default)]
    pub limit_reached: Option<bool>,
    #[serde(default)]
    pub primary_window: Option<UsageWindow>,
    #[serde(default)]
    pub secondary_window: Option<UsageWindow>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct UsageWindow {
    #[serde(default)]
    pub used_percent: Option<f64>,
    #[serde(default)]
    pub limit_window_seconds: Option<u64>,
    #[serde(default)]
    pub reset_after_seconds: Option<u64>,
    #[serde(default)]
    pub reset_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Credits {
    #[serde(default)]
    pub has_credits: Option<bool>,
    #[serde(default)]
    pub unlimited: Option<bool>,
    #[serde(default)]
    pub balance: Option<Value>,
}

#[derive(Debug, Clone)]
struct AuthDocument {
    raw: Vec<u8>,
    account_id: String,
    access_token: String,
    email: Option<String>,
    name: Option<String>,
    plan: Option<String>,
    last_refresh: Option<String>,
}

impl AuthDocument {
    fn summary(&self, active: bool) -> AccountSummary {
        AccountSummary {
            account_id: self.account_id.clone(),
            email: self.email.clone(),
            name: self.name.clone(),
            plan: self.plan.clone(),
            last_refresh: self.last_refresh.clone(),
            active,
        }
    }
}

pub struct AccountVault {
    paths: AccountPaths,
}

impl AccountVault {
    pub fn new(paths: AccountPaths) -> Self {
        Self { paths }
    }

    #[cfg(test)]
    pub fn paths(&self) -> &AccountPaths {
        &self.paths
    }

    pub fn list_accounts(&self) -> Result<Vec<AccountSummary>> {
        let _guard = self.lock_vault()?;
        self.snapshot_live_unlocked()?;
        self.list_unlocked()
    }

    pub fn import_auth(&self, contents: &[u8]) -> Result<AccountSummary> {
        let auth = parse_auth(contents)?;
        let _guard = self.lock_vault()?;
        let active = read_live_chatgpt(&self.paths.live_auth())?
            .is_some_and(|current| current.account_id == auth.account_id);
        self.store_unlocked(&auth)?;
        Ok(auth.summary(active))
    }

    pub fn validate_switch(&self, account_id: &str) -> Result<()> {
        validate_identifier(account_id)?;
        validate_credential_storage(&self.paths.codex_config())?;
        let _guard = self.lock_vault()?;
        self.load_unlocked(account_id).map(|_| ())
    }

    pub fn switch_after_shutdown(&self, account_id: &str) -> Result<AccountSummary> {
        validate_identifier(account_id)?;
        validate_credential_storage(&self.paths.codex_config())?;
        let _guard = self.lock_vault()?;
        let target = self.load_unlocked(account_id)?;
        self.snapshot_live_unlocked()?;
        atomic_write(&self.paths.live_auth(), &target.raw)?;
        Ok(target.summary(true))
    }

    pub async fn fetch_usage(&self, account_id: &str) -> Result<Usage> {
        validate_identifier(account_id)?;
        let auth = {
            let _guard = self.lock_vault()?;
            self.load_unlocked(account_id)?
        };
        let mut headers = HeaderMap::new();
        headers.insert(
            AUTHORIZATION,
            HeaderValue::from_str(&format!("Bearer {}", auth.access_token))
                .map_err(|_| AccountError::Network)?,
        );
        headers.insert(
            "chatgpt-account-id",
            HeaderValue::from_str(&auth.account_id).map_err(|_| AccountError::Network)?,
        );
        headers.insert(ACCEPT, HeaderValue::from_static("application/json"));
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(10))
            .build()
            .map_err(|_| AccountError::Network)?;
        let response = client
            .get(&self.paths.usage_endpoint)
            .headers(headers)
            .send()
            .await
            .map_err(|_| AccountError::Network)?;
        if !response.status().is_success() {
            return Err(AccountError::UsageStatus(response.status().as_u16()));
        }
        response
            .json::<Usage>()
            .await
            .map_err(|_| AccountError::InvalidUsage)
    }

    fn snapshot_live_unlocked(&self) -> Result<()> {
        if let Some(current) = read_live_chatgpt(&self.paths.live_auth())? {
            self.store_unlocked(&current)?;
        }
        Ok(())
    }

    fn list_unlocked(&self) -> Result<Vec<AccountSummary>> {
        let active = read_live_chatgpt(&self.paths.live_auth())?.map(|auth| auth.account_id);
        let dir = self.paths.accounts_dir();
        ensure_vault_dir(&dir)?;
        let mut accounts = Vec::new();
        for entry in fs::read_dir(&dir)? {
            let entry = entry?;
            if !entry.file_type()?.is_file()
                || entry.path().extension().and_then(|value| value.to_str()) != Some("json")
            {
                continue;
            }
            let auth = parse_auth(&fs::read(entry.path())?)?;
            if entry.file_name().to_string_lossy() != account_filename(&auth.account_id) {
                return Err(AccountError::UnsafeVault);
            }
            accounts.push(auth.summary(active.as_deref() == Some(&auth.account_id)));
        }
        accounts.sort_by(|left, right| {
            right.active.cmp(&left.active).then_with(|| {
                left.email
                    .as_deref()
                    .unwrap_or(&left.account_id)
                    .cmp(right.email.as_deref().unwrap_or(&right.account_id))
            })
        });
        Ok(accounts)
    }

    fn store_unlocked(&self, auth: &AuthDocument) -> Result<()> {
        let dir = self.paths.accounts_dir();
        ensure_vault_dir(&dir)?;
        atomic_write(&dir.join(account_filename(&auth.account_id)), &auth.raw)
    }

    fn load_unlocked(&self, account_id: &str) -> Result<AuthDocument> {
        let path = self.paths.accounts_dir().join(account_filename(account_id));
        let raw = match fs::read(path) {
            Ok(raw) => raw,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                return Err(AccountError::NotFound);
            }
            Err(error) => return Err(error.into()),
        };
        let auth = parse_auth(&raw)?;
        if auth.account_id != account_id {
            return Err(AccountError::UnsafeVault);
        }
        Ok(auth)
    }

    fn lock_vault(&self) -> Result<File> {
        ensure_vault_dir(&self.paths.accounts_dir())?;
        let lock = File::options()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(self.paths.accounts_dir().join(".lock"))?;
        lock.lock_exclusive()?;
        Ok(lock)
    }
}

pub fn read_optional_file(path: &Path) -> io::Result<Option<Vec<u8>>> {
    match fs::read(path) {
        Ok(value) => Ok(Some(value)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

pub fn restore_optional_file(path: &Path, contents: Option<&[u8]>) -> Result<()> {
    match contents {
        Some(contents) => atomic_write(path, contents),
        None => match fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error.into()),
        },
    }
}

pub fn atomic_write(path: &Path, contents: &[u8]) -> Result<()> {
    let parent = path.parent().ok_or(AccountError::UnsafeVault)?;
    fs::create_dir_all(parent)?;
    let temp = parent.join(format!(".codex-plus-{}.tmp", Uuid::new_v4()));
    let result = (|| -> io::Result<()> {
        let mut file = File::options().create_new(true).write(true).open(&temp)?;
        file.write_all(contents)?;
        file.sync_all()?;
        replace_file(&temp, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result.map_err(Into::into)
}

#[cfg(windows)]
fn replace_file(source: &Path, target: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt as _;
    use windows::Win32::Storage::FileSystem::{
        MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, MoveFileExW,
    };
    use windows::core::PCWSTR;

    let source = source
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let target = target
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    unsafe {
        MoveFileExW(
            PCWSTR(source.as_ptr()),
            PCWSTR(target.as_ptr()),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
        .map_err(|error| io::Error::other(error.to_string()))
    }
}

#[cfg(not(windows))]
fn replace_file(source: &Path, target: &Path) -> io::Result<()> {
    if target.exists() {
        fs::remove_file(target)?;
    }
    fs::rename(source, target)
}

fn parse_auth(raw: &[u8]) -> Result<AuthDocument> {
    if raw.is_empty() || raw.len() > MAX_AUTH_BYTES {
        return Err(AccountError::InvalidSize);
    }
    let value: Value = serde_json::from_slice(raw).map_err(|_| AccountError::InvalidJson)?;
    let object = value.as_object().ok_or(AccountError::InvalidJson)?;
    if object.get("auth_mode").and_then(Value::as_str) != Some("chatgpt") {
        return Err(AccountError::NotChatGpt);
    }
    let tokens = object
        .get("tokens")
        .and_then(Value::as_object)
        .ok_or(AccountError::MissingField("tokens"))?;
    let id_token = required_string(tokens.get("id_token"), "tokens.id_token")?;
    let access_token = required_string(tokens.get("access_token"), "tokens.access_token")?;
    required_string(tokens.get("refresh_token"), "tokens.refresh_token")?;
    let account_id = required_string(tokens.get("account_id"), "tokens.account_id")?;
    validate_identifier(account_id)?;
    let claims = parse_jwt_claims(id_token);
    let auth_claims = claims
        .as_ref()
        .and_then(|claims| claims.get("https://api.openai.com/auth"));
    Ok(AuthDocument {
        raw: raw.to_vec(),
        account_id: account_id.to_string(),
        access_token: access_token.to_string(),
        email: claims
            .as_ref()
            .and_then(|claims| claims.get("email"))
            .and_then(Value::as_str)
            .map(str::to_string),
        name: claims
            .as_ref()
            .and_then(|claims| claims.get("name"))
            .and_then(Value::as_str)
            .map(str::to_string),
        plan: auth_claims
            .and_then(|claims| claims.get("chatgpt_plan_type"))
            .and_then(Value::as_str)
            .map(str::to_string),
        last_refresh: object
            .get("last_refresh")
            .and_then(Value::as_str)
            .map(str::to_string),
    })
}

fn read_live_chatgpt(path: &Path) -> Result<Option<AuthDocument>> {
    let raw = match fs::read(path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    let value: Value = serde_json::from_slice(&raw).map_err(|_| AccountError::InvalidJson)?;
    if value.get("auth_mode").and_then(Value::as_str) != Some("chatgpt") {
        return Ok(None);
    }
    parse_auth(&raw).map(Some)
}

fn required_string<'a>(value: Option<&'a Value>, field: &'static str) -> Result<&'a str> {
    value
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or(AccountError::MissingField(field))
}

fn validate_identifier(value: &str) -> Result<()> {
    if value.trim().is_empty() || value.len() > 512 || value.chars().any(char::is_control) {
        return Err(AccountError::MissingField("tokens.account_id"));
    }
    Ok(())
}

fn parse_jwt_claims(token: &str) -> Option<Value> {
    let payload = token.split('.').nth(1)?;
    let decoded = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload)
        .ok()
        .or_else(|| {
            base64::engine::general_purpose::URL_SAFE
                .decode(payload)
                .ok()
        })?;
    serde_json::from_slice(&decoded).ok()
}

fn account_filename(account_id: &str) -> String {
    format!("{:x}.json", Sha256::digest(account_id.as_bytes()))
}

fn validate_credential_storage(path: &Path) -> Result<()> {
    let text = match fs::read_to_string(path) {
        Ok(text) => text,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    };
    let config: toml::Value = text.parse().map_err(|_| AccountError::InvalidConfig)?;
    let Some(mode) = config.get("cli_auth_credentials_store") else {
        return Ok(());
    };
    let mode = mode.as_str().ok_or(AccountError::InvalidConfig)?;
    if mode.eq_ignore_ascii_case("file") {
        Ok(())
    } else {
        Err(AccountError::UnsupportedCredentialStore(mode.to_string()))
    }
}

fn ensure_vault_dir(path: &Path) -> Result<()> {
    fs::create_dir_all(path)?;
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(AccountError::UnsafeVault);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt as _;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(AccountError::UnsafeVault);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tempfile::TempDir;
    use wiremock::matchers::{header, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn jwt(email: &str, name: &str) -> String {
        let claims = json!({
            "email": email,
            "name": name,
            "https://api.openai.com/auth": {"chatgpt_plan_type": "plus"}
        });
        let payload = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(serde_json::to_vec(&claims).unwrap());
        format!("header.{payload}.signature")
    }

    fn auth(account_id: &str, token: &str, email: &str) -> Vec<u8> {
        serde_json::to_vec(&json!({
            "auth_mode": "chatgpt",
            "last_refresh": "2026-08-08T00:00:00Z",
            "tokens": {
                "id_token": jwt(email, "Tester"),
                "access_token": token,
                "refresh_token": "refresh-secret",
                "account_id": account_id
            }
        }))
        .unwrap()
    }

    fn fixture() -> (TempDir, AccountVault) {
        let temp = tempfile::tempdir().unwrap();
        let paths = AccountPaths {
            codex_home: temp.path().join("home"),
            state_dir: temp.path().join("state"),
            usage_endpoint: DEFAULT_USAGE_ENDPOINT.to_string(),
        };
        fs::create_dir_all(&paths.codex_home).unwrap();
        (temp, AccountVault::new(paths))
    }

    #[test]
    fn import_deduplicates_by_account_and_never_uses_identifier_as_filename() {
        let (_temp, vault) = fixture();
        let first = vault
            .import_auth(&auth("../../account", "token-1", "one@example.com"))
            .unwrap();
        vault
            .import_auth(&auth("../../account", "token-2", "two@example.com"))
            .unwrap();
        let accounts = vault.list_accounts().unwrap();
        assert_eq!(first.account_id, "../../account");
        assert_eq!(accounts.len(), 1);
        assert_eq!(accounts[0].email.as_deref(), Some("two@example.com"));
        assert!(
            fs::read_dir(vault.paths().accounts_dir())
                .unwrap()
                .filter_map(std::result::Result::ok)
                .filter(|entry| entry.path().extension().and_then(|v| v.to_str()) == Some("json"))
                .all(|entry| !entry.file_name().to_string_lossy().contains("account"))
        );
    }

    #[test]
    fn listing_snapshots_and_marks_the_live_account() {
        let (_temp, vault) = fixture();
        atomic_write(
            &vault.paths().live_auth(),
            &auth("live", "live-token", "live@example.com"),
        )
        .unwrap();
        let accounts = vault.list_accounts().unwrap();
        assert_eq!(accounts.len(), 1);
        assert!(accounts[0].active);
        assert_eq!(accounts[0].account_id, "live");
    }

    #[test]
    fn invalid_documents_are_rejected_without_creating_snapshots() {
        let (_temp, vault) = fixture();
        assert!(vault.import_auth(b"not-json").is_err());
        assert!(vault.import_auth(br#"{"auth_mode":"apikey"}"#).is_err());
        assert!(vault.list_accounts().unwrap().is_empty());
    }

    #[test]
    fn switching_preserves_current_account_and_atomically_selects_target() {
        let (_temp, vault) = fixture();
        atomic_write(
            &vault.paths().live_auth(),
            &auth("current", "current-token", "current@example.com"),
        )
        .unwrap();
        vault
            .import_auth(&auth("target", "target-token", "target@example.com"))
            .unwrap();
        vault.switch_after_shutdown("target").unwrap();
        let accounts = vault.list_accounts().unwrap();
        assert_eq!(accounts.len(), 2);
        assert_eq!(
            accounts.iter().find(|a| a.active).unwrap().account_id,
            "target"
        );
    }

    #[test]
    fn non_file_credential_storage_blocks_switching() {
        let (_temp, vault) = fixture();
        vault
            .import_auth(&auth("target", "target-token", "target@example.com"))
            .unwrap();
        fs::write(
            vault.paths().codex_config(),
            "cli_auth_credentials_store = \"keyring\"\n",
        )
        .unwrap();
        assert!(matches!(
            vault.validate_switch("target"),
            Err(AccountError::UnsupportedCredentialStore(_))
        ));
    }

    #[tokio::test]
    async fn usage_uses_saved_token_without_exposing_it_in_the_result() {
        let server = MockServer::start().await;
        let (_temp, mut vault) = fixture();
        vault.paths.usage_endpoint = format!("{}/backend-api/wham/usage", server.uri());
        vault
            .import_auth(&auth("usage-account", "usage-secret", "u@example.com"))
            .unwrap();
        Mock::given(method("GET"))
            .and(path("/backend-api/wham/usage"))
            .and(header("authorization", "Bearer usage-secret"))
            .and(header("chatgpt-account-id", "usage-account"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "plan_type": "plus",
                "rate_limit": {
                    "allowed": true,
                    "limit_reached": false,
                    "primary_window": {"used_percent": 12.5, "reset_at": 2000000000},
                    "secondary_window": null
                },
                "credits": {"has_credits": true, "unlimited": false, "balance": "12.00"}
            })))
            .mount(&server)
            .await;
        let usage = vault.fetch_usage("usage-account").await.unwrap();
        assert_eq!(usage.plan_type.as_deref(), Some("plus"));
        assert_eq!(
            usage.credits.as_ref().unwrap().balance.as_ref(),
            Some(&Value::String("12.00".to_string()))
        );
        assert_eq!(
            usage
                .rate_limit
                .as_ref()
                .unwrap()
                .primary_window
                .as_ref()
                .unwrap()
                .used_percent,
            Some(12.5)
        );
        assert!(
            !serde_json::to_string(&usage)
                .unwrap()
                .contains("usage-secret")
        );
    }
}
