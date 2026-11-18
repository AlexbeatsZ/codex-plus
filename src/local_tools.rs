use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Stdio;

use anyhow::{Context as _, bail};
use serde_json::{Value, json};
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, Signal, System, UpdateKind};

use crate::accounts::AccountPaths;

use crate::layout::LOCAL_TOOLS_DIR as COMPONENT_DIR;

#[cfg(windows)]
const DEFAULT_TUNNEL_ID: &str = "tunnel_6a971ae4c9c0819192f1a813a4120a88";
#[cfg(not(windows))]
const DEFAULT_TUNNEL_ID: &str = "tunnel_6a9e8895ebd48191bfdfcae0aed40153";

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
    /// Unmanaged `tunnel-client run` processes stopped before connecting.
    stray: Vec<u32>,
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
                "strayStopped": start.stray,
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

    let stray = stop_stray_runtimes(
        &tunnel_client,
        &component_root,
        &runtime_alias,
        &profile_name,
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
        stray,
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

/// The runtime manager only tracks the runtime it recorded. When that record
/// goes stale (its tmux session vanished, a crash) while the old `run` process
/// lives on, `connect` starts a second one: both poll the same tunnel, both
/// write the same health URL file (the survivor's file is deleted when either
/// exits), and each keeps its own Codex app-server bridge alive. A runtime that
/// the manager does not report as ready is therefore unmanaged and is stopped
/// before connecting; a ready one is left to `connect` to reuse.
fn stop_stray_runtimes(
    tunnel_client: &Path,
    component_root: &Path,
    alias: &str,
    profile: &str,
) -> Vec<u32> {
    let state = crate::runtime::background_command(tunnel_client)
        .current_dir(component_root)
        .args(["runtimes", "status", alias])
        .stdin(Stdio::null())
        .output()
        .ok()
        .filter(|output| output.status.success())
        .and_then(|output| runtime_state(&String::from_utf8_lossy(&output.stdout), alias));
    if state.as_deref() == Some("ready") {
        return Vec::new();
    }
    let client = normalized(tunnel_client);
    let mut system = System::new();
    system.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing()
            .with_exe(UpdateKind::OnlyIfNotSet)
            .with_cmd(UpdateKind::OnlyIfNotSet),
    );
    let stray: Vec<Pid> = system
        .processes()
        .iter()
        .filter(|(_, process)| {
            process.exe().is_some_and(|exe| normalized(exe) == client)
                && is_runtime_command(process.cmd(), profile)
        })
        .map(|(pid, _)| *pid)
        .collect();
    if stray.is_empty() {
        return Vec::new();
    }
    // Its bridge children are reparented once the runtime exits; note them now.
    let children: Vec<Pid> = system
        .processes()
        .iter()
        .filter(|(_, process)| {
            process
                .parent()
                .is_some_and(|parent| stray.contains(&parent))
        })
        .map(|(pid, _)| *pid)
        .collect();
    for pid in &stray {
        if let Some(process) = system.process(*pid) {
            // A graceful stop lets tunnel-client release its tunnel lease.
            if process.kill_with(Signal::Term).is_none() {
                process.kill();
            }
        }
    }
    let all: Vec<Pid> = stray.iter().chain(&children).copied().collect();
    for _ in 0..50 {
        system.refresh_processes_specifics(
            ProcessesToUpdate::Some(&all),
            true,
            ProcessRefreshKind::nothing(),
        );
        if stray.iter().all(|pid| system.process(*pid).is_none()) {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    for pid in &all {
        if let Some(process) = system.process(*pid) {
            process.kill();
        }
    }
    stray.iter().map(|pid| pid.as_u32()).collect()
}

/// `runtimes status <alias>` prints `alias<TAB>state<TAB>tunnel` lines.
fn runtime_state(output: &str, alias: &str) -> Option<String> {
    output.lines().find_map(|line| {
        let mut fields = line.split('\t');
        (fields.next()? == alias).then(|| fields.next().unwrap_or("").trim().to_string())
    })
}

fn is_runtime_command(command: &[OsString], profile: &str) -> bool {
    let args: Vec<String> = command
        .iter()
        .map(|arg| arg.to_string_lossy().into_owned())
        .collect();
    let named = args
        .windows(2)
        .any(|pair| pair[0] == "--profile" && pair[1] == profile)
        || args
            .iter()
            .any(|arg| arg.strip_prefix("--profile=") == Some(profile));
    args.iter().skip(1).any(|arg| arg == "run") && named
}

fn normalized(path: &Path) -> String {
    let path = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    let text = command_path(&path);
    if cfg!(windows) {
        text.to_ascii_lowercase()
    } else {
        text
    }
}

fn discover_component_root() -> anyhow::Result<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(explicit) =
        std::env::var_os("CODEX_PLUS_LOCAL_TOOLS_ROOT").filter(|value| !value.is_empty())
    {
        candidates.push(PathBuf::from(explicit));
    }
    candidates.push(crate::layout::repository_root().join(COMPONENT_DIR));
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
    crate::layout::env_file_value(path, name)
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
    use std::fs;

    #[test]
    fn only_this_profiles_run_process_counts_as_a_runtime() {
        let args = |line: &str| -> Vec<OsString> { line.split(' ').map(OsString::from).collect() };
        let profile = "codex-chat-local-tools-mac";
        assert!(is_runtime_command(
            &args(
                "/x/tunnel-client run --profile-dir .tunnel-client --profile codex-chat-local-tools-mac"
            ),
            profile
        ));
        assert!(is_runtime_command(
            &args("tunnel-client run --profile=codex-chat-local-tools-mac"),
            profile
        ));
        assert!(!is_runtime_command(
            &args("tunnel-client run --profile codex-chat-local-tools-win"),
            profile
        ));
        assert!(!is_runtime_command(
            &args(
                "tunnel-client runtimes status codex-chat-local-tools-mac --profile codex-chat-local-tools-mac"
            ),
            profile
        ));
    }

    #[test]
    fn runtime_state_reads_the_alias_row() {
        let output = "other\tready\ttunnel_a\ncodex-chat-local-tools-mac\tstarting\ttunnel_b\n";
        assert_eq!(
            runtime_state(output, "codex-chat-local-tools-mac").as_deref(),
            Some("starting")
        );
        assert_eq!(runtime_state(output, "missing"), None);
    }

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
        assert_eq!(
            resolve_runtime_alias(&env_file).unwrap(),
            DEFAULT_RUNTIME_ALIAS
        );

        // From file
        fs::write(
            &env_file,
            "TUNNEL_ID='tunnel_custom_123'\nTUNNEL_ALIAS=codex-custom-alias\n",
        )
        .unwrap();

        assert_eq!(resolve_tunnel_id(&env_file).unwrap(), "tunnel_custom_123");
        assert_eq!(
            resolve_runtime_alias(&env_file).unwrap(),
            "codex-custom-alias"
        );
    }
}
