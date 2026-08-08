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

    if args.iter().any(|arg| arg == "--apply-pending-action") {
        return runtime::apply_pending_action(&paths);
    }

    let service = AccountService::new(paths.clone());
    if args.iter().any(|arg| arg == "--attach-existing") {
        runtime::append_log(
            &paths,
            "launcher.attach_existing",
            json!({"port": DEBUG_PORT}),
        );
        config::reconcile_codex_config(&paths, broker::BROKER_PORT)?;
        let broker = broker::start(paths.clone()).await?;
        return tokio::select! {
            result = cdp::run_watchdog(DEBUG_PORT, service) => result,
            result = broker.wait() => result.context("API broker 意外结束"),
        };
    }

    // Resolve read-only installation metadata before terminating the app, but the
    // state-changing lifecycle remains stop -> lock -> launch -> inject.
    let codex_executable = runtime::resolve_codex_executable()?;
    runtime::append_log(
        &paths,
        "launcher.explicit_start",
        json!({"phases": runtime::START_PHASES}),
    );
    runtime::stop_existing_runtime(&paths)?;
    let _guard = runtime::acquire_launcher_guard(&paths)?;
    let broker = broker::start(paths.clone()).await?;
    config::reconcile_codex_config(&paths, broker::BROKER_PORT)?;
    runtime::launch_codex(&codex_executable, DEBUG_PORT)?;
    runtime::append_log(
        &paths,
        "launcher.codex_started",
        json!({"executable": codex_executable, "debugPort": DEBUG_PORT}),
    );

    tokio::select! {
        result = cdp::run_watchdog(DEBUG_PORT, service) => result.context("注入监测意外结束"),
        result = broker.wait() => result.context("API broker 意外结束"),
        () = runtime::wait_until_codex_stops(DEBUG_PORT) => Ok(()),
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
