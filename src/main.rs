#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]

mod accounts;
mod broker;
mod cdp;
mod config;
mod desktop;
mod http;
mod integrations;
mod layout;
mod local_tools;
mod native_gateway;
mod net;
mod pdf_preview;
mod protocol_proxy;
mod providers;
mod runtime;
mod service;
mod store;
mod subscription;

use anyhow::Context as _;
use serde_json::json;

use accounts::AccountPaths;
use service::BridgeService;

const DEBUG_PORT: u16 = 9229;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LaunchMode {
    ApplyPendingAction,
    WebLogin,
    AttachExisting(u16),
    LoginStartup,
    Explicit,
}

impl LaunchMode {
    fn from_args(args: &[String]) -> Self {
        if args.iter().any(|arg| arg == "--apply-pending-action") {
            Self::ApplyPendingAction
        } else if args.iter().any(|arg| arg == "--web-login") {
            Self::WebLogin
        } else if let Some(port) = args.iter().find_map(|arg| {
            arg.strip_prefix("--attach-existing-port=")
                .and_then(|value| value.parse::<u16>().ok())
        }) {
            Self::AttachExisting(port)
        } else if args.iter().any(|arg| arg == "--attach-existing") {
            Self::AttachExisting(DEBUG_PORT)
        } else if args.iter().any(|arg| arg == "--login-startup") {
            Self::LoginStartup
        } else {
            Self::Explicit
        }
    }
}

#[tokio::main]
async fn main() {
    if let Err(error) = main_impl().await {
        if let Ok(paths) = AccountPaths::discover() {
            runtime::append_log(
                &paths,
                "launcher.fatal",
                json!({"message": error.to_string()}),
            );
        }
        show_error(&format!("codex-plus 启动失败\n\n{error:#}"));
    }
}

async fn main_impl() -> anyhow::Result<()> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    let paths = AccountPaths::discover()?;
    // Isolated developer smoke tests: no CDP, helper, launcher lock, process
    // discovery or Tunnel lifecycle. Config generation is explicitly opt-in.
    #[cfg(debug_assertions)]
    if args.iter().any(|arg| arg == "--broker-only") {
        anyhow::ensure!(
            std::env::var_os("CODEX_PLUS_STATE_DIR").is_some()
                && std::env::var_os("CODEX_HOME").is_some(),
            "broker-only requires isolated CODEX_PLUS_STATE_DIR and CODEX_HOME"
        );
        let mut broker = broker::start_on_port(paths, 0).await?;
        if args.iter().any(|arg| arg == "--test-config") {
            config::reconcile_codex_config(&AccountPaths::discover()?, broker.port())?;
        }
        println!(
            "{}",
            json!({"brokerPort": broker.port(), "brokerToken": broker.token()})
        );
        return broker.wait().await;
    }
    // 不阻止启动，只在身份不稳时留一条可查的日志：adhoc 签名会让 TCC 授权随重新
    // 编译失效，而症状要到下一次权限请求才暴露。
    #[cfg(target_os = "macos")]
    runtime::warn_if_code_signature_is_unstable(&paths);
    let mode = LaunchMode::from_args(&args);
    if mode == LaunchMode::ApplyPendingAction {
        return runtime::apply_pending_action(&paths);
    }
    // The Tunnel sidecar is independent of the Codex lifecycle; a slow or hung
    // tunnel-client must not delay taking over Codex. The runtime waits for this
    // blocking task before the process exits, so even early exits finish it.
    let tools_paths = paths.clone();
    tokio::spawn(async move { local_tools::ensure_runtime(&tools_paths).await });

    match mode {
        LaunchMode::ApplyPendingAction => unreachable!("handled above"),
        LaunchMode::WebLogin => run_managed_codex(paths, "launcher.web_login_start", true).await,
        LaunchMode::AttachExisting(debug_port) => run_attach_existing(paths, debug_port).await,
        LaunchMode::LoginStartup => run_login_startup(paths).await,
        LaunchMode::Explicit => run_managed_codex(paths, "launcher.explicit_start", false).await,
    }
}

/// Everything one resident launcher owns while it holds the launcher lock.
struct Launcher {
    paths: AccountPaths,
    service: BridgeService,
    _guard: runtime::LauncherGuard,
    _desktop: Option<desktop::DesktopHandle>,
}

impl Launcher {
    /// The desktop helper starts only after the lock: before it, an older
    /// launcher may still own 43122 and would be "reused" moments before this
    /// launcher stops it, leaving the endpoint file pointing at a dead helper.
    async fn new(paths: AccountPaths, guard: runtime::LauncherGuard) -> Self {
        let desktop = match desktop::start(&paths).await {
            Ok(handle) => {
                runtime::append_log(
                    &paths,
                    "launcher.desktop_helper.ready",
                    json!({
                        "preferredPort": desktop::PREFERRED_DESKTOP_PORT,
                        "selectedPort": handle.port(),
                        "fallback": handle.preferred_bind_error().is_some() && !handle.reused(),
                        "reused": handle.reused(),
                        "preferredBindError": handle.preferred_bind_error(),
                    }),
                );
                Some(handle)
            }
            Err(error) => {
                runtime::append_log(
                    &paths,
                    "launcher.desktop_helper.failed",
                    json!({"message": error.to_string()}),
                );
                None
            }
        };
        Self {
            service: BridgeService::new(paths.clone()),
            paths,
            _guard: guard,
            _desktop: desktop,
        }
    }

    /// broker → config, shared by every takeover path.
    async fn start_broker(&self) -> anyhow::Result<broker::BrokerHandle> {
        let broker =
            broker::start(broker::PREFERRED_BROKER_PORT, self.service.apis.clone()).await?;
        log_broker_port_selection(&self.paths, &broker);
        config::reconcile_codex_config(&self.paths, broker.port())?;
        Ok(broker)
    }

    async fn run(self, broker: broker::BrokerHandle, session: CodexSession) -> anyhow::Result<()> {
        run_resident_launcher(self.paths, self.service, broker, session).await
    }
}

async fn run_attach_existing(paths: AccountPaths, debug_port: u16) -> anyhow::Result<()> {
    let launcher = Launcher::new(paths.clone(), runtime::acquire_launcher_guard(&paths)?).await;
    runtime::append_log(
        &paths,
        "launcher.attach_existing",
        json!({"port": debug_port}),
    );
    let broker = launcher.start_broker().await?;
    let session = CodexSession {
        process: runtime::observe_codex_on_port(debug_port),
        debug_port,
    };
    launcher.run(broker, session).await
}

async fn run_login_startup(paths: AccountPaths) -> anyhow::Result<()> {
    let guard = match runtime::acquire_launcher_guard(&paths) {
        Ok(guard) => guard,
        Err(error) => {
            runtime::append_log(
                &paths,
                "launcher.login_startup.skipped",
                json!({"reason": "launcherAlreadyRunning", "message": error.to_string()}),
            );
            return Ok(());
        }
    };
    // The lock is held from here on. Releasing and re-acquiring it around the
    // takeover would let another launcher slip in between.
    let launcher = Launcher::new(paths.clone(), guard).await;
    runtime::append_log(&paths, "launcher.login_startup.waiting", json!({}));
    let discovered = runtime::wait_until_codex_starts().await;
    runtime::append_log(&paths, "launcher.login_startup.detected", json!({}));
    let broker = launcher.start_broker().await?;
    let mut pending = Some(discovered);
    let session = loop {
        let discovered = match pending.take() {
            Some(discovered) => discovered,
            None => runtime::wait_until_codex_starts().await,
        };
        if let Some(session) = take_over(&paths, discovered).await {
            break session;
        }
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
    };
    launcher.run(broker, session).await
}

async fn run_managed_codex(
    paths: AccountPaths,
    start_event: &str,
    capture_web_login: bool,
) -> anyhow::Result<()> {
    // Resolve read-only installation metadata before terminating the app, but the
    // state-changing lifecycle remains stop -> lock -> launch -> inject.
    let codex_target = runtime::resolve_codex_target()?;
    runtime::append_log(
        &paths,
        start_event,
        json!({"phases": runtime::START_PHASES}),
    );
    let stop_paths = paths.clone();
    tokio::task::spawn_blocking(move || runtime::stop_existing_runtime(&stop_paths)).await??;
    let launcher = Launcher::new(paths.clone(), runtime::acquire_launcher_guard(&paths)?).await;
    let broker = launcher.start_broker().await?;
    let session = launch_session(&paths, &codex_target, "launcher.codex_started").await?;
    if capture_web_login {
        tokio::spawn(runtime::capture_web_login(paths.clone()));
    }
    launcher.run(broker, session).await
}

/// Selects the CDP port and launches Codex with it; shared by the first start
/// and by the controlled restart of an instance opened without CDP.
async fn launch_session(
    paths: &AccountPaths,
    target: &runtime::CodexAppTarget,
    event: &str,
) -> anyhow::Result<CodexSession> {
    let debug_port = runtime::select_debug_port(DEBUG_PORT).await?;
    runtime::append_log(
        paths,
        "launcher.debug_port.selected",
        json!({
            "preferredPort": DEBUG_PORT,
            "selectedPort": debug_port.port,
            "fallback": debug_port.preferred_bind_error.is_some(),
            "preferredBindError": debug_port.preferred_bind_error,
            "preferredBindAttempts": debug_port.preferred_bind_attempts,
        }),
    );
    let process = runtime::launch_codex(target, debug_port.port)?;
    runtime::append_log(
        paths,
        event,
        json!({
            "executable": target.executable_path(),
            "debugPort": debug_port.port,
            "pid": process.id(),
        }),
    );
    Ok(CodexSession {
        process: Some(process),
        debug_port: debug_port.port,
    })
}

struct CodexSession {
    process: Option<runtime::CodexProcess>,
    debug_port: u16,
}

async fn run_resident_launcher(
    paths: AccountPaths,
    service: BridgeService,
    mut broker: broker::BrokerHandle,
    session: CodexSession,
) -> anyhow::Result<()> {
    let result = tokio::select! {
        result = supervise_codex(
            session,
            |session| monitor_codex_session(service.clone(), session),
            || recover_codex_session(&paths),
        ) => result,
        result = broker.wait() => result.context("API broker 意外结束"),
    };
    broker.shutdown().await;
    result
}

async fn supervise_codex<Session, MonitorFuture, RecoverFuture>(
    mut session: Session,
    mut monitor: impl FnMut(Session) -> MonitorFuture,
    mut recover: impl FnMut() -> RecoverFuture,
) -> anyhow::Result<()>
where
    MonitorFuture: std::future::Future<Output = anyhow::Result<()>>,
    RecoverFuture: std::future::Future<Output = anyhow::Result<Session>>,
{
    loop {
        monitor(session).await?;
        session = recover().await?;
    }
}

async fn monitor_codex_session(
    service: BridgeService,
    session: CodexSession,
) -> anyhow::Result<()> {
    let paths = service.paths().clone();
    let stopped = tokio::select! {
        result = cdp::run_watchdog(session.debug_port, service) => return result.context("注入监测意外结束"),
        result = runtime::wait_until_codex_stops(session.process, session.debug_port) => result.context("Codex 退出监测意外结束")?,
    };
    if stopped == runtime::CodexStop::CdpLost {
        runtime::append_log(
            &paths,
            "launcher.codex.cdp_lost",
            json!({"debugPort": session.debug_port}),
        );
    }
    Ok(())
}

async fn recover_codex_session(paths: &AccountPaths) -> anyhow::Result<CodexSession> {
    runtime::append_log(paths, "launcher.codex.rearmed", json!({}));
    loop {
        let discovered = runtime::wait_until_codex_starts().await;
        if let Some(session) = take_over(paths, discovered).await {
            return Ok(session);
        }
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
    }
}

/// Attaches to an instance that already exposes CDP, or restarts only Codex
/// with CDP when it was opened without it. `None` means keep waiting.
async fn take_over(
    paths: &AccountPaths,
    mut discovered: runtime::DiscoveredCodex,
) -> Option<CodexSession> {
    runtime::append_log(
        paths,
        "launcher.codex.detected",
        json!({"pid": discovered.process.id(), "debugPort": discovered.debug_port}),
    );
    if let Some(debug_port) = discovered.debug_port {
        // An instance whose CDP endpoint stays down is watched quietly until
        // it either serves CDP again or exits; it is never restarted for this.
        let mut waited = false;
        while !cdp::endpoint_available(debug_port).await {
            if !discovered.process.is_running().unwrap_or(false) {
                return None;
            }
            if !waited {
                runtime::append_log(
                    paths,
                    "launcher.codex.cdp_waiting",
                    json!({"pid": discovered.process.id(), "debugPort": debug_port}),
                );
                waited = true;
            }
            tokio::time::sleep(std::time::Duration::from_secs(5)).await;
        }
        return Some(CodexSession {
            process: Some(discovered.process),
            debug_port,
        });
    }
    drop(discovered);
    let result: anyhow::Result<CodexSession> = async {
        let target = runtime::resolve_codex_target()?;
        let stop_paths = paths.clone();
        tokio::task::spawn_blocking(move || runtime::stop_codex_runtime(&stop_paths)).await??;
        launch_session(paths, &target, "launcher.codex.restarted").await
    }
    .await;
    match result {
        Ok(session) => Some(session),
        Err(error) => {
            runtime::append_log(
                paths,
                "launcher.codex.recovery_failed",
                json!({"message": format!("{error:#}")}),
            );
            None
        }
    }
}

fn log_broker_port_selection(paths: &AccountPaths, broker: &broker::BrokerHandle) {
    runtime::append_log(
        paths,
        "launcher.broker_port.selected",
        json!({
            "preferredPort": broker::PREFERRED_BROKER_PORT,
            "selectedPort": broker.port(),
            "fallback": broker.preferred_bind_error().is_some(),
            "preferredBindError": broker.preferred_bind_error(),
        }),
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| value.to_string()).collect()
    }

    #[test]
    fn launch_mode_keeps_click_and_login_startup_distinct() {
        assert_eq!(LaunchMode::from_args(&args(&[])), LaunchMode::Explicit);
        assert_eq!(
            LaunchMode::from_args(&args(&["--login-startup"])),
            LaunchMode::LoginStartup
        );
    }

    #[test]
    fn internal_modes_take_priority_over_login_startup() {
        assert_eq!(
            LaunchMode::from_args(&args(&["--login-startup", "--attach-existing"])),
            LaunchMode::AttachExisting(DEBUG_PORT)
        );
        assert_eq!(
            LaunchMode::from_args(&args(&["--login-startup", "--apply-pending-action"])),
            LaunchMode::ApplyPendingAction
        );
        assert_eq!(
            LaunchMode::from_args(&args(&["--login-startup", "--web-login"])),
            LaunchMode::WebLogin
        );
    }

    #[test]
    fn attach_existing_accepts_the_selected_dynamic_port() {
        assert_eq!(
            LaunchMode::from_args(&args(&["--attach-existing-port=59833"])),
            LaunchMode::AttachExisting(59833)
        );
    }

    #[tokio::test]
    async fn resident_launcher_rearms_after_repeated_exits_without_replacing_broker() {
        use std::cell::{Cell, RefCell};

        let temp = tempfile::TempDir::new().unwrap();
        let paths = AccountPaths {
            codex_home: temp.path().join("codex"),
            state_dir: temp.path().join("state"),
            usage_endpoint: String::new(),
        };
        let mut broker = broker::start_on_port(paths, 0).await.unwrap();
        let broker_port = broker.port();
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let sessions = RefCell::new(Vec::new());
        let next_port = Cell::new(59833_u16);
        let monitor = |debug_port| {
            sessions.borrow_mut().push(debug_port);
            let client = client.clone();
            async move {
                assert_eq!(
                    client
                        .get(format!("http://127.0.0.1:{broker_port}/health"))
                        .send()
                        .await?
                        .text()
                        .await?,
                    "ok"
                );
                if debug_port == 59834 {
                    anyhow::bail!("finished isolated lifecycle test");
                }
                Ok(())
            }
        };
        let recover = || {
            let debug_port = next_port.get();
            next_port.set(debug_port + 1);
            std::future::ready(Ok(debug_port))
        };
        let result = tokio::select! {
            result = supervise_codex(DEBUG_PORT, monitor, recover) => result,
            _ = broker.wait() => panic!("broker stopped between Codex sessions"),
        };
        assert!(
            result
                .unwrap_err()
                .to_string()
                .contains("isolated lifecycle")
        );
        assert_eq!(*sessions.borrow(), [DEBUG_PORT, 59833, 59834]);
        broker.shutdown().await;
    }

    #[tokio::test]
    async fn resident_launcher_waits_for_user_reopen_instead_of_exiting_or_relaunching() {
        use std::cell::Cell;

        let monitored = Cell::new(0);
        let waiting = Cell::new(false);
        let result = tokio::time::timeout(
            std::time::Duration::from_millis(30),
            supervise_codex(
                (),
                |_| {
                    monitored.set(monitored.get() + 1);
                    std::future::ready(Ok(()))
                },
                || {
                    waiting.set(true);
                    std::future::pending::<anyhow::Result<()>>()
                },
            ),
        )
        .await;
        assert!(result.is_err());
        assert_eq!(monitored.get(), 1);
        assert!(waiting.get());
    }
}

#[cfg(windows)]
fn show_error(message: &str) {
    use windows::Win32::UI::WindowsAndMessaging::{MB_ICONERROR, MB_OK, MessageBoxW};
    use windows::core::PCWSTR;

    fn wide(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(std::iter::once(0)).collect()
    }
    let message = wide(message);
    let title = wide("codex-plus");
    unsafe {
        let _ = MessageBoxW(
            None,
            PCWSTR(message.as_ptr()),
            PCWSTR(title.as_ptr()),
            MB_OK | MB_ICONERROR,
        );
    }
}

/// LaunchAgent and account-switch helpers have no terminal, so a fatal start
/// error is also shown as a system alert. The message is passed as an
/// argument, never interpolated into the AppleScript source.
#[cfg(target_os = "macos")]
fn show_error(message: &str) {
    eprintln!("{message}");
    let _ = std::process::Command::new("/usr/bin/osascript")
        .args([
            "-e",
            "on run argv",
            "-e",
            "display alert \"codex-plus\" message (item 1 of argv) as critical",
            "-e",
            "end run",
            message,
        ])
        .stdin(std::process::Stdio::null())
        .spawn();
}

#[cfg(all(not(windows), not(target_os = "macos")))]
fn show_error(message: &str) {
    eprintln!("{message}");
}
