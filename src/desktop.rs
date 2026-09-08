use std::fs;
use std::io::{Read as _, Write as _};
use std::net::Ipv4Addr;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;

use axum::Router;
use axum::body::Body;
use axum::extract::{Json, State};
use axum::http::{HeaderMap, HeaderValue, Response, StatusCode, header};
use axum::routing::{get, post};
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
use tokio::net::{TcpListener, TcpStream};
use tokio::time::{Duration, timeout};

use crate::accounts::AccountPaths;
use crate::runtime::background_command;

pub const PREFERRED_DESKTOP_PORT: u16 = 43122;
pub const DESKTOP_TOKEN: &str = "codex-plus-desktop-loopback";
#[cfg(windows)]
const WINDOWS_SCRIPT: &str = include_str!("../desktop/windows.ps1");
#[cfg(target_os = "macos")]
const MACOS_SCRIPT: &str = include_str!("../desktop/macos.jxa");

#[cfg(target_os = "macos")]
#[path = "desktop_codex_task.rs"]
mod codex_task;

#[derive(Clone)]
struct DesktopState {
    state_dir: Arc<PathBuf>,
}

pub struct DesktopHandle {
    port: u16,
    preferred_bind_error: Option<String>,
    reused: bool,
    _task: Option<tokio::task::JoinHandle<anyhow::Result<()>>>,
}

impl DesktopHandle {
    pub fn port(&self) -> u16 {
        self.port
    }

    pub fn preferred_bind_error(&self) -> Option<&str> {
        self.preferred_bind_error.as_deref()
    }

    pub fn reused(&self) -> bool {
        self.reused
    }
}

pub async fn start(paths: &AccountPaths) -> anyhow::Result<DesktopHandle> {
    start_on_port(paths, PREFERRED_DESKTOP_PORT).await
}

async fn start_on_port(paths: &AccountPaths, preferred_port: u16) -> anyhow::Result<DesktopHandle> {
    let (listener, preferred_bind_error) = match TcpListener::bind((
        Ipv4Addr::LOCALHOST,
        preferred_port,
    ))
    .await
    {
        Ok(listener) => (listener, None),
        Err(preferred_error) => {
            if existing_helper_healthy(preferred_port).await {
                write_endpoint(paths, preferred_port, true)?;
                return Ok(DesktopHandle {
                    port: preferred_port,
                    preferred_bind_error: Some(preferred_error.to_string()),
                    reused: true,
                    _task: None,
                });
            }
            let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.map_err(|fallback_error| {
                anyhow::anyhow!(
                    "desktop helper bind failed on 127.0.0.1:{preferred_port}: {preferred_error}; fallback bind failed: {fallback_error}"
                )
            })?;
            (listener, Some(preferred_error.to_string()))
        }
    };
    let port = listener.local_addr()?.port();
    write_endpoint(paths, port, false)?;

    let state = DesktopState {
        state_dir: Arc::new(paths.state_dir.clone()),
    };
    let app = Router::new()
        .route("/health", get(|| async { "ok" }))
        .route("/v1/desktop", post(desktop_request))
        .with_state(state);
    let task = tokio::spawn(async move {
        axum::serve(listener, app)
            .await
            .map_err(anyhow::Error::from)
    });
    Ok(DesktopHandle {
        port,
        preferred_bind_error,
        reused: false,
        _task: Some(task),
    })
}

fn write_endpoint(paths: &AccountPaths, port: u16, reused: bool) -> anyhow::Result<()> {
    fs::create_dir_all(&paths.state_dir)?;
    let endpoint = json!({
        "version": 1,
        "port": port,
        "publisherPid": std::process::id(),
        "reused": reused,
    });
    fs::write(
        paths.state_dir.join("desktop-endpoint.json"),
        serde_json::to_vec_pretty(&endpoint)?,
    )?;
    Ok(())
}

async fn existing_helper_healthy(port: u16) -> bool {
    let check = async move {
        let mut stream = TcpStream::connect((Ipv4Addr::LOCALHOST, port)).await.ok()?;
        stream
            .write_all(b"GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
            .await
            .ok()?;
        let mut response = Vec::with_capacity(256);
        stream.read_to_end(&mut response).await.ok()?;
        let text = String::from_utf8_lossy(&response);
        Some(text.starts_with("HTTP/1.1 200") && text.ends_with("ok"))
    };
    timeout(Duration::from_millis(500), check)
        .await
        .ok()
        .flatten()
        .unwrap_or(false)
}

async fn desktop_request(
    State(state): State<DesktopState>,
    headers: HeaderMap,
    Json(request): Json<Value>,
) -> Response<Body> {
    if !authorized(&headers) {
        return error_response(StatusCode::UNAUTHORIZED, "desktop authorization failed");
    }
    let state_dir = (*state.state_dir).clone();
    let result = tokio::task::spawn_blocking(move || execute_request(request, &state_dir)).await;
    match result {
        Ok(Ok(value)) => json_response(StatusCode::OK, json!({"ok": true, "result": value})),
        Ok(Err(error)) => error_response(StatusCode::BAD_REQUEST, &error.to_string()),
        Err(error) => error_response(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string()),
    }
}

fn execute_request(mut request: Value, state_dir: &Path) -> anyhow::Result<Value> {
    let operation = request
        .get("operation")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow::anyhow!("desktop request requires operation"))?
        .to_string();
    #[cfg(target_os = "macos")]
    if operation == "permissions" {
        return Ok(macos_permission_status());
    }
    #[cfg(target_os = "macos")]
    if operation == "request_permissions" {
        if request.get("postEvents").and_then(Value::as_bool) == Some(true) {
            unsafe { CGRequestPostEventAccess() };
        }
        if request.get("screenCapture").and_then(Value::as_bool) == Some(true) {
            unsafe { CGRequestScreenCaptureAccess() };
        }
        return Ok(macos_permission_status());
    }
    #[cfg(target_os = "macos")]
    if operation == "codex_task_start" {
        return codex_task::start(&request, state_dir);
    }
    #[cfg(target_os = "macos")]
    if operation == "codex_task_status" {
        return codex_task::status(&request, state_dir);
    }
    #[cfg(target_os = "macos")]
    if operation == "codex_task_cancel" {
        return codex_task::cancel(&request, state_dir);
    }
    if operation == "screenshot" {
        let capture_dir = state_dir.join("desktop");
        fs::create_dir_all(&capture_dir)?;
        let output_path = capture_dir.join("latest.png");
        request["outputPath"] = Value::String(output_path.to_string_lossy().to_string());
        let platform = capture_screenshot(&request, &output_path)?;
        let (width, height) = png_dimensions(&output_path)?;
        let workspace_path = output_path
            .strip_prefix(Path::new(env!("CARGO_MANIFEST_DIR")))
            .ok()
            .map(|path| path.to_string_lossy().replace('\\', "/"));
        return Ok(json!({
            "path": output_path,
            "workspacePath": workspace_path,
            "width": width,
            "height": height,
            "platform": platform,
        }));
    }
    #[cfg(target_os = "macos")]
    if operation == "keyboard"
        && let Some(text) = request.get("text").and_then(Value::as_str)
    {
        return type_macos_text(text);
    }
    run_platform_script(&request)
}

#[cfg(target_os = "macos")]
fn type_macos_text(text: &str) -> anyhow::Result<Value> {
    use core_graphics::event::{CGEvent, CGEventFlags, CGEventTapLocation};
    use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};

    for character in text.chars() {
        let mut utf16 = [0_u16; 2];
        let units = character.encode_utf16(&mut utf16);
        for key_down in [true, false] {
            let source =
                CGEventSource::new(CGEventSourceStateID::CombinedSessionState).map_err(|_| {
                    anyhow::anyhow!("failed to create CoreGraphics keyboard event source")
                })?;
            let event = CGEvent::new_keyboard_event(source, 0, key_down)
                .map_err(|_| anyhow::anyhow!("failed to create CoreGraphics keyboard event"))?;
            event.set_flags(CGEventFlags::empty());
            event.set_string_from_utf16_unchecked(units);
            event.post(CGEventTapLocation::HID);
        }
        std::thread::sleep(std::time::Duration::from_millis(2));
    }
    Ok(json!({"typed": true, "length": text.chars().count()}))
}

#[cfg(target_os = "macos")]
#[link(name = "CoreGraphics", kind = "framework")]
unsafe extern "C" {
    fn CGPreflightPostEventAccess() -> bool;
    fn CGRequestPostEventAccess() -> bool;
    fn CGPreflightScreenCaptureAccess() -> bool;
    fn CGRequestScreenCaptureAccess() -> bool;
}

#[cfg(target_os = "macos")]
fn macos_permission_status() -> Value {
    let post_events = unsafe { CGPreflightPostEventAccess() };
    let screen_capture = unsafe { CGPreflightScreenCaptureAccess() };
    json!({
        "postEvents": post_events,
        "screenCapture": screen_capture,
    })
}

fn png_dimensions(path: &Path) -> anyhow::Result<(u32, u32)> {
    let mut header = [0_u8; 24];
    let mut file = fs::File::open(path)?;
    file.read_exact(&mut header)?;
    if &header[..8] != b"\x89PNG\r\n\x1a\n" || &header[12..16] != b"IHDR" {
        anyhow::bail!("desktop screenshot is not a valid PNG")
    }
    let width = u32::from_be_bytes(header[16..20].try_into().expect("PNG width is four bytes"));
    let height = u32::from_be_bytes(header[20..24].try_into().expect("PNG height is four bytes"));
    if width == 0 || height == 0 {
        anyhow::bail!("desktop screenshot has invalid dimensions")
    }
    Ok((width, height))
}

#[cfg(windows)]
fn capture_screenshot(request: &Value, _output_path: &Path) -> anyhow::Result<Value> {
    run_platform_script(request)
}

#[cfg(target_os = "macos")]
fn capture_screenshot(_request: &Value, output_path: &Path) -> anyhow::Result<Value> {
    let output = background_command("/usr/sbin/screencapture")
        .arg("-x")
        .arg("-m")
        .arg(output_path)
        .output()?;
    if !output.status.success() {
        anyhow::bail!(
            "screencapture failed: {}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }
    Ok(json!({"scope": "main"}))
}

#[cfg(not(any(windows, target_os = "macos")))]
fn capture_screenshot(_request: &Value, _output_path: &Path) -> anyhow::Result<Value> {
    anyhow::bail!("desktop screenshots are supported only on Windows and macOS")
}

#[cfg(windows)]
fn run_platform_script(request: &Value) -> anyhow::Result<Value> {
    run_script(
        "powershell.exe",
        &[
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            "-",
        ],
        WINDOWS_SCRIPT,
        request,
    )
}

#[cfg(target_os = "macos")]
fn run_platform_script(request: &Value) -> anyhow::Result<Value> {
    run_script(
        "/usr/bin/osascript",
        &["-l", "JavaScript", "-"],
        MACOS_SCRIPT,
        request,
    )
}

#[cfg(not(any(windows, target_os = "macos")))]
fn run_platform_script(_request: &Value) -> anyhow::Result<Value> {
    anyhow::bail!("desktop control is supported only on Windows and macOS")
}

fn run_script(
    program: &str,
    args: &[&str],
    script: &str,
    request: &Value,
) -> anyhow::Result<Value> {
    let mut command = background_command(program);
    command
        .args(args)
        .env(
            "CODEX_PLUS_DESKTOP_REQUEST",
            serde_json::to_string(request)?,
        )
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command.spawn()?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(script.as_bytes())?;
    }
    let output = child.wait_with_output()?;
    if !output.status.success() {
        anyhow::bail!(
            "desktop platform helper failed: {}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let payload = if !stdout.is_empty() { stdout } else { stderr };
    if payload.is_empty() {
        return Ok(json!({}));
    }
    serde_json::from_str(&payload).map_err(|error| {
        anyhow::anyhow!("desktop helper returned invalid JSON: {error}: {payload}")
    })
}

fn authorized(headers: &HeaderMap) -> bool {
    let expected = format!("Bearer {DESKTOP_TOKEN}");
    headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        == Some(expected.as_str())
}

fn json_response(status: StatusCode, value: Value) -> Response<Body> {
    let mut response = Response::new(Body::from(value.to_string()));
    *response.status_mut() = status;
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json; charset=utf-8"),
    );
    response
}

fn error_response(status: StatusCode, message: &str) -> Response<Body> {
    json_response(
        status,
        json!({"ok": false, "error": {"message": message, "type": "codex_plus_desktop_error"}}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener as StdTcpListener;
    use tempfile::TempDir;

    fn test_paths(temp: &TempDir) -> AccountPaths {
        AccountPaths {
            codex_home: temp.path().join("codex"),
            state_dir: temp.path().join("state"),
            usage_endpoint: String::new(),
        }
    }

    #[tokio::test]
    async fn binds_loopback_and_records_the_selected_endpoint() {
        let candidate = StdTcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let preferred_port = candidate.local_addr().unwrap().port();
        drop(candidate);
        let temp = TempDir::new().unwrap();
        let paths = test_paths(&temp);

        let handle = start_on_port(&paths, preferred_port).await.unwrap();
        assert_eq!(handle.port(), preferred_port);
        assert!(handle.preferred_bind_error().is_none());
        assert!(!handle.reused());
        let endpoint: Value = serde_json::from_slice(
            &fs::read(paths.state_dir.join("desktop-endpoint.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(endpoint["port"], preferred_port);
        handle._task.unwrap().abort();
    }

    #[tokio::test]
    async fn reuses_an_existing_codex_plus_desktop_helper_on_the_preferred_port() {
        let candidate = StdTcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let preferred_port = candidate.local_addr().unwrap().port();
        drop(candidate);
        let first_temp = TempDir::new().unwrap();
        let second_temp = TempDir::new().unwrap();
        let first = start_on_port(&test_paths(&first_temp), preferred_port)
            .await
            .unwrap();
        let second_paths = test_paths(&second_temp);
        let second = start_on_port(&second_paths, preferred_port).await.unwrap();

        assert_eq!(second.port(), preferred_port);
        assert!(second.reused());
        assert!(second._task.is_none());
        let endpoint: Value = serde_json::from_slice(
            &fs::read(second_paths.state_dir.join("desktop-endpoint.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(endpoint["reused"], true);
        first._task.unwrap().abort();
    }
}
