use std::fs::{self, File};
use std::io::{BufRead as _, BufReader, Read as _};
use std::os::unix::process::ExitStatusExt as _;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64_STANDARD};
use serde_json::{Value, json};
use uuid::Uuid;

use crate::runtime::{apply_codex_desktop_proxy, background_command};

const JOB_META_VERSION: u64 = 3;
const DEFAULT_CODEX_CLI: &str = "/Applications/ChatGPT.app/Contents/Resources/codex";

pub(super) fn start(request: &Value, state_dir: &Path) -> anyhow::Result<Value> {
    let prompt = required_string(request, "prompt", "Codex desktop task requires a prompt")?;
    if prompt.len() > 64 * 1024 {
        anyhow::bail!("Codex desktop task prompt is too large");
    }

    let codex_path = codex_cli_path();
    if !codex_path.is_file() {
        anyhow::bail!("OpenAI Codex CLI not found at {}", codex_path.display());
    }

    let job_id = Uuid::new_v4().to_string();
    let job_dir = task_dir(state_dir, &job_id)?;
    fs::create_dir_all(&job_dir)?;
    let stdout_path = job_dir.join("stdout.jsonl");
    let stderr_path = job_dir.join("stderr.log");
    let exit_path = job_dir.join("exit.json");
    let cancel_path = job_dir.join("cancel.json");
    let _ = fs::remove_file(&exit_path);
    let _ = fs::remove_file(&cancel_path);

    let delegated_prompt = format!(
        "You are the macOS desktop execution delegate for codex-plus. Use only the official cua_repl Computer Use capability for GUI observation and interaction. Do not use shell, AppleScript, osascript, JXA, System Events, or direct CGEvent synthesis for GUI actions. Keep the final response concise. Respect all Computer Use confirmation requirements and never bypass an approval or safety boundary.\n\nTask:\n{prompt}"
    );

    let stdout_file = File::create(&stdout_path)?;
    let stderr_file = File::create(&stderr_path)?;
    let mut command = background_command(&codex_path);
    apply_codex_desktop_proxy(&mut command);
    command
        .arg("exec")
        .arg("--json")
        .arg("--color")
        .arg("never")
        .arg("--ephemeral")
        .arg("--skip-git-repo-check")
        .arg(&delegated_prompt)
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .env("CODEX_HOME", home_dir()?.join(".codex"))
        .stdin(Stdio::null())
        .stdout(Stdio::from(stdout_file))
        .stderr(Stdio::from(stderr_file));

    let mut child = command.spawn()?;
    let pid = child.id();
    let meta = json!({
        "version": JOB_META_VERSION,
        "jobId": job_id,
        "pid": pid,
        "stdoutPath": stdout_path,
        "stderrPath": stderr_path,
        "startedUnixMs": unix_ms(),
    });
    if let Err(error) = fs::write(job_dir.join("meta.json"), serde_json::to_vec_pretty(&meta)?) {
        let _ = child.kill();
        let _ = child.wait();
        return Err(error.into());
    }

    std::thread::spawn(move || {
        let payload = match child.wait() {
            Ok(status) => json!({
                "success": status.success(),
                "code": status.code(),
                "signal": status.signal(),
                "finishedUnixMs": unix_ms(),
            }),
            Err(error) => json!({
                "success": false,
                "error": error.to_string(),
                "finishedUnixMs": unix_ms(),
            }),
        };
        let _ = write_json_atomic(&exit_path, &payload);
    });

    Ok(json!({
        "jobId": job_id,
        "pid": pid,
        "state": "running",
        "mode": "codex-exec-ephemeral",
    }))
}

pub(super) fn status(request: &Value, state_dir: &Path) -> anyhow::Result<Value> {
    let job_id = required_string(request, "jobId", "Codex desktop task status requires jobId")?;
    let job_dir = task_dir(state_dir, job_id)?;
    if !job_dir.is_dir() {
        anyhow::bail!("Codex desktop task not found: {job_id}");
    }
    let wait_ms = request
        .get("waitMs")
        .and_then(Value::as_u64)
        .unwrap_or(0)
        .min(30_000);
    let deadline = Instant::now() + Duration::from_millis(wait_ms);
    loop {
        let summary = read_summary(&job_dir)?;
        let state = summary
            .get("state")
            .and_then(Value::as_str)
            .unwrap_or("failed");
        if !matches!(state, "running" | "canceling") || Instant::now() >= deadline {
            return Ok(summary);
        }
        std::thread::sleep(Duration::from_millis(250));
    }
}

pub(super) fn cancel(request: &Value, state_dir: &Path) -> anyhow::Result<Value> {
    let job_id = required_string(request, "jobId", "Codex desktop task cancel requires jobId")?;
    let job_dir = task_dir(state_dir, job_id)?;
    if !job_dir.is_dir() {
        anyhow::bail!("Codex desktop task not found: {job_id}");
    }
    let meta = read_meta(&job_dir)?;
    let pid = meta
        .get("pid")
        .and_then(Value::as_u64)
        .and_then(|value| u32::try_from(value).ok())
        .ok_or_else(|| anyhow::anyhow!("Codex desktop task metadata has no valid pid"))?;
    let cancel_path = job_dir.join("cancel.json");
    write_json_atomic(
        &cancel_path,
        &json!({"requestedUnixMs": unix_ms(), "pid": pid}),
    )?;
    let signaled = if process_alive(pid) {
        signal_process(pid, 15)?;
        true
    } else {
        false
    };
    Ok(json!({
        "jobId": job_id,
        "pid": pid,
        "state": if signaled { "canceling" } else { "canceled" },
        "signaled": signaled,
    }))
}

fn read_summary(job_dir: &Path) -> anyhow::Result<Value> {
    let meta = read_meta(job_dir)?;
    let pid = meta
        .get("pid")
        .and_then(Value::as_u64)
        .and_then(|value| u32::try_from(value).ok())
        .ok_or_else(|| anyhow::anyhow!("Codex desktop task metadata has no valid pid"))?;
    let stdout_path = meta
        .get("stdoutPath")
        .and_then(Value::as_str)
        .map(PathBuf::from)
        .unwrap_or_else(|| job_dir.join("stdout.jsonl"));
    let stderr_path = meta
        .get("stderrPath")
        .and_then(Value::as_str)
        .map(PathBuf::from)
        .unwrap_or_else(|| job_dir.join("stderr.log"));
    let events = read_jsonl(&stdout_path)?;
    let mut parsed = summarize_events(&events);
    let screenshot = parsed
        .latest_image
        .as_ref()
        .and_then(|(bytes, declared_mime)| write_task_image(job_dir, bytes, declared_mime).ok());

    let exit = read_optional_json(&job_dir.join("exit.json"));
    let canceled = job_dir.join("cancel.json").is_file();
    let alive = process_alive(pid);
    if parsed.last_error.is_none() {
        if let Some(exit_error) = exit
            .as_ref()
            .and_then(|value| value.get("error"))
            .and_then(Value::as_str)
        {
            parsed.last_error = Some(exit_error.to_string());
        } else if !alive && !parsed.turn_completed {
            let stderr = read_tail(&stderr_path, 4096).unwrap_or_default();
            if !stderr.trim().is_empty() {
                parsed.last_error = Some(stderr.trim().to_string());
            } else {
                parsed.last_error =
                    Some("Codex desktop task exited without a completed turn".to_string());
            }
        }
    }

    let approval = parsed
        .approval_app
        .as_ref()
        .map(|app| json!({"kind": "app", "app": app, "persistence": "not-yet-approved"}));
    let state = if canceled {
        if alive { "canceling" } else { "canceled" }
    } else if approval.is_some() && !alive {
        "approval_required"
    } else if parsed.turn_completed {
        "completed"
    } else if exit.is_some() || !alive {
        "failed"
    } else {
        "running"
    };

    Ok(json!({
        "jobId": meta.get("jobId").cloned().unwrap_or(Value::Null),
        "pid": pid,
        "threadId": parsed.thread_id,
        "state": state,
        "mode": "codex-exec-ephemeral",
        "finalText": parsed.final_text,
        "lastError": parsed.last_error,
        "toolCalls": parsed.tool_calls,
        "screenshot": screenshot,
        "approval": approval,
        "exit": exit,
    }))
}

#[derive(Default)]
struct ExecSummary {
    thread_id: Option<String>,
    final_text: Option<String>,
    last_error: Option<String>,
    tool_calls: u64,
    turn_completed: bool,
    latest_image: Option<(Vec<u8>, String)>,
    approval_app: Option<String>,
}

fn summarize_events(events: &[Value]) -> ExecSummary {
    let mut summary = ExecSummary::default();
    for event in events {
        match event.get("type").and_then(Value::as_str) {
            Some("thread.started") => {
                summary.thread_id = event
                    .get("thread_id")
                    .and_then(Value::as_str)
                    .map(str::to_string);
            }
            Some("turn.completed") => summary.turn_completed = true,
            Some("turn.failed") | Some("error") => {
                summary.last_error = event_message(event).or(summary.last_error);
            }
            Some("item.completed") => {
                let item = event.get("item").unwrap_or(&Value::Null);
                match item.get("type").and_then(Value::as_str) {
                    Some("agent_message") => {
                        if let Some(text) = item.get("text").and_then(Value::as_str) {
                            summary.final_text = Some(text.to_string());
                            if summary.approval_app.is_none() {
                                summary.approval_app = extract_unapproved_app(text);
                            }
                        }
                    }
                    Some("mcp_tool_call") => {
                        summary.tool_calls += 1;
                        if let Some(error) = item.get("error").and_then(Value::as_str) {
                            summary.last_error = Some(error.to_string());
                            if summary.approval_app.is_none() {
                                summary.approval_app = extract_unapproved_app(error);
                            }
                        }
                        if let Some(result) = item.get("result") {
                            if let Some(text) = result_content_text(result) {
                                if summary.approval_app.is_none() {
                                    summary.approval_app = extract_unapproved_app(&text);
                                }
                                if item.get("status").and_then(Value::as_str) == Some("failed") {
                                    summary.last_error = Some(text);
                                }
                            }
                            if let Some(image) = result_content_image(result) {
                                summary.latest_image = Some(image);
                            }
                        }
                    }
                    _ => {}
                }
            }
            _ => {}
        }
    }
    summary
}

fn event_message(event: &Value) -> Option<String> {
    ["message", "error"]
        .into_iter()
        .find_map(|key| event.get(key).and_then(Value::as_str).map(str::to_string))
}

fn extract_unapproved_app(text: &str) -> Option<String> {
    const PREFIXES: [&str; 4] = [
        "Computer Use was not approved to use ",
        "Computer Use is not approved to use ",
        "Computer Use was not approved to access ",
        "Computer Use is not approved to access ",
    ];
    for prefix in PREFIXES {
        let Some(rest) = text.split_once(prefix).map(|(_, rest)| rest) else {
            continue;
        };
        let app = rest
            .trim_start_matches(['\'', '"'])
            .split(|ch: char| matches!(ch, '\n' | '\r' | '.' | ',' | ';' | ':' | '\'' | '"'))
            .next()
            .unwrap_or("")
            .trim();
        if !app.is_empty() {
            return Some(app.to_string());
        }
    }
    None
}

fn result_content_text(result: &Value) -> Option<String> {
    let items = result.get("content")?.as_array()?;
    let values = items
        .iter()
        .filter(|item| item.get("type").and_then(Value::as_str) == Some("text"))
        .filter_map(|item| item.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>();
    (!values.is_empty()).then(|| values.join("\n"))
}

fn result_content_image(result: &Value) -> Option<(Vec<u8>, String)> {
    let items = result.get("content")?.as_array()?;
    for item in items.iter().rev() {
        if item.get("type").and_then(Value::as_str) != Some("image") {
            continue;
        }
        let data = item.get("data").and_then(Value::as_str)?;
        let bytes = BASE64_STANDARD.decode(data).ok()?;
        let declared = item
            .get("mimeType")
            .and_then(Value::as_str)
            .unwrap_or("application/octet-stream")
            .to_string();
        return Some((bytes, declared));
    }
    None
}

fn read_jsonl(path: &Path) -> anyhow::Result<Vec<Value>> {
    let file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.into()),
    };
    Ok(BufReader::new(file)
        .lines()
        .filter_map(Result::ok)
        .filter_map(|line| serde_json::from_str::<Value>(&line).ok())
        .collect())
}

fn read_meta(job_dir: &Path) -> anyhow::Result<Value> {
    Ok(serde_json::from_slice(&fs::read(
        job_dir.join("meta.json"),
    )?)?)
}

fn read_optional_json(path: &Path) -> Option<Value> {
    fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
}

fn read_tail(path: &Path, max_bytes: usize) -> anyhow::Result<String> {
    let mut bytes = Vec::new();
    File::open(path)?.read_to_end(&mut bytes)?;
    let start = bytes.len().saturating_sub(max_bytes);
    Ok(String::from_utf8_lossy(&bytes[start..]).to_string())
}

fn write_task_image(job_dir: &Path, bytes: &[u8], declared_mime: &str) -> anyhow::Result<Value> {
    let (extension, mime_type) = sniff_image(bytes, declared_mime);
    for stale in [job_dir.join("latest.png"), job_dir.join("latest.jpg")] {
        if stale.extension().and_then(|value| value.to_str()) != Some(extension) {
            let _ = fs::remove_file(stale);
        }
    }
    let path = job_dir.join(format!("latest.{extension}"));
    fs::write(&path, bytes)?;
    let workspace_path = path
        .strip_prefix(env!("CARGO_MANIFEST_DIR"))
        .ok()
        .map(|relative| relative.to_string_lossy().replace('\\', "/"));
    Ok(json!({
        "absolutePath": path,
        "workspacePath": workspace_path,
        "mimeType": mime_type,
        "bytes": bytes.len(),
    }))
}

fn sniff_image(bytes: &[u8], declared_mime: &str) -> (&'static str, &'static str) {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return ("png", "image/png");
    }
    if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        return ("jpg", "image/jpeg");
    }
    match declared_mime {
        "image/png" => ("png", "image/png"),
        "image/jpeg" | "image/jpg" => ("jpg", "image/jpeg"),
        _ => ("jpg", "application/octet-stream"),
    }
}

fn required_string<'a>(request: &'a Value, key: &str, message: &str) -> anyhow::Result<&'a str> {
    request
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| anyhow::anyhow!(message.to_string()))
}

fn validate_job_id(job_id: &str) -> anyhow::Result<()> {
    Uuid::parse_str(job_id)
        .map(|_| ())
        .map_err(|_| anyhow::anyhow!("invalid Codex desktop task id"))
}

fn task_dir(state_dir: &Path, job_id: &str) -> anyhow::Result<PathBuf> {
    validate_job_id(job_id)?;
    Ok(state_dir.join("desktop").join("codex-tasks").join(job_id))
}

fn home_dir() -> anyhow::Result<PathBuf> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or_else(|| anyhow::anyhow!("HOME is unavailable for Codex desktop task"))
}

fn codex_cli_path() -> PathBuf {
    std::env::var_os("CODEX_PLUS_CODEX_CLI_PATH")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(DEFAULT_CODEX_CLI))
}

fn write_json_atomic(path: &Path, value: &Value) -> anyhow::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, serde_json::to_vec_pretty(value)?)?;
    fs::rename(tmp, path)?;
    Ok(())
}

fn process_alive(pid: u32) -> bool {
    unsafe { kill(pid as i32, 0) == 0 }
}

fn signal_process(pid: u32, signal: i32) -> anyhow::Result<()> {
    let result = unsafe { kill(pid as i32, signal) };
    if result == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error().into())
    }
}

unsafe extern "C" {
    fn kill(pid: i32, signal: i32) -> i32;
}

fn unix_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn summarizes_codex_exec_events_and_extracts_image() {
        let image = BASE64_STANDARD.encode([0xff, 0xd8, 0xff, 0x00]);
        let events = vec![
            json!({"type":"thread.started","thread_id":"thread-1"}),
            json!({"type":"item.completed","item":{"type":"mcp_tool_call","server":"cua_repl","tool":"js","status":"completed","error":null,"result":{"content":[{"type":"image","data":image,"mimeType":"image/png"}]}}}),
            json!({"type":"item.completed","item":{"type":"agent_message","text":"done"}}),
            json!({"type":"turn.completed"}),
        ];
        let summary = summarize_events(&events);
        assert_eq!(summary.thread_id.as_deref(), Some("thread-1"));
        assert_eq!(summary.final_text.as_deref(), Some("done"));
        assert_eq!(summary.tool_calls, 1);
        assert!(summary.turn_completed);
        assert_eq!(
            summary.latest_image.as_ref().map(|value| value.0.len()),
            Some(4)
        );
    }

    #[test]
    fn recognizes_unapproved_app_errors() {
        assert_eq!(
            extract_unapproved_app("Computer Use was not approved to use Preview."),
            Some("Preview".to_string())
        );
        assert_eq!(extract_unapproved_app("other error"), None);
    }

    #[test]
    fn image_magic_overrides_misdeclared_mime() {
        assert_eq!(
            sniff_image(&[0xff, 0xd8, 0xff, 0x00], "image/png"),
            ("jpg", "image/jpeg")
        );
        assert_eq!(
            sniff_image(b"\x89PNG\r\n\x1a\nrest", "image/jpeg"),
            ("png", "image/png")
        );
    }
}
