# App icon source

`app-icon.ico` is extracted from the `IDR_MAINFRAME` icon resource in the
official Windows Codex executable (`app/ChatGPT.exe`), installed as Microsoft
Store package `OpenAI.Codex` version `26.1013.3656.0` on 2026-10-21.

The original 16, 20, 24, 32, 40, 48, 64 and 256 pixel images are preserved
without redrawing or resizing. `build.rs` embeds this icon in the Windows
launcher so its file icon matches the installed Codex application.

The icon is an OpenAI brand asset and is not covered by codex-plus's MIT
license. Codex and OpenAI names and marks belong to their respective owners;
codex-plus is an independent launcher.
