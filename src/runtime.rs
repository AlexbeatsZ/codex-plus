use std::ffi::OsStr;
use std::fs::{self, File, OpenOptions};
use std::io::Write as _;
use std::net::{Ipv4Addr, TcpListener};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{Context, bail};
use fs2::FileExt as _;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};

use crate::accounts::{
    AccountPaths, AccountVault, atomic_write, read_optional_file, restore_optional_file,
};

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
#[cfg(windows)]
const BELOW_NORMAL_PRIORITY_CLASS: u32 = 0x0000_4000;

pub const START_PHASES: [&str; 6] = ["stop", "lock", "broker", "config", "launch", "inject"];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PendingAction {
    SwitchAccount {
        #[serde(rename = "recordId")]
        record_id: String,
    },
    WebLogin,
}

pub struct LauncherGuard {
    _file: File,
}

#[derive(Debug)]
pub struct DebugPortSelection {
    pub port: u16,
    pub preferred_bind_error: Option<String>,
}

pub fn append_log(paths: &AccountPaths, event: &str, details: serde_json::Value) {
    let _ = fs::create_dir_all(&paths.state_dir);
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let value = json!({
        "timestamp": timestamp,
        "event": sanitize_event(event),
        "details": details,
    });
    if let Ok(mut file) = OpenOptions::new()
        .create(true)
        .append(true)
        .open(paths.log_path())
    {
        let _ = writeln!(file, "{value}");
    }
}

pub fn acquire_launcher_guard(paths: &AccountPaths) -> anyhow::Result<LauncherGuard> {
    fs::create_dir_all(&paths.state_dir)?;
    let file = File::options()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(paths.launcher_lock())?;
    file.try_lock_exclusive()
        .context("另一个 codex-plus 启动器仍在运行")?;
    Ok(LauncherGuard { _file: file })
}

pub fn select_debug_port(preferred_port: u16) -> anyhow::Result<DebugPortSelection> {
    match TcpListener::bind((Ipv4Addr::LOCALHOST, preferred_port)) {
        Ok(listener) => {
            let port = listener.local_addr()?.port();
            drop(listener);
            Ok(DebugPortSelection {
                port,
                preferred_bind_error: None,
            })
        }
        Err(error) => {
            let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
                .context("无法为 Codex CDP 选择备用本机端口")?;
            let port = listener.local_addr()?.port();
            drop(listener);
            Ok(DebugPortSelection {
                port,
                preferred_bind_error: Some(error.to_string()),
            })
        }
    }
}

pub fn stop_existing_runtime(paths: &AccountPaths) -> anyhow::Result<()> {
    let current_pid = std::process::id();
    let current_exe = std::env::current_exe().context("无法定位 codex-plus.exe")?;
    let current_key = normalized_path(&current_exe);
    let mut system = System::new();
    refresh_process_identity(&mut system, ProcessesToUpdate::All);
    let targets = system
        .processes()
        .iter()
        .filter_map(|(pid, process)| {
            let pid_value = pid.as_u32();
            if pid_value == current_pid {
                return None;
            }
            let same_launcher = process
                .exe()
                .is_some_and(|path| normalized_path(path) == current_key);
            let known_launcher = is_codex_plus_launcher(process.name());
            let codex = is_openai_codex_process(process.name(), process.exe());
            (same_launcher || known_launcher || codex)
                .then_some((*pid, process.name().to_string_lossy().to_string()))
        })
        .collect::<Vec<_>>();

    append_log(
        paths,
        "runtime.stop.started",
        json!({"processCount": targets.len()}),
    );
    for (pid, _) in &targets {
        if let Some(process) = system.process(*pid) {
            let _ = process.kill();
        }
    }
    wait_for_pids(&mut system, targets.iter().map(|(pid, _)| *pid).collect())?;
    append_log(paths, "runtime.stop.completed", json!({}));
    Ok(())
}

pub fn resolve_codex_executable() -> anyhow::Result<PathBuf> {
    if let Some(explicit) = std::env::var_os("CODEX_PLUS_APP_PATH")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
    {
        return normalize_app_candidate(&explicit)
            .ok_or_else(|| anyhow::anyhow!("CODEX_PLUS_APP_PATH 中未找到 ChatGPT.exe/Codex.exe"));
    }

    let script = r#"
$names = @('OpenAI.Codex','OpenAI.CodexBeta','OpenAI.ChatGPT-Desktop')
$packages = foreach ($name in $names) { Get-AppxPackage -Name $name -ErrorAction SilentlyContinue }
$packages | Sort-Object Version -Descending | ForEach-Object { $_.InstallLocation }
"#;
    let mut command = background_command("powershell.exe");
    let output = command
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .stderr(Stdio::null())
        .output()
        .context("无法查询 OpenAI Codex 安装包")?;
    if output.status.success() {
        let text = String::from_utf8_lossy(&output.stdout);
        for line in text.lines().map(str::trim).filter(|line| !line.is_empty()) {
            if let Some(executable) = normalize_app_candidate(Path::new(line)) {
                return Ok(executable);
            }
        }
    }

    let local = std::env::var_os("LOCALAPPDATA").map(PathBuf::from);
    let candidates = local
        .into_iter()
        .flat_map(|root| {
            [
                root.join("Programs").join("ChatGPT"),
                root.join("Programs").join("OpenAI Codex"),
                root.join("OpenAI").join("ChatGPT"),
            ]
        })
        .collect::<Vec<_>>();
    for candidate in candidates {
        if let Some(executable) = normalize_app_candidate(&candidate) {
            return Ok(executable);
        }
    }
    bail!("未找到官方 OpenAI Codex/ChatGPT 桌面应用")
}

pub fn launch_codex(executable: &Path, debug_port: u16) -> anyhow::Result<Child> {
    let mut command = codex_command(executable);
    command
        .arg(format!("--remote-debugging-port={debug_port}"))
        .arg(format!(
            "--remote-allow-origins=http://127.0.0.1:{debug_port}"
        ));
    let child = command
        .spawn()
        .with_context(|| format!("无法启动 {}", executable.display()))?;
    Ok(child)
}

pub fn queue_switch(paths: &AccountPaths, record_id: &str) -> anyhow::Result<()> {
    queue_pending_action(
        paths,
        PendingAction::SwitchAccount {
            record_id: record_id.to_string(),
        },
    )
}

pub fn queue_web_login(paths: &AccountPaths) -> anyhow::Result<()> {
    queue_pending_action(paths, PendingAction::WebLogin)
}

fn queue_pending_action(paths: &AccountPaths, pending: PendingAction) -> anyhow::Result<()> {
    atomic_write(&paths.pending_action(), &serde_json::to_vec(&pending)?)?;
    let executable = std::env::current_exe().context("无法定位 codex-plus.exe")?;
    let mut command = background_command(executable);
    command.arg("--apply-pending-action");
    if let Err(error) = command.spawn() {
        let _ = fs::remove_file(paths.pending_action());
        return Err(error).context("无法启动账户操作 helper");
    }
    Ok(())
}

pub fn apply_pending_action(paths: &AccountPaths) -> anyhow::Result<()> {
    let bytes = fs::read(paths.pending_action()).context("没有可执行的账户切换动作")?;
    let action: PendingAction = serde_json::from_slice(&bytes).context("账户切换动作无效")?;
    let vault = AccountVault::new(paths.clone());
    match &action {
        PendingAction::SwitchAccount { record_id } => vault.validate_switch(record_id)?,
        PendingAction::WebLogin => vault.validate_web_login()?,
    }

    std::thread::sleep(Duration::from_millis(350));
    let previous = read_optional_file(&paths.live_auth())?;
    stop_existing_runtime(paths)?;
    let action_result = match &action {
        PendingAction::SwitchAccount { record_id } => {
            vault.switch_after_shutdown(record_id).map(|_| ())
        }
        PendingAction::WebLogin => vault.begin_web_login_after_shutdown(),
    };
    if let Err(error) = &action_result {
        let restore = restore_optional_file(&paths.live_auth(), previous.as_deref());
        append_log(
            paths,
            match action {
                PendingAction::SwitchAccount { .. } => "account.switch.failed",
                PendingAction::WebLogin => "account.web_login.failed",
            },
            json!({"message": error.to_string(), "rollbackOk": restore.is_ok()}),
        );
    } else {
        append_log(
            paths,
            match action {
                PendingAction::SwitchAccount { .. } => "account.switch.completed",
                PendingAction::WebLogin => "account.web_login.started",
            },
            json!({}),
        );
    }
    let _ = fs::remove_file(paths.pending_action());
    let launch_result = match action {
        PendingAction::SwitchAccount { .. } => spawn_normal_launcher(),
        PendingAction::WebLogin if action_result.is_ok() => spawn_web_login_launcher(),
        PendingAction::WebLogin => spawn_normal_launcher(),
    };
    if let Err(error) = launch_result {
        if matches!(action, PendingAction::WebLogin) && action_result.is_ok() {
            let _ = restore_optional_file(&paths.live_auth(), previous.as_deref());
            let _ = spawn_normal_launcher();
        }
        return Err(error);
    }
    action_result.map_err(Into::into)
}

pub fn spawn_normal_launcher() -> anyhow::Result<()> {
    let executable = std::env::current_exe().context("无法定位 codex-plus.exe")?;
    let mut command = background_command(executable);
    command.spawn().context("无法重新启动 codex-plus")?;
    Ok(())
}

fn spawn_web_login_launcher() -> anyhow::Result<()> {
    let executable = std::env::current_exe().context("无法定位 codex-plus.exe")?;
    let mut command = background_command(executable);
    command.arg("--web-login");
    command
        .spawn()
        .context("无法重新启动 codex-plus 网页登录流程")?;
    Ok(())
}

pub async fn capture_web_login(paths: AccountPaths) {
    loop {
        tokio::time::sleep(Duration::from_millis(750)).await;
        let capture_paths = paths.clone();
        let result = tokio::task::spawn_blocking(move || {
            AccountVault::new(capture_paths).capture_live_account()
        })
        .await;
        match result {
            Ok(Ok(Some(_))) => {
                append_log(&paths, "account.web_login.completed", json!({}));
                return;
            }
            Ok(Ok(None)) => {}
            Ok(Err(error)) => append_log(
                &paths,
                "account.web_login.capture_retry",
                json!({"message": error.to_string()}),
            ),
            Err(error) => append_log(
                &paths,
                "account.web_login.capture_retry",
                json!({"message": error.to_string()}),
            ),
        }
    }
}

pub(crate) fn background_command(program: impl AsRef<OsStr>) -> Command {
    let mut command = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt as _;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

fn codex_command(program: impl AsRef<OsStr>) -> Command {
    let mut command = background_command(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt as _;
        command.creation_flags(CREATE_NO_WINDOW | BELOW_NORMAL_PRIORITY_CLASS);
    }
    command
}

pub async fn wait_until_codex_starts() {
    let mut system = System::new();
    loop {
        refresh_process_discovery(&mut system);
        if system
            .processes()
            .values()
            .any(is_openai_codex_root_process)
        {
            return;
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
}

fn refresh_process_discovery(system: &mut System) {
    system.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing()
            .with_exe(UpdateKind::OnlyIfNotSet)
            .with_cmd(UpdateKind::OnlyIfNotSet),
    );
}

pub async fn wait_until_codex_stops(
    mut root_process: Child,
    debug_port: u16,
) -> anyhow::Result<()> {
    let mut missing = 0_u8;
    loop {
        tokio::time::sleep(Duration::from_secs(1)).await;
        if root_process
            .try_wait()
            .context("无法查询 Codex 主进程状态")?
            .is_none()
        {
            missing = 0;
            continue;
        }

        if !crate::cdp::endpoint_available(debug_port).await {
            missing = missing.saturating_add(1);
            if missing >= 5 {
                return Ok(());
            }
        } else {
            missing = 0;
        }
    }
}

fn refresh_process_identity(system: &mut System, processes: ProcessesToUpdate<'_>) {
    system.refresh_processes_specifics(
        processes,
        true,
        ProcessRefreshKind::nothing().with_exe(UpdateKind::OnlyIfNotSet),
    );
}

fn wait_for_pids(system: &mut System, mut pids: Vec<Pid>) -> anyhow::Result<()> {
    for _ in 0..100 {
        if pids.is_empty() {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(100));
        refresh_process_identity(system, ProcessesToUpdate::Some(&pids));
        pids.retain(|pid| system.process(*pid).is_some());
    }
    if pids.is_empty() {
        Ok(())
    } else {
        bail!("无法停止现有 Codex/codex-plus 进程")
    }
}

fn is_openai_codex_process(name: &OsStr, executable: Option<&Path>) -> bool {
    let name = name.to_string_lossy().to_ascii_lowercase();
    if !matches!(
        name.as_str(),
        "chatgpt.exe" | "codex.exe" | "chatgpt" | "codex"
    ) {
        return false;
    }
    let Some(executable) = executable else {
        return false;
    };
    let path = normalized_path(executable);
    path.contains("\\windowsapps\\openai.codex_")
        || path.contains("\\windowsapps\\openai.codexbeta_")
        || path.contains("\\windowsapps\\openai.chatgpt-desktop_")
        || path.contains("\\openai\\chatgpt\\")
        || path.contains("\\openai codex\\")
}

fn is_openai_codex_root_process(process: &sysinfo::Process) -> bool {
    is_openai_codex_process(process.name(), process.exe())
        && !is_auxiliary_codex_command(process.cmd())
}

fn is_auxiliary_codex_command(command: &[std::ffi::OsString]) -> bool {
    command.iter().any(|argument| {
        let argument = argument.to_string_lossy().to_ascii_lowercase();
        argument.starts_with("--type=") || argument == "app-server"
    })
}

fn is_codex_plus_launcher(name: &OsStr) -> bool {
    matches!(
        name.to_string_lossy().to_ascii_lowercase().as_str(),
        "codex-plus.exe" | "codex-plus-plus.exe" | "codex-plus" | "codex-plus-plus"
    )
}

fn normalize_app_candidate(path: &Path) -> Option<PathBuf> {
    let candidates = if path.is_file() {
        vec![path.to_path_buf()]
    } else {
        vec![
            path.join("app").join("ChatGPT.exe"),
            path.join("app").join("Codex.exe"),
            path.join("ChatGPT.exe"),
            path.join("Codex.exe"),
        ]
    };
    candidates.into_iter().find(|candidate| candidate.is_file())
}

fn normalized_path(path: &Path) -> String {
    path.to_string_lossy()
        .replace('/', "\\")
        .to_ascii_lowercase()
}

fn sanitize_event(value: &str) -> String {
    value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-') {
                ch
            } else {
                '_'
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn explicit_start_order_keeps_restart_before_lock_and_launch() {
        assert_eq!(
            START_PHASES,
            ["stop", "lock", "broker", "config", "launch", "inject"]
        );
        assert!(
            START_PHASES.iter().position(|v| *v == "stop")
                < START_PHASES.iter().position(|v| *v == "lock")
        );
        assert!(
            START_PHASES.iter().position(|v| *v == "lock")
                < START_PHASES.iter().position(|v| *v == "broker")
        );
        assert!(
            START_PHASES.iter().position(|v| *v == "broker")
                < START_PHASES.iter().position(|v| *v == "config")
        );
        assert!(
            START_PHASES.iter().position(|v| *v == "config")
                < START_PHASES.iter().position(|v| *v == "launch")
        );
    }

    #[test]
    fn only_known_openai_process_paths_match() {
        assert!(is_openai_codex_process(
            OsStr::new("ChatGPT.exe"),
            Some(Path::new(
                r"C:\Program Files\WindowsApps\OpenAI.Codex_1.0_x64__id\app\ChatGPT.exe"
            ))
        ));
        assert!(!is_openai_codex_process(
            OsStr::new("ChatGPT.exe"),
            Some(Path::new(r"D:\Unrelated\ChatGPT.exe"))
        ));
        assert!(!is_openai_codex_process(
            OsStr::new("explorer.exe"),
            Some(Path::new(r"C:\Windows\explorer.exe"))
        ));
    }

    #[test]
    fn root_process_filter_excludes_electron_children_and_app_server() {
        assert!(is_auxiliary_codex_command(&[
            "ChatGPT.exe".into(),
            "--type=renderer".into(),
        ]));
        assert!(is_auxiliary_codex_command(&[
            "codex.exe".into(),
            "app-server".into(),
        ]));
        assert!(!is_auxiliary_codex_command(&[
            "ChatGPT.exe".into(),
            "--remote-debugging-port=9229".into(),
        ]));
    }

    #[test]
    fn recognizes_previous_and_current_launcher_names() {
        assert!(is_codex_plus_launcher(OsStr::new("codex-plus.exe")));
        assert!(is_codex_plus_launcher(OsStr::new("codex-plus-plus.exe")));
        assert!(!is_codex_plus_launcher(OsStr::new("other-launcher.exe")));
    }

    #[test]
    fn debug_port_selection_falls_back_when_preferred_port_is_occupied() {
        let occupied = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let preferred_port = occupied.local_addr().unwrap().port();

        let selected = select_debug_port(preferred_port).unwrap();

        assert_ne!(selected.port, 0);
        assert_ne!(selected.port, preferred_port);
        assert!(selected.preferred_bind_error.is_some());
        TcpListener::bind((Ipv4Addr::LOCALHOST, selected.port)).unwrap();

        drop(occupied);
        let recovered = select_debug_port(preferred_port).unwrap();
        assert_eq!(recovered.port, preferred_port);
        assert!(recovered.preferred_bind_error.is_none());
    }

    #[test]
    fn pending_action_contains_no_auth_material() {
        let action = PendingAction::SwitchAccount {
            record_id: "a".repeat(64),
        };
        let encoded = serde_json::to_string(&action).unwrap();
        assert_eq!(
            encoded,
            format!(
                r#"{{"kind":"switchAccount","recordId":"{}"}}"#,
                "a".repeat(64)
            )
        );
        assert!(!encoded.contains("token"));

        let web_login = serde_json::to_string(&PendingAction::WebLogin).unwrap();
        assert_eq!(web_login, r#"{"kind":"webLogin"}"#);
        assert!(!web_login.contains("token"));
    }

    #[cfg(windows)]
    #[test]
    fn background_powershell_has_no_console_window() {
        let script = r#"
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class NativeConsole { [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow(); }'
if ([NativeConsole]::GetConsoleWindow() -ne [IntPtr]::Zero) { exit 1 }
"#;
        let status = background_command("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command", script])
            .status()
            .unwrap();

        assert!(status.success(), "后台 PowerShell 获得了可见控制台窗口");
    }

    #[cfg(windows)]
    #[test]
    fn codex_child_starts_below_normal_priority() {
        let output = codex_command("powershell.exe")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "(Get-Process -Id $PID).PriorityClass.ToString()",
            ])
            .output()
            .unwrap();

        assert!(output.status.success());
        assert_eq!(
            String::from_utf8_lossy(&output.stdout).trim(),
            "BelowNormal"
        );
    }
}
