//! Repository layout and `.env.local` parsing shared by every module.
//!
//! The launcher is always run from `<repository>/target/<profile>/codex-plus`.
//! Runtime state, local-tools and the Codex task working directory all hang
//! off that repository root, so it is derived once here instead of each module
//! mixing compile-time `CARGO_MANIFEST_DIR` with its own executable walk.
use std::fs;
use std::path::{Path, PathBuf};

pub const STATE_DIR: &str = ".codex-plus";
pub const LOCAL_TOOLS_DIR: &str = "local-tools";

/// The repository that owns the running executable. A binary inside any
/// `target` directory belongs to that directory's parent; other binaries
/// (tests, ad-hoc copies) fall back to the compile-time source tree.
pub fn repository_root() -> PathBuf {
    if let Ok(executable) = std::env::current_exe() {
        for ancestor in executable.ancestors() {
            if ancestor.file_name().is_some_and(|name| name == "target")
                && let Some(root) = ancestor.parent()
            {
                return root.to_path_buf();
            }
        }
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

pub fn local_tools_env_file() -> PathBuf {
    repository_root().join(LOCAL_TOOLS_DIR).join(".env.local")
}

/// Last non-empty assignment wins, matching dotenv override order. Comments,
/// blank lines and an optional `export ` prefix are ignored.
pub fn env_value(text: &str, name: &str) -> Option<String> {
    text.lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .filter_map(|line| line.split_once('='))
        .filter(|(key, _)| key.trim().trim_start_matches("export ").trim() == name)
        .map(|(_, value)| unquote(value.trim()).trim().to_string())
        .filter(|value| !value.is_empty())
        .next_back()
}

pub fn env_file_value(path: &Path, name: &str) -> anyhow::Result<Option<String>> {
    match fs::read_to_string(path) {
        Ok(text) => Ok(env_value(&text, name)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(anyhow::Error::from(error)
            .context(format!("无法读取 local-tools 配置文件 {}", path.display()))),
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn env_values_ignore_comments_quotes_and_prefer_the_last_assignment() {
        let text = "# TUNNEL_ID=commented\nTUNNEL_ID=first\nexport TUNNEL_ID='second'\nEMPTY=\nOTHER = \"x\"\n";
        assert_eq!(env_value(text, "TUNNEL_ID").as_deref(), Some("second"));
        assert_eq!(env_value(text, "OTHER").as_deref(), Some("x"));
        assert_eq!(env_value(text, "EMPTY"), None);
        assert_eq!(env_value(text, "MISSING"), None);
    }
}
