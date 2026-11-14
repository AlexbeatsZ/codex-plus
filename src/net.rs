//! One place for outbound HTTP: proxy policy, timeouts, user agent and a
//! process-wide client cache so requests reuse pooled connections.
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use anyhow::{Context as _, bail};

pub const USER_AGENT: &str = concat!("codex-plus/", env!("CARGO_PKG_VERSION"));
const SYSTEM_PROXY_TTL: Duration = Duration::from_secs(60);

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum Purpose {
    /// Official ChatGPT backend: usage, OAuth renewal, the native gateway and
    /// the subscription pool. Redirects are refused so credentials never follow
    /// them to another origin.
    Official,
    /// User-configured external OpenAI-compatible APIs. Proxy selection stays
    /// with the environment, exactly as before this module existed.
    External,
}

static CLIENTS: OnceLock<Mutex<HashMap<(Purpose, Option<String>), reqwest::Client>>> =
    OnceLock::new();
static SYSTEM_PROXY: OnceLock<Mutex<Option<(Instant, Option<String>)>>> = OnceLock::new();

/// `explicit_proxy` is the subscription panel's proxy; empty means the
/// environment, then the user's static system proxy.
pub fn official_client(explicit_proxy: &str) -> anyhow::Result<reqwest::Client> {
    let proxy = if explicit_proxy.trim().is_empty() {
        system_proxy()
    } else {
        Some(explicit_proxy.trim().to_string())
    };
    client(Purpose::Official, proxy)
}

pub fn external_client() -> anyhow::Result<reqwest::Client> {
    client(Purpose::External, None)
}

/// Rejects a proxy the official client could not use, without building one.
pub fn validate_proxy(value: &str) -> anyhow::Result<()> {
    if !value.trim().is_empty() {
        parse_proxy(value.trim())?;
    }
    Ok(())
}

fn parse_proxy(proxy: &str) -> anyhow::Result<reqwest::Url> {
    let url = reqwest::Url::parse(proxy).context("账户池代理地址无效")?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        bail!("代理仅支持不含用户名和密码的 HTTP/HTTPS 地址");
    }
    Ok(url)
}

fn client(purpose: Purpose, proxy: Option<String>) -> anyhow::Result<reqwest::Client> {
    let cache = CLIENTS.get_or_init(Mutex::default);
    let key = (purpose, proxy.clone());
    if let Some(client) = cache.lock().unwrap().get(&key) {
        return Ok(client.clone());
    }
    let mut builder = reqwest::Client::builder().user_agent(USER_AGENT);
    builder = match purpose {
        Purpose::Official => builder
            .connect_timeout(Duration::from_secs(10))
            .redirect(reqwest::redirect::Policy::none()),
        Purpose::External => builder.connect_timeout(Duration::from_secs(5)),
    };
    if let Some(proxy) = &proxy {
        builder = builder.proxy(reqwest::Proxy::all(parse_proxy(proxy)?).context("代理地址无效")?);
    }
    let client = builder.build().context("无法建立网络客户端")?;
    cache.lock().unwrap().insert(key, client.clone());
    Ok(client)
}

/// reqwest already honours environment proxies. Desktop launches usually lack
/// shell variables, so fall back to the user's static HTTPS system proxy. The
/// lookup spawns `scutil` on macOS, so it is cached briefly.
fn system_proxy() -> Option<String> {
    if ["HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"]
        .iter()
        .any(|key| std::env::var_os(key).is_some())
    {
        return None;
    }
    let cache = SYSTEM_PROXY.get_or_init(Mutex::default);
    if let Some((at, value)) = cache.lock().unwrap().as_ref()
        && at.elapsed() < SYSTEM_PROXY_TTL
    {
        return value.clone();
    }
    let value = platform_system_proxy();
    *cache.lock().unwrap() = Some((Instant::now(), value.clone()));
    value
}

#[cfg(all(target_os = "macos", not(test)))]
fn platform_system_proxy() -> Option<String> {
    let output = std::process::Command::new("/usr/sbin/scutil")
        .arg("--proxy")
        .output()
        .ok()?;
    macos_https_proxy(&String::from_utf8(output.stdout).ok()?)
}

#[cfg(any(target_os = "macos", test))]
fn macos_https_proxy(text: &str) -> Option<String> {
    let field = |key: &str| {
        text.lines().find_map(|line| {
            line.trim()
                .strip_prefix(&format!("{key} : "))
                .map(str::trim)
        })
    };
    if field("HTTPSEnable") != Some("1") {
        return None;
    }
    let host = field("HTTPSProxy")?;
    let port: u16 = field("HTTPSPort")?.parse().ok()?;
    host.bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || b".-".contains(&byte))
        .then(|| format!("http://{host}:{port}"))
}

#[cfg(all(windows, not(test)))]
fn platform_system_proxy() -> Option<String> {
    use windows::Win32::Foundation::{GlobalFree, HGLOBAL};
    use windows::Win32::Networking::WinHttp::{
        WINHTTP_CURRENT_USER_IE_PROXY_CONFIG, WinHttpGetIEProxyConfigForCurrentUser,
    };
    let mut config = WINHTTP_CURRENT_USER_IE_PROXY_CONFIG::default();
    // WinHTTP owns the three allocated strings until we release them, including
    // the PAC and bypass strings that this static HTTPS fallback does not use.
    unsafe {
        let result = WinHttpGetIEProxyConfigForCurrentUser(&mut config);
        let proxy = if result.is_ok() && !config.lpszProxy.is_null() {
            config.lpszProxy.to_string().ok()
        } else {
            None
        };
        for value in [
            config.lpszProxy,
            config.lpszProxyBypass,
            config.lpszAutoConfigUrl,
        ] {
            if !value.is_null() {
                let _ = GlobalFree(Some(HGLOBAL(value.0.cast())));
            }
        }
        proxy.and_then(|value| windows_https_proxy(&value))
    }
}

#[cfg(any(test, not(any(windows, target_os = "macos"))))]
fn platform_system_proxy() -> Option<String> {
    None
}

#[cfg(any(windows, test))]
fn windows_https_proxy(value: &str) -> Option<String> {
    let value = value.trim();
    let endpoint = if value.contains('=') {
        value
            .split([';', ' '])
            .filter_map(|entry| entry.split_once('='))
            .find(|(protocol, _)| protocol.eq_ignore_ascii_case("https"))?
            .1
    } else {
        value
    };
    if endpoint.is_empty() {
        return None;
    }
    let proxy = if endpoint.contains("://") {
        endpoint.to_owned()
    } else {
        format!("http://{endpoint}")
    };
    parse_proxy(&proxy).ok().map(|_| proxy)
}

/// Proxy handed to the official desktop app on macOS, which does not read the
/// system proxy for its own child processes when started by a LaunchAgent.
#[cfg(target_os = "macos")]
pub fn codex_desktop_proxy() -> Option<String> {
    for key in ["CODEX_PLUS_CODEX_PROXY", "HTTPS_PROXY", "https_proxy"] {
        if let Ok(value) = std::env::var(key)
            && !value.trim().is_empty()
        {
            return Some(value.trim().to_string());
        }
    }
    let text = std::fs::read_to_string(crate::layout::local_tools_env_file()).ok()?;
    desktop_proxy_from_env_text(&text)
}

#[cfg(target_os = "macos")]
fn desktop_proxy_from_env_text(text: &str) -> Option<String> {
    [
        "CODEX_DESKTOP_HTTP_PROXY",
        "CODEX_CLI_HTTP_PROXY",
        "TUNNEL_HTTP_PROXY",
    ]
    .into_iter()
    .find_map(|key| crate::layout::env_value(text, key))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_proxy_supports_shared_and_protocol_specific_settings() {
        assert_eq!(
            windows_https_proxy("127.0.0.1:7897").as_deref(),
            Some("http://127.0.0.1:7897")
        );
        assert_eq!(
            windows_https_proxy("http=unused:80;https=127.0.0.1:7897").as_deref(),
            Some("http://127.0.0.1:7897")
        );
        assert_eq!(
            windows_https_proxy("HTTP=unused:80 HTTPS=https://proxy.test:443").as_deref(),
            Some("https://proxy.test:443")
        );
    }

    #[test]
    fn windows_proxy_does_not_apply_other_protocols_or_unsafe_settings() {
        for value in [
            "",
            "http=unused:80",
            "https=",
            "socks5://localhost:1080",
            "https://user:password@proxy.test",
        ] {
            assert_eq!(windows_https_proxy(value), None, "{value}");
        }
    }

    #[test]
    fn macos_proxy_reads_only_an_enabled_plain_https_proxy() {
        let enabled =
            "<dictionary> {\n  HTTPSEnable : 1\n  HTTPSPort : 7897\n  HTTPSProxy : 127.0.0.1\n}";
        assert_eq!(
            macos_https_proxy(enabled).as_deref(),
            Some("http://127.0.0.1:7897")
        );
        assert_eq!(
            macos_https_proxy(&enabled.replace("Enable : 1", "Enable : 0")),
            None
        );
    }

    #[test]
    fn clients_are_cached_per_purpose_and_proxy() {
        assert!(official_client("http://127.0.0.1:9").is_ok());
        assert!(official_client("http://user:pw@127.0.0.1:9").is_err());
        assert!(validate_proxy("socks5://127.0.0.1:9").is_err());
        assert!(validate_proxy("").is_ok());
        let cache = CLIENTS.get().unwrap().lock().unwrap();
        assert!(cache.contains_key(&(Purpose::Official, Some("http://127.0.0.1:9".into()))));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn desktop_proxy_prefers_dedicated_key_then_cli_then_tunnel() {
        assert_eq!(
            desktop_proxy_from_env_text(
                "TUNNEL_HTTP_PROXY=http://127.0.0.1:1\nCODEX_CLI_HTTP_PROXY=http://127.0.0.1:2\nCODEX_DESKTOP_HTTP_PROXY=http://127.0.0.1:3\n"
            ),
            Some("http://127.0.0.1:3".to_string())
        );
        assert_eq!(
            desktop_proxy_from_env_text("TUNNEL_HTTP_PROXY='http://127.0.0.1:7897'\n"),
            Some("http://127.0.0.1:7897".to_string())
        );
        assert_eq!(desktop_proxy_from_env_text("# empty\nOTHER=value\n"), None);
    }
}
