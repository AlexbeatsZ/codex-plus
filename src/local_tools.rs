use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Stdio;

use anyhow::{Context as _, bail};
use serde_json::{Value, json};

use crate::accounts::AccountPaths;

const COMPONENT_DIR: &str = "local-tools";

#[cfg(windows)]
const DEFAULT_TUNNEL_ID: &str = "tunnel_6a971ae4c9c0819192f1a813a4120a88";
#[cfg(not(windows))]
const DEFAULT_TUNNEL_ID: &str = "tunnel_6a9e6895ebd48191bfdfcae0aed40153";

#[cfg(windows)]
const DEFAULT_RUNTIME_ALIAS: &str = "codex-chat-local-tools-win";
#[cfg(not(windows))]
const DEFAULT_RUNTIME_ALIAS: &str = "codex-chat-local-tools-mac";

fn resolve_tunnel_id(env_file: &Path) -> anyhow::Result<String> {
    if let Some(explicit) = std::env::var("CODEX_PLUS_TUNNEL_ID")
        .ok()
        .filter(|value| !value.trim().is_empty())
    {
        return Ok(explicit.trim().to_string());
    }
    if let Some(configured) = read_optional_env_value(env_file, "TUNNEL_ID")? {
        return Ok(configured);
    }
    Ok(DEFAULT_TUNNEL_ID.to_string())
}

fn resolve_runtime_alias(env_file: &Path) -> anyhow::Result<String> {
    if let Some(explicit) = std::env::var("CODEX_PLUS_TUNNEL_ALIAS")
        .ok()
        .filter(|value| !value.trim().is_empty())
    {
        return Ok(explicit.trim().to_string());
    }
    if let Some(configured) = read_optional_env_value(env_file, "TUNNEL_ALIAS")? {
        return Ok(configured);
    }
    Ok(DEFAULT_RUNTIME_ALIAS.to_string())
}

#[derive(Debug)]
struct RuntimeStart {
    component_root: PathBuf,
    ready: bool,
    started: bool,
    already_running: bool,
}

pub async fn ensure_runtime(paths: &AccountPaths) {
    let result = tokio::task::spawn_blocking(ensure_runtime_blocking).await;
    match result {
        Ok(Ok(start)) => crate::runtime::append_log(
            paths,
            "local_tools.runtime.ready",
            json!({
                "componentRoot": start.component_root,
                "ready": start.ready,
                "started": start.started,
                "alreadyRunning": start.already_running,
            }),
        ),
        Ok(Err(error)) => crate::runtime::append_log(
            paths,
            "local_tools.runtime.unavailable",
            json!({"message": error.to_string()}),
        ),
        Err(error) => crate::runtime::append_log(
            paths,
            "local_tools.runtime.unavailable",
            json!({"message": format!("启动任务异常结束: {error}")}),
        ),
    }
}

fn ensure_runtime_blocking() -> anyhow::Result<RuntimeStart> {
    let component_root = discover_component_root()?;
    #[cfg(windows)]
    let tunnel_client = component_root
        .join(".tools")
        .join("tunnel-client")
        .join("tunnel-client.exe");
    #[cfg(not(windows))]
    let tunnel_client = component_root
        .join(".tools")
        .join("tunnel-client")
        .join("tunnel-client");
    #[cfg(windows)]
    let start_script = component_root.join("scripts").join("start-tunnel-mcp.ps1");
    #[cfg(not(windows))]
    let start_script = component_root.join("scripts").join("start-tunnel-mcp.sh");
    let workspace_root = component_root
        .parent()
        .context("local-tools 没有可用的父工作区")?;
    let env_file = component_root.join(".env.local");
    let runtime_key = read_runtime_key(&env_file)?;
    let tunnel_http_proxy = read_optional_env_value(&env_file, "TUNNEL_HTTP_PROXY")?;
    let tunnel_id = resolve_tunnel_id(&env_file)?;
    let runtime_alias = resolve_runtime_alias(&env_file)?;
    let profile_name = runtime_alias.clone();
    #[cfg(windows)]
    let mcp_command = format!(
        "powershell.exe -NoProfile -ExecutionPolicy Bypass -File {} -Root {}",
        command_path(&start_script),
        command_path(workspace_root),
    );
    #[cfg(not(windows))]
    let mcp_command = format!(
        "/bin/bash {} {}",
        shell_quote(&start_script),
        shell_quote(workspace_root),
    );

    let mut command = crate::runtime::background_command(&tunnel_client);
    command
        .current_dir(&component_root)
        .args([
            "runtimes",
            "connect",
            "--alias",
            &runtime_alias,
            "--admin-profile",
            "default",
            "--profile",
            &profile_name,
            "--profile-dir",
            ".tunnel-client",
            "--tunnel-id",
            &tunnel_id,
            "--mcp-command",
        ])
        .arg(&mcp_command)
        .args(["--runtime-api-key", "env:CONTROL_PLANE_API_KEY", "--json"])
        .env_remove("OPENAI_API_KEY")
        .env("CONTROL_PLANE_API_KEY", runtime_key)
        .stdin(Stdio::null());
    if let Some(proxy) = tunnel_http_proxy {
        command.env("HTTPS_PROXY", proxy);
    }
    let output = command
        .output()
        .with_context(|| format!("无法启动 {}", tunnel_client.display()))?;

    if !output.status.success() {
        bail!(
            "tunnel-client runtimes connect 失败，退出码 {}",
            output
                .status
                .code()
                .map_or_else(|| "unknown".to_string(), |code| code.to_string())
        );
    }

    let status: Value = serde_json::from_slice(&output.stdout)
        .context("tunnel-client 未返回有效的 runtime 状态 JSON")?;
    let ready = status
        .get("ready")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if !ready {
        bail!("tunnel-client 已返回，但 local-tools runtime 尚未 ready");
    }

    Ok(RuntimeStart {
        component_root,
        ready,
        started: status
            .get("started")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        already_running: status
            .get("already_running")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    })
}

fn discover_component_root() -> anyhow::Result<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(explicit) =
        std::env::var_os("CODEX_PLUS_LOCAL_TOOLS_ROOT").filter(|value| !value.is_empty())
    {
        candidates.push(PathBuf::from(explicit));
    }
    if let Ok(executable) = std::env::current_exe()
        && let Some(release_dir) = executable.parent()
        && let Some(repository_root) = release_dir.ancestors().nth(2)
    {
        candidates.push(repository_root.join(COMPONENT_DIR));
    }
    candidates.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(COMPONENT_DIR));

    let mut checked = Vec::new();
    for candidate in candidates {
        if checked
            .iter()
            .any(|existing: &PathBuf| existing == &candidate)
        {
            continue;
        }
        checked.push(candidate.clone());
        if component_is_runnable(&candidate) {
            return candidate
                .canonicalize()
                .with_context(|| format!("无法解析 {}", candidate.display()));
        }
    }

    let checked = checked
        .iter()
        .map(|path| path.display().to_string())
        .collect::<Vec<_>>()
        .join("; ");
    bail!("未找到可启动的 local-tools 组件，已检查: {checked}")
}

fn component_is_runnable(root: &Path) -> bool {
    #[cfg(windows)]
    let platform_files = root.join("scripts").join("start-tunnel-mcp.ps1").is_file()
        && root
            .join(".tools")
            .join("tunnel-client")
            .join("tunnel-client.exe")
            .is_file();
    #[cfg(not(windows))]
    let platform_files = root.join("scripts").join("start-tunnel-mcp.sh").is_file()
        && root
            .join(".tools")
            .join("tunnel-client")
            .join("tunnel-client")
            .is_file();
    root.join("dist").join("cli.js").is_file()
        && platform_files
        && root.join(".env.local").is_file()
}

fn read_runtime_key(path: &Path) -> anyhow::Result<OsString> {
    Ok(OsString::from(
        read_optional_env_value(path, "OPENAI_API_KEY")?
            .context("local-tools/.env.local 缺少非空 OPENAI_API_KEY")?,
    ))
}

fn read_optional_env_value(path: &Path, name: &str) -> anyhow::Result<Option<String>> {
    if !path.exists() {
        return Ok(None);
    }
    let contents = fs::read_to_string(path)
        .with_context(|| format!("无法读取 local-tools 配置文件 {}", path.display()))?;
    Ok(contents
        .lines()
        .filter_map(|line| line.split_once('='))
        .filter(|(candidate, _)| candidate.trim() == name)
        .map(|(_, value)| unquote(value.trim()).to_string())
        .next_back()
        .filter(|value| !value.trim().is_empty()))
}

fn unquote(value: &str) -> &str {
    if value.len() >= 2
        && ((value.starts_with('"') && value.ends_with('"'))
            || (value.starts_with('\'') && value.ends_with('\'')))
    {
        &value[1..value.len() - 1]
    } else {
        value
    }
}

fn command_path(path: &Path) -> String {
    let path = path.to_string_lossy();
    path.strip_prefix(r"\\?\")
        .unwrap_or(path.as_ref())
        .replace('\\', "/")
}

#[cfg(not(windows))]
fn shell_quote(path: &Path) -> String {
    let value = path.to_string_lossy();
    format!("'{}'", value.replace('\'', "'\\''"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runtime_key_parser_uses_last_assignment_and_unquotes_it() {
        let directory = tempfile::tempdir().unwrap();
        let env_file = directory.path().join(".env.local");
        fs::write(
            &env_file,
            "OPENAI_API_KEY=old\nOTHER=value\nOPENAI_API_KEY='new-value'\n",
        )
        .unwrap();

        assert_eq!(read_runtime_key(&env_file).unwrap(), "new-value");
    }

    #[test]
    fn runtime_key_parser_rejects_missing_or_empty_key() {
        let directory = tempfile::tempdir().unwrap();
        let env_file = directory.path().join(".env.local");
        fs::write(&env_file, "OPENAI_API_KEY=\n").unwrap();

        assert!(read_runtime_key(&env_file).is_err());
    }

    #[test]
    fn optional_env_parser_uses_last_non_empty_assignment() {
        let directory = tempfile::tempdir().unwrap();
        let env_file = directory.path().join(".env.local");
        fs::write(
            &env_file,
            "TUNNEL_HTTP_PROXY=http://old\nTUNNEL_HTTP_PROXY='http://127.0.0.1:7897'\n",
        )
        .unwrap();

        assert_eq!(
            read_optional_env_value(&env_file, "TUNNEL_HTTP_PROXY").unwrap(),
            Some("http://127.0.0.1:7897".to_string())
        );
        assert_eq!(read_optional_env_value(&env_file, "MISSING").unwrap(), None);
    }

    #[test]
    fn command_paths_use_forward_slashes_for_tunnel_profile() {
        assert_eq!(
            command_path(Path::new(r"C:\Project\local-tools\scripts\start.ps1")),
            "C:/Project/local-tools/scripts/start.ps1"
        );
        assert_eq!(
            command_path(Path::new(r"\\?\C:\Project\local-tools\scripts\start.ps1")),
            "C:/Project/local-tools/scripts/start.ps1"
        );
    }

    #[test]
    fn tunnel_resolvers_use_env_file_and_fall_back_to_defaults() {
        let directory = tempfile::tempdir().unwrap();
        let env_file = directory.path().join(".env.local");

        // Defaults
        assert_eq!(resolve_tunnel_id(&env_file).unwrap(), DEFAULT_TUNNEL_ID);
        assert_eq!(resolve_runtime_alias(&env_file).unwrap(), DEFAULT_RUNTIME_ALIAS);

        // From file
        fs::write(
            &env_file,
            "TUNNEL_ID='tunnel_custom_123'\nTUNNEL_ALIAS=codex-custom-alias\n",
        )
        .unwrap();

        assert_eq!(resolve_tunnel_id(&env_file).unwrap(), "tunnel_custom_123");
        assert_eq!(resolve_runtime_alias(&env_file).unwrap(), "codex-custom-alias");
    }
}
