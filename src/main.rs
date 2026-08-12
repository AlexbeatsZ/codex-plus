#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]

mod accounts;
mod broker;
mod cdp;
mod config;
#[allow(dead_code)]
mod protocol_proxy;
mod providers;
mod runtime;
mod service;

use anyhow::Context as _;
use serde_json::json;

use accounts::AccountPaths;
use service::AccountService;

const DEBUG_PORT: u16 = 9229;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LaunchMode {
    ApplyPendingAction,
    AttachExisting(u16),
    LoginStartup,
    Explicit,
}

impl LaunchMode {
    fn from_args(args: &[String]) -> Self {
        if args.iter().any(|arg| arg == "--apply-pending-action") {
            Self::ApplyPendingAction
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

    match LaunchMode::from_args(&args) {
        LaunchMode::ApplyPendingAction => runtime::apply_pending_action(&paths),
        LaunchMode::AttachExisting(debug_port) => run_attach_existing(paths, debug_port).await,
        LaunchMode::LoginStartup => run_login_startup(paths).await,
        LaunchMode::Explicit => run_managed_codex(paths, "launcher.explicit_start").await,
    }
}

async fn run_attach_existing(paths: AccountPaths, debug_port: u16) -> anyhow::Result<()> {
    let service = AccountService::new(paths.clone());
    runtime::append_log(
        &paths,
        "launcher.attach_existing",
        json!({"port": debug_port}),
    );
    config::reconcile_codex_config(&paths, broker::BROKER_PORT)?;
    let broker = broker::start(paths.clone()).await?;
    tokio::select! {
        result = cdp::run_watchdog(debug_port, service) => result,
        result = broker.wait() => result.context("API broker 意外结束"),
    }
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
    run_managed_codex(paths, "launcher.login_startup.takeover").await
}

async fn run_managed_codex(paths: AccountPaths, start_event: &str) -> anyhow::Result<()> {
    let service = AccountService::new(paths.clone());

    // Resolve read-only installation metadata before terminating the app, but the
    // state-changing lifecycle remains stop -> lock -> launch -> inject.
    let codex_executable = runtime::resolve_codex_executable()?;
    runtime::append_log(
        &paths,
        start_event,
        json!({"phases": runtime::START_PHASES}),
    );
    runtime::stop_existing_runtime(&paths)?;
    let _guard = runtime::acquire_launcher_guard(&paths)?;
    let broker = broker::start(paths.clone()).await?;
    config::reconcile_codex_config(&paths, broker::BROKER_PORT)?;
    let debug_port = runtime::select_debug_port(DEBUG_PORT)?;
    runtime::append_log(
        &paths,
        "launcher.debug_port.selected",
        json!({
            "preferredPort": DEBUG_PORT,
            "selectedPort": debug_port.port,
            "fallback": debug_port.preferred_bind_error.is_some(),
            "preferredBindError": debug_port.preferred_bind_error,
        }),
    );
    runtime::launch_codex(&codex_executable, debug_port.port)?;
    runtime::append_log(
        &paths,
        "launcher.codex_started",
        json!({"executable": codex_executable, "debugPort": debug_port.port}),
    );

    tokio::select! {
        result = cdp::run_watchdog(debug_port.port, service) => result.context("注入监测意外结束"),
        result = broker.wait() => result.context("API broker 意外结束"),
        () = runtime::wait_until_codex_stops(debug_port.port) => Ok(()),
    }
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
    }

    #[test]
    fn attach_existing_accepts_the_selected_dynamic_port() {
        assert_eq!(
            LaunchMode::from_args(&args(&["--attach-existing-port=59833"])),
            LaunchMode::AttachExisting(59833)
        );
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
