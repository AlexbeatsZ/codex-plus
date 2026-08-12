fn main() {
    #[cfg(windows)]
    {
        let mut resource = winresource::WindowsResource::new();
        resource
            .set_icon("assets/app-icon.ico")
            .set("ProductName", "codex-plus")
            .set(
                "FileDescription",
                "codex-plus account switcher for OpenAI Codex",
            )
            .set("CompanyName", "codex-plus")
            .set("OriginalFilename", "codex-plus.exe");
        resource
            .compile()
            .expect("failed to compile Windows resources");
    }
}
