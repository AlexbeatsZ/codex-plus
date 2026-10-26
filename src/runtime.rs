use std::ffi::OsStr;
use std::fs::{self, File, OpenOptions};
use std::io::Write as _;
use std::net::{Ipv4Addr, TcpListener};
use std::path::{Path, PathBuf};
#[cfg(windows)]
use std::process::Stdio;
use std::process::{Child, Command};
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

/// 首选调试端口被占用时的重试参数。
///
/// `stop_existing_runtime` 已经等到旧进程退出，但内核释放监听套接字与进程退出之间
/// 仍有窗口期：紧接着 bind 会拿到 `AddrInUse`，于是静默回退到随机端口，此后开发期的
/// `--attach-existing`（固定 9229）就再也对不上了。因此在有界时间内重试首选端口，
/// 只有确实一直占用才回退。15 × 200ms ≈ 3 秒。
const DEBUG_PORT_BIND_ATTEMPTS: u32 = 15;
const DEBUG_PORT_BIND_INTERVAL: Duration = Duration::from_millis(200);

#[derive(Debug)]
pub struct DebugPortSelection {
    pub port: u16,
    pub preferred_bind_error: Option<String>,
    /// 为拿到首选端口实际尝试绑定的次数；1 表示一次成功。
    pub preferred_bind_attempts: u32,
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
    let mut last_error = None;
    let mut attempts = 0_u32;
    for attempt in 1..=DEBUG_PORT_BIND_ATTEMPTS {
        attempts = attempt;
        match TcpListener::bind((Ipv4Addr::LOCALHOST, preferred_port)) {
            Ok(listener) => {
                let port = listener.local_addr()?.port();
                drop(listener);
                return Ok(DebugPortSelection {
                    port,
                    preferred_bind_error: None,
                    preferred_bind_attempts: attempts,
                });
            }
            Err(error) => {
                // 只有"地址已被占用"值得等待：那是上一个实例正在退出的窗口期。
                // 其他错误（权限不足、地址不可用等）重试也不会变好，立即回退。
                let retryable = error.kind() == std::io::ErrorKind::AddrInUse;
                last_error = Some(error);
                if !retryable || attempt == DEBUG_PORT_BIND_ATTEMPTS {
                    break;
                }
                std::thread::sleep(DEBUG_PORT_BIND_INTERVAL);
            }
        }
    }
    let error = last_error.expect("select_debug_port 至少尝试绑定过一次");
    let listener =
        TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).context("无法为 Codex CDP 选择备用本机端口")?;
    let port = listener.local_addr()?.port();
    drop(listener);
    Ok(DebugPortSelection {
        port,
        preferred_bind_error: Some(error.to_string()),
        preferred_bind_attempts: attempts,
    })
}

/// macOS 上 adhoc / linker-signed 的二进制没有稳定身份，其 designated requirement
/// 退化成 `cdhash H"..."`，TCC 授权就绑在这个哈希上——任何一次重新链接都会让它失配，
/// 系统于是重新索要屏幕录制等权限，而"已在系统设置里允许过"完全无效（那条记录绑的
/// 是旧二进制）。症状会延迟到下一次权限请求才暴露，离病因很远。
///
/// 这里只做启动自检：不阻止启动，只把"身份不稳"写进日志，让问题在发生的那一刻
/// 就可见。修复办法是构建后运行 `macos/sign.sh`。
#[cfg(target_os = "macos")]
pub fn warn_if_code_signature_is_unstable(paths: &AccountPaths) {
    let Ok(executable) = std::env::current_exe() else {
        return;
    };
    // codesign 的 -d 类输出走 stderr；两边都读，免得将来实现变化时静默失效。
    let Ok(output) = Command::new("/usr/bin/codesign")
        .args(["-d", "-r-"])
        .arg(&executable)
        .output()
    else {
        return;
    };
    let requirement = parse_designated_requirement(&String::from_utf8_lossy(&output.stderr))
        .or_else(|| parse_designated_requirement(&String::from_utf8_lossy(&output.stdout)));
    let Some(requirement) = requirement else {
        return;
    };
    if requirement_uses_stable_identity(&requirement) {
        return;
    }
    append_log(
        paths,
        "launcher.signature.unstable",
        json!({
            "requirement": requirement,
            "hint": "该二进制是 adhoc/linker 签名，TCC 授权绑在 cdhash 上、重新编译即失效；请先运行 bash macos/sign.sh 再启动。",
        }),
    );
}

/// 解析 `codesign -d -r-` 的输出，例如
/// `designated => identifier "x" and certificate leaf = H"..."`。
/// 由内部推导出来的 requirement 会带 `#` 前缀。
#[cfg(target_os = "macos")]
fn parse_designated_requirement(text: &str) -> Option<String> {
    text.lines().find_map(|line| {
        line.trim()
            .trim_start_matches('#')
            .trim()
            .strip_prefix("designated =>")
            .map(|value| value.trim().to_string())
    })
}

/// 证书签名给出的 requirement 带 `certificate leaf = H"..."`，与文件内容无关；
/// adhoc 签名没有证书，只能退化成 `cdhash H"..."`，重新编译就会变。
#[cfg(target_os = "macos")]
fn requirement_uses_stable_identity(requirement: &str) -> bool {
    requirement.contains("certificate leaf")
}

pub fn stop_existing_runtime(paths: &AccountPaths) -> anyhow::Result<()> {
    stop_runtime_processes(paths, true)
}

pub fn stop_codex_runtime(paths: &AccountPaths) -> anyhow::Result<()> {
    stop_runtime_processes(paths, false)
}

fn stop_runtime_processes(paths: &AccountPaths, include_launchers: bool) -> anyhow::Result<()> {
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
            (codex || (include_launchers && (same_launcher || known_launcher)))
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

#[derive(Debug, Clone)]
pub enum CodexAppTarget {
    #[cfg(windows)]
    Appx {
        aumid: String,
        #[allow(dead_code)]
        install_location: PathBuf,
        executable: PathBuf,
    },
    Executable(PathBuf),
}

impl CodexAppTarget {
    pub fn executable_path(&self) -> &Path {
        match self {
            #[cfg(windows)]
            Self::Appx { executable, .. } => executable,
            Self::Executable(path) => path,
        }
    }
}

pub enum CodexProcess {
    Child(Child),
    Observed {
        pid: Pid,
        start_time: u64,
        system: System,
    },
    #[cfg(windows)]
    Handle {
        pid: u32,
        handle: windows::Win32::Foundation::HANDLE,
    },
}

impl CodexProcess {
    pub fn id(&self) -> u32 {
        match self {
            Self::Child(child) => child.id(),
            Self::Observed { pid, .. } => pid.as_u32(),
            #[cfg(windows)]
            Self::Handle { pid, .. } => *pid,
        }
    }

    pub fn is_running(&mut self) -> anyhow::Result<bool> {
        match self {
            Self::Child(child) => Ok(child.try_wait()?.is_none()),
            Self::Observed {
                pid,
                start_time,
                system,
            } => {
                system.refresh_processes_specifics(
                    ProcessesToUpdate::Some(&[*pid]),
                    true,
                    ProcessRefreshKind::nothing(),
                );
                Ok(system
                    .process(*pid)
                    .is_some_and(|process| process.start_time() == *start_time))
            }
            #[cfg(windows)]
            Self::Handle { handle, .. } => {
                use windows::Win32::Foundation::WAIT_TIMEOUT;
                use windows::Win32::System::Threading::WaitForSingleObject;
                let wait = unsafe { WaitForSingleObject(*handle, 0) };
                Ok(wait == WAIT_TIMEOUT)
            }
        }
    }
}

#[cfg(windows)]
impl Drop for CodexProcess {
    fn drop(&mut self) {
        if let Self::Handle { handle, .. } = self {
            use windows::Win32::Foundation::CloseHandle;
            unsafe {
                let _ = CloseHandle(*handle);
            }
        }
    }
}

pub fn resolve_codex_target() -> anyhow::Result<CodexAppTarget> {
    if let Some(explicit) = std::env::var_os("CODEX_PLUS_APP_PATH")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
    {
        let executable = normalize_app_candidate(&explicit)
            .ok_or_else(|| anyhow::anyhow!("CODEX_PLUS_APP_PATH 中未找到 ChatGPT.exe/Codex.exe"))?;
        return Ok(CodexAppTarget::Executable(executable));
    }

    #[cfg(windows)]
    {
        let script = r#"
$names = @('OpenAI.Codex','OpenAI.CodexBeta','OpenAI.ChatGPT-Desktop')
$packages = foreach ($name in $names) { Get-AppxPackage -Name $name -ErrorAction SilentlyContinue }
$packages | Sort-Object Version -Descending | ForEach-Object { "$($_.PackageFamilyName)|$($_.InstallLocation)" }
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
                let parts = line.split('|').collect::<Vec<_>>();
                if parts.len() == 2 {
                    let family_name = parts[0].trim();
                    let install_location = Path::new(parts[1].trim());
                    if let Some(executable) = normalize_app_candidate(install_location) {
                        return Ok(CodexAppTarget::Appx {
                            aumid: format!("{family_name}!App"),
                            install_location: install_location.to_path_buf(),
                            executable,
                        });
                    }
                } else if let Some(executable) = normalize_app_candidate(Path::new(line)) {
                    return Ok(CodexAppTarget::Executable(executable));
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
                return Ok(CodexAppTarget::Executable(executable));
            }
        }
    }

    #[cfg(target_os = "macos")]
    {
        for candidate in [
            PathBuf::from("/Applications/ChatGPT.app"),
            PathBuf::from("/Applications/Codex.app"),
            std::env::var_os("HOME")
                .map(PathBuf::from)
                .unwrap_or_default()
                .join("Applications")
                .join("ChatGPT.app"),
            std::env::var_os("HOME")
                .map(PathBuf::from)
                .unwrap_or_default()
                .join("Applications")
                .join("Codex.app"),
        ] {
            if let Some(executable) = normalize_app_candidate(&candidate) {
                return Ok(CodexAppTarget::Executable(executable));
            }
        }
    }

    bail!("未找到官方 OpenAI Codex/ChatGPT 桌面应用")
}

#[allow(dead_code)]
pub fn resolve_codex_executable() -> anyhow::Result<PathBuf> {
    resolve_codex_target().map(|target| target.executable_path().to_path_buf())
}

pub fn launch_codex(target: &CodexAppTarget, debug_port: u16) -> anyhow::Result<CodexProcess> {
    match target {
        #[cfg(windows)]
        CodexAppTarget::Appx { aumid, .. } => launch_codex_appx(aumid, debug_port),
        CodexAppTarget::Executable(executable) => {
            let mut command = codex_command(executable);
            #[cfg(target_os = "macos")]
            apply_codex_desktop_proxy(&mut command);
            command
                .arg(format!("--remote-debugging-port={debug_port}"))
                .arg(format!(
                    "--remote-allow-origins=http://127.0.0.1:{debug_port}"
                ));
            let child = command
                .spawn()
                .with_context(|| format!("无法启动 {}", executable.display()))?;
            Ok(CodexProcess::Child(child))
        }
    }
}

#[cfg(windows)]
fn launch_codex_appx(aumid: &str, debug_port: u16) -> anyhow::Result<CodexProcess> {
    use windows::Win32::Foundation::{S_FALSE, S_OK};
    use windows::Win32::System::Com::{
        CLSCTX_LOCAL_SERVER, COINIT_APARTMENTTHREADED, CoCreateInstance, CoInitializeEx,
        CoUninitialize,
    };
    use windows::Win32::System::Threading::{
        OpenProcess, PROCESS_CREATION_FLAGS, PROCESS_QUERY_LIMITED_INFORMATION,
        PROCESS_SET_INFORMATION, PROCESS_SYNCHRONIZE, SetPriorityClass,
    };
    use windows::Win32::UI::Shell::{
        AO_NONE, ApplicationActivationManager, IApplicationActivationManager,
    };
    use windows::core::PCWSTR;

    struct ComGuard(bool);
    impl Drop for ComGuard {
        fn drop(&mut self) {
            if self.0 {
                unsafe { CoUninitialize() };
            }
        }
    }

    let init_res = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
    let _com_guard = ComGuard(init_res == S_OK || init_res == S_FALSE);

    let manager: IApplicationActivationManager = unsafe {
        CoCreateInstance(&ApplicationActivationManager, None, CLSCTX_LOCAL_SERVER)
            .context("无法创建 ApplicationActivationManager COM 实例")?
    };

    fn wide(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(std::iter::once(0)).collect()
    }

    let aumid_wide = wide(aumid);
    let args_str = format!(
        "--remote-debugging-port={debug_port} --remote-allow-origins=http://127.0.0.1:{debug_port}"
    );
    let args_wide = wide(&args_str);

    let process_id: u32 = unsafe {
        manager
            .ActivateApplication(
                PCWSTR(aumid_wide.as_ptr()),
                PCWSTR(args_wide.as_ptr()),
                AO_NONE,
            )
            .context("通过 ApplicationActivationManager 激活 OpenAI Codex 失败")?
    };

    if process_id == 0 {
        bail!("ApplicationActivationManager 返回的进程 PID 为 0");
    }

    let handle = unsafe {
        OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SET_INFORMATION | PROCESS_SYNCHRONIZE,
            false,
            process_id,
        )
    };

    if let Ok(handle) = handle {
        unsafe {
            let _ = SetPriorityClass(handle, PROCESS_CREATION_FLAGS(BELOW_NORMAL_PRIORITY_CLASS));
        }
        Ok(CodexProcess::Handle {
            pid: process_id,
            handle,
        })
    } else {
        let handle = unsafe {
            OpenProcess(
                PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
                false,
                process_id,
            )
            .context("无法打开 Codex 进程句柄")?
        };
        Ok(CodexProcess::Handle {
            pid: process_id,
            handle,
        })
    }
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

#[cfg(target_os = "macos")]
pub(crate) fn apply_codex_desktop_proxy(command: &mut Command) {
    let Some(proxy) = resolve_codex_desktop_proxy() else {
        return;
    };
    command
        .env("HTTPS_PROXY", &proxy)
        .env("HTTP_PROXY", &proxy)
        .env("ALL_PROXY", &proxy)
        .env("NO_PROXY", "127.0.0.1,localhost");
}

#[cfg(target_os = "macos")]
fn resolve_codex_desktop_proxy() -> Option<String> {
    for key in ["CODEX_PLUS_CODEX_PROXY", "HTTPS_PROXY", "https_proxy"] {
        if let Ok(value) = std::env::var(key) {
            let value = value.trim();
            if !value.is_empty() {
                return Some(value.to_string());
            }
        }
    }
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("local-tools/.env.local");
    let text = fs::read_to_string(path).ok()?;
    proxy_from_env_text(&text)
}

#[cfg(target_os = "macos")]
fn proxy_from_env_text(text: &str) -> Option<String> {
    let keys = [
        "CODEX_DESKTOP_HTTP_PROXY",
        "CODEX_CLI_HTTP_PROXY",
        "TUNNEL_HTTP_PROXY",
    ];
    for key in keys {
        for line in text.lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            let Some((candidate, raw_value)) = line.split_once('=') else {
                continue;
            };
            if candidate.trim() != key {
                continue;
            }
            let value = raw_value.trim().trim_matches(['"', '\'']).trim();
            if !value.is_empty() {
                return Some(value.to_string());
            }
        }
    }
    None
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

pub struct DiscoveredCodex {
    pub process: CodexProcess,
    pub debug_port: Option<u16>,
}

pub async fn wait_until_codex_starts() -> DiscoveredCodex {
    let mut system = System::new();
    loop {
        refresh_process_discovery(&mut system);
        if let Some(process) = system
            .processes()
            .values()
            .find(|process| is_openai_codex_root_process(process))
        {
            let pid = process.pid();
            let start_time = process.start_time();
            let debug_port = debug_port_from_command(process.cmd());
            return DiscoveredCodex {
                process: CodexProcess::Observed {
                    pid,
                    start_time,
                    system,
                },
                debug_port,
            };
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
}

pub fn observe_codex_on_port(debug_port: u16) -> Option<CodexProcess> {
    let mut system = System::new();
    refresh_process_discovery(&mut system);
    let process = system.processes().values().find(|process| {
        is_openai_codex_root_process(process)
            && debug_port_from_command(process.cmd()) == Some(debug_port)
    })?;
    Some(CodexProcess::Observed {
        pid: process.pid(),
        start_time: process.start_time(),
        system,
    })
}

fn debug_port_from_command(command: &[std::ffi::OsString]) -> Option<u16> {
    command.iter().enumerate().find_map(|(index, argument)| {
        let argument = argument.to_str()?;
        let value = if argument == "--remote-debugging-port" {
            command.get(index + 1)?.to_str()?
        } else {
            argument.strip_prefix("--remote-debugging-port=")?
        };
        value.parse::<u16>().ok().filter(|port| *port != 0)
    })
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
    mut root_process: Option<CodexProcess>,
    debug_port: u16,
) -> anyhow::Result<()> {
    let mut missing = 0_u8;
    loop {
        tokio::time::sleep(Duration::from_secs(1)).await;
        if let Some(process) = root_process.as_mut() {
            if process.is_running().context("无法查询 Codex 主进程状态")? {
                missing = 0;
                continue;
            }
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
    #[cfg(windows)]
    {
        path.contains("\\windowsapps\\openai.codex_")
            || path.contains("\\windowsapps\\openai.codexbeta_")
            || path.contains("\\windowsapps\\openai.chatgpt-desktop_")
            || path.contains("\\openai\\chatgpt\\")
            || path.contains("\\openai codex\\")
    }
    #[cfg(target_os = "macos")]
    {
        path == "/applications/chatgpt.app/contents/macos/chatgpt"
            || path == "/applications/codex.app/contents/macos/codex"
            || path.ends_with("/applications/chatgpt.app/contents/macos/chatgpt")
            || path.ends_with("/applications/codex.app/contents/macos/codex")
    }
    #[cfg(all(not(windows), not(target_os = "macos")))]
    false
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
        #[cfg(windows)]
        let values = vec![
            path.join("app").join("ChatGPT.exe"),
            path.join("app").join("Codex.exe"),
            path.join("ChatGPT.exe"),
            path.join("Codex.exe"),
        ];
        #[cfg(target_os = "macos")]
        let values = vec![
            path.join("Contents").join("MacOS").join("ChatGPT"),
            path.join("Contents").join("MacOS").join("Codex"),
        ];
        #[cfg(all(not(windows), not(target_os = "macos")))]
        let values = Vec::new();
        values
    };
    candidates.into_iter().find(|candidate| candidate.is_file())
}

fn normalized_path(path: &Path) -> String {
    let value = path.to_string_lossy().to_ascii_lowercase();
    #[cfg(windows)]
    return value.replace('/', "\\");
    #[cfg(not(windows))]
    return value.replace('\\', "/");
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

    #[cfg(windows)]
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

    #[cfg(target_os = "macos")]
    #[test]
    fn only_known_openai_macos_process_paths_match() {
        assert!(is_openai_codex_process(
            OsStr::new("ChatGPT"),
            Some(Path::new(
                "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT"
            ))
        ));
        assert!(is_openai_codex_process(
            OsStr::new("Codex"),
            Some(Path::new(
                "/Users/test/Applications/Codex.app/Contents/MacOS/Codex"
            ))
        ));
        assert!(!is_openai_codex_process(
            OsStr::new("ChatGPT"),
            Some(Path::new("/Applications/Other.app/Contents/MacOS/ChatGPT"))
        ));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn desktop_proxy_prefers_dedicated_key_then_cli_then_tunnel() {
        assert_eq!(
            proxy_from_env_text(
                "TUNNEL_HTTP_PROXY=http://127.0.0.1:1\nCODEX_CLI_HTTP_PROXY=http://127.0.0.1:2\nCODEX_DESKTOP_HTTP_PROXY=http://127.0.0.1:3\n"
            ),
            Some("http://127.0.0.1:3".to_string())
        );
        assert_eq!(
            proxy_from_env_text("TUNNEL_HTTP_PROXY='http://127.0.0.1:7897'\n"),
            Some("http://127.0.0.1:7897".to_string())
        );
        assert_eq!(proxy_from_env_text("# empty\nOTHER=value\n"), None);
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
    fn discovers_actual_debug_port_and_rejects_missing_or_invalid_ports() {
        for (arguments, expected) in [
            (
                vec!["ChatGPT.exe", "--remote-debugging-port=59833"],
                Some(59833),
            ),
            (
                vec!["ChatGPT", "--remote-debugging-port", "9229"],
                Some(9229),
            ),
            (vec!["ChatGPT.exe"], None),
            (vec!["ChatGPT.exe", "--remote-debugging-port=0"], None),
            (vec!["ChatGPT.exe", "--remote-debugging-port=65536"], None),
            (vec!["ChatGPT.exe", "--remote-debugging-port"], None),
        ] {
            let arguments = arguments.into_iter().map(Into::into).collect::<Vec<_>>();
            assert_eq!(debug_port_from_command(&arguments), expected);
        }
    }

    #[test]
    fn observed_process_uses_start_time_to_reject_reused_pids() {
        let pid = Pid::from_u32(std::process::id());
        let mut system = System::new();
        refresh_process_identity(&mut system, ProcessesToUpdate::Some(&[pid]));
        let start_time = system.process(pid).unwrap().start_time();
        let mut process = CodexProcess::Observed {
            pid,
            start_time,
            system,
        };
        assert!(process.is_running().unwrap());
        if let CodexProcess::Observed { start_time, .. } = &mut process {
            *start_time += 1;
        }
        assert!(!process.is_running().unwrap());
    }

    #[tokio::test]
    async fn attached_session_without_process_handle_ends_when_debug_endpoint_is_gone() {
        use wiremock::{Mock, MockServer, ResponseTemplate, matchers::path};

        let server = MockServer::start().await;
        Mock::given(path("/json"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!([])))
            .mount(&server)
            .await;
        tokio::time::timeout(
            Duration::from_secs(8),
            wait_until_codex_stops(None, server.address().port()),
        )
        .await
        .unwrap()
        .unwrap();
    }

    #[test]
    fn recognizes_previous_and_current_launcher_names() {
        assert!(is_codex_plus_launcher(OsStr::new("codex-plus.exe")));
        assert!(is_codex_plus_launcher(OsStr::new("codex-plus-plus.exe")));
        assert!(!is_codex_plus_launcher(OsStr::new("other-launcher.exe")));
    }

    #[test]
    fn debug_port_selection_falls_back_when_preferred_port_stays_occupied() {
        let occupied = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let preferred_port = occupied.local_addr().unwrap().port();

        // 端口在整个重试窗口内都被占用：必须回退，并且记录到确实重试过。
        let selected = select_debug_port(preferred_port).unwrap();

        assert_ne!(selected.port, 0);
        assert_ne!(selected.port, preferred_port);
        assert!(selected.preferred_bind_error.is_some());
        assert!(selected.preferred_bind_attempts > 1);
        TcpListener::bind((Ipv4Addr::LOCALHOST, selected.port)).unwrap();

        drop(occupied);
        let recovered = select_debug_port(preferred_port).unwrap();
        assert_eq!(recovered.port, preferred_port);
        assert!(recovered.preferred_bind_error.is_none());
        assert_eq!(recovered.preferred_bind_attempts, 1);
    }

    #[test]
    fn debug_port_selection_waits_for_preferred_port_to_be_released() {
        let occupied = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let preferred_port = occupied.local_addr().unwrap().port();

        // 复现真实时序：旧实例已经退出，但监听套接字稍后才真正释放。
        // 单次 bind 会把这种窗口期误判成"端口被占用"并静默回退到随机端口，
        // 导致开发期的 --attach-existing（固定 9229）再也对不上。
        let release = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(500));
            drop(occupied);
        });

        let selected = select_debug_port(preferred_port).unwrap();
        release.join().unwrap();

        assert_eq!(
            selected.port, preferred_port,
            "端口在重试窗口内释放时应拿到首选端口，而不是回退"
        );
        assert!(selected.preferred_bind_error.is_none());
        assert!(
            selected.preferred_bind_attempts > 1,
            "应记录到确实等待重试过"
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn recognizes_an_unstable_code_signature_requirement() {
        // adhoc / linker 签名：requirement 退化成 cdhash，重新编译即失效。
        let adhoc = "Executable=/tmp/x\n# designated => cdhash H\"abc\"\n";
        let requirement = parse_designated_requirement(adhoc).expect("应解析出 requirement");
        assert_eq!(requirement, "cdhash H\"abc\"");
        assert!(!requirement_uses_stable_identity(&requirement));

        // 证书签名：requirement 只含 identifier 与证书指纹，与文件内容无关。
        let signed = concat!(
            "Executable=/tmp/x\n",
            "designated => identifier \"com.codex-plus.launcher\" ",
            "and certificate leaf = H\"6474f29d\"\n"
        );
        let requirement = parse_designated_requirement(signed).expect("应解析出 requirement");
        assert_eq!(
            requirement,
            "identifier \"com.codex-plus.launcher\" and certificate leaf = H\"6474f29d\""
        );
        assert!(requirement_uses_stable_identity(&requirement));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn missing_codesign_requirement_is_treated_as_unknown() {
        // 解析不出来时不能误判成"不稳"，否则每次启动都会写一条假告警。
        assert_eq!(parse_designated_requirement(""), None);
        assert_eq!(parse_designated_requirement("Executable=/tmp/x\n"), None);
        assert_eq!(
            parse_designated_requirement("codesign: not signed at all\n"),
            None
        );
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
