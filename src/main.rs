#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]

mod accounts;
mod broker;
mod cdp;
mod config;
mod desktop;
mod integrations;
mod local_tools;
mod native_gateway;
mod pdf_preview;
#[allow(dead_code)]
mod protocol_proxy;
mod providers;
mod runtime;
mod service;
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
        println!("{}", json!({"brokerPort":broker.port()}));
        return broker.wait().await;
    }
    // 不阻止启动，只在身份不稳时留一条可查的日志：adhoc 签名会让 TCC 授权随重新
    // 编译失效，而症状要到下一次权限请求才暴露。
    #[cfg(target_os = "macos")]
    runtime::warn_if_code_signature_is_unstable(&paths);
    let mode = LaunchMode::from_args(&args);
    let mut _desktop: Option<desktop::DesktopHandle> = None;

    if mode != LaunchMode::ApplyPendingAction {
        local_tools::ensure_runtime(&paths).await;
        match desktop::start(&paths).await {
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
                _desktop = Some(handle);
            }
            Err(error) => runtime::append_log(
                &paths,
                "launcher.desktop_helper.failed",
                json!({"message": error.to_string()}),
            ),
        }
    }

    match mode {
        LaunchMode::ApplyPendingAction => runtime::apply_pending_action(&paths),
        LaunchMode::WebLogin => run_managed_codex(paths, "launcher.web_login_start", true).await,
        LaunchMode::AttachExisting(debug_port) => run_attach_existing(paths, debug_port).await,
        LaunchMode::LoginStartup => run_login_startup(paths).await,
        LaunchMode::Explicit => run_managed_codex(paths, "launcher.explicit_start", false).await,
    }
}

async fn run_attach_existing(paths: AccountPaths, debug_port: u16) -> anyhow::Result<()> {
    let _guard = runtime::acquire_launcher_guard(&paths)?;
    let service = BridgeService::new(paths.clone());
    runtime::append_log(
        &paths,
        "launcher.attach_existing",
        json!({"port": debug_port}),
    );
    let broker = broker::start(broker::PREFERRED_BROKER_PORT, service.apis.clone()).await?;
    log_broker_port_selection(&paths, &broker);
    config::reconcile_codex_config(&paths, broker.port())?;
    let session = CodexSession {
        process: runtime::observe_codex_on_port(debug_port),
        debug_port,
    };
    run_resident_launcher(paths, service, broker, session).await
}

async fn run_login_startup(paths: AccountPaths) -> anyhow::Result<()> {
    let monitor_guard = match runtime::acquire_launcher_guard(&paths) {
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
    runtime::append_log(&paths, "launcher.login_startup.waiting", json!({}));
    runtime::wait_until_codex_starts().await;
    runtime::append_log(&paths, "launcher.login_startup.detected", json!({}));
    drop(monitor_guard);
    run_managed_codex(paths, "launcher.login_startup.takeover", false).await
}

async fn run_managed_codex(
    paths: AccountPaths,
    start_event: &str,
    capture_web_login: bool,
) -> anyhow::Result<()> {
    let service = BridgeService::new(paths.clone());

    // Resolve read-only installation metadata before terminating the app, but the
    // state-changing lifecycle remains stop -> lock -> launch -> inject.
    let codex_target = runtime::resolve_codex_target()?;
    let codex_executable = codex_target.executable_path().to_path_buf();
    runtime::append_log(
        &paths,
        start_event,
        json!({"phases": runtime::START_PHASES}),
    );
    runtime::stop_existing_runtime(&paths)?;
    let _guard = runtime::acquire_launcher_guard(&paths)?;
    let broker = broker::start(broker::PREFERRED_BROKER_PORT, service.apis.clone()).await?;
    log_broker_port_selection(&paths, &broker);
    config::reconcile_codex_config(&paths, broker.port())?;
    let debug_port = runtime::select_debug_port(DEBUG_PORT)?;
    runtime::append_log(
        &paths,
        "launcher.debug_port.selected",
        json!({
            "preferredPort": DEBUG_PORT,
            "selectedPort": debug_port.port,
            "fallback": debug_port.preferred_bind_error.is_some(),
            "preferredBindError": debug_port.preferred_bind_error,
            "preferredBindAttempts": debug_port.preferred_bind_attempts,
        }),
    );
    let codex_process = runtime::launch_codex(&codex_target, debug_port.port)?;
    let codex_pid = codex_process.id();
    runtime::append_log(
        &paths,
        "launcher.codex_started",
        json!({"executable": codex_executable, "debugPort": debug_port.port, "pid": codex_pid}),
    );

    if capture_web_login {
        tokio::spawn(runtime::capture_web_login(paths.clone()));
    }

    let session = CodexSession {
        process: Some(codex_process),
        debug_port: debug_port.port,
    };
    run_resident_launcher(paths, service, broker, session).await
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
    tokio::select! {
        result = cdp::run_watchdog(session.debug_port, service) => result.context("注入监测意外结束"),
        result = runtime::wait_until_codex_stops(session.process, session.debug_port) => result.context("Codex 退出监测意外结束"),
    }
}

async fn recover_codex_session(paths: &AccountPaths) -> anyhow::Result<CodexSession> {
    runtime::append_log(paths, "launcher.codex.rearmed", json!({}));
    loop {
        let discovered = runtime::wait_until_codex_starts().await;
        runtime::append_log(
            paths,
            "launcher.codex.detected",
            json!({"pid": discovered.process.id(), "debugPort": discovered.debug_port}),
        );
        if let Some(debug_port) = discovered.debug_port {
            return Ok(CodexSession {
                process: Some(discovered.process),
                debug_port,
            });
        }
        let result: anyhow::Result<CodexSession> = (|| {
            let target = runtime::resolve_codex_target()?;
            runtime::stop_codex_runtime(paths)?;
            let debug_port = runtime::select_debug_port(DEBUG_PORT)?;
            let process = runtime::launch_codex(&target, debug_port.port)?;
            runtime::append_log(
                paths,
                "launcher.codex.restarted",
                json!({"pid": process.id(), "debugPort": debug_port.port}),
            );
            Ok(CodexSession {
                process: Some(process),
                debug_port: debug_port.port,
            })
        })();
        match result {
            Ok(session) => return Ok(session),
            Err(error) => runtime::append_log(
                paths,
                "launcher.codex.recovery_failed",
                json!({"message": format!("{error:#}")}),
            ),
        }
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
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

#[cfg(not(windows))]
fn show_error(message: &str) {
    eprintln!("{message}");
}
