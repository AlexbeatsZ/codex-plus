# App icon source

`app-icon.ico` is extracted from the `IDR_MAINFRAME` icon resource in the
official Windows Codex executable (`app/ChatGPT.exe`), installed as Microsoft
Store package `OpenAI.Codex` version `26.1013.3656.0` on 2026-10-21.

The original 16, 20, 24, 32, 40, 48, 64 and 256 pixel images are preserved
without redrawing or resizing. `build.rs` embeds this icon in the Windows
launcher so its file icon matches the installed Codex application.

`macos/Codex Plus.app/Contents/Resources/app-icon.icns` is copied without
conversion from the installed Mac Codex application, version `26.1013.40934`.
Its `CFBundleIconFile` declares `electron.icns` in
`/Applications/ChatGPT.app/Contents/Resources`. The launcher app's Info.plist
references the copied icon; the official application bundle is read only.

The icon is an OpenAI brand asset and is not covered by codex-plus's MIT
license. Codex and OpenAI names and marks belong to their respective owners;
codex-plus is an independent launcher.
