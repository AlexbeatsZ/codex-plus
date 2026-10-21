use std::sync::OnceLock;

const SCRIPT: &str = include_str!("../assets/pdf-preview.js");
const CMAPS: &str = include_str!("../assets/pdf-cmaps.json");

pub fn browser_script() -> &'static str {
    static SCRIPT_WITH_RESOURCES: OnceLock<String> = OnceLock::new();
    SCRIPT_WITH_RESOURCES.get_or_init(|| SCRIPT.replace("__CODEX_PLUS_PDF_CMAPS__", CMAPS))
}
