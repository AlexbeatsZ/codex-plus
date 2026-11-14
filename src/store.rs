//! Small JSON state files under `.codex-plus`: missing means default, writes
//! are atomic, and cross-process updates take an advisory file lock.
use std::fs::{self, File};
use std::path::Path;

use anyhow::Context as _;
use fs2::FileExt as _;
use serde::Serialize;
use serde::de::DeserializeOwned;

use crate::accounts::atomic_write;

/// Authoritative user configuration: a corrupt file is an error so it is never
/// silently overwritten by defaults.
pub fn load<T: DeserializeOwned + Default>(path: &Path, label: &str) -> anyhow::Result<T> {
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).with_context(|| format!("{label}无效")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(T::default()),
        Err(error) => Err(error).with_context(|| format!("无法读取{label}")),
    }
}

/// Rebuildable caches and ledgers: a corrupt file is moved aside once and the
/// caller continues with an empty value instead of failing every request.
pub fn load_or_quarantine<T: DeserializeOwned + Default>(path: &Path) -> T {
    let Ok(bytes) = fs::read(path) else {
        return T::default();
    };
    match serde_json::from_slice(&bytes) {
        Ok(value) => value,
        Err(_) => {
            let aside =
                path.with_extension(format!("corrupt-{}.json", crate::accounts::unix_now()));
            let _ = fs::rename(path, aside);
            T::default()
        }
    }
}

pub fn save<T: Serialize>(path: &Path, value: &T) -> anyhow::Result<()> {
    atomic_write(path, &serde_json::to_vec_pretty(value)?).map_err(anyhow::Error::from)
}

/// Holds an exclusive advisory lock on `path` until the returned file drops.
pub fn lock(path: &Path) -> anyhow::Result<File> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let file = File::options()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(path)?;
    file.lock_exclusive()?;
    Ok(file)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[test]
    fn corrupt_cache_is_moved_aside_and_authoritative_config_is_not() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("cache.json");
        fs::write(&path, "{broken").unwrap();
        let value: HashMap<String, String> = load_or_quarantine(&path);
        assert!(value.is_empty());
        assert!(!path.exists());
        fs::write(&path, "{broken").unwrap();
        assert!(load::<HashMap<String, String>>(&path, "测试配置").is_err());
        assert!(path.exists());
        let missing: HashMap<String, String> = load(&temp.path().join("none.json"), "x").unwrap();
        assert!(missing.is_empty());
    }
}
