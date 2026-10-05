# macOS release lifecycle

Mac uses the shared `main`/`base` edition. Windows compatibility fixes are already
shared through that branch; ROG-only modules must not be merged into the Mac tree.

`bash macos/release.sh` clean-builds local-tools and verifies the base component
inventory, then builds Rust in `target/macos-build`. Cargo's artifact messages
identify the executable, including builds with an explicit `--target`. The fixed
entry point remains `target/release/codex-plus` for the app wrapper and LaunchAgent.

Publish copies the result into a staging directory on the destination filesystem,
signs and verifies that copy, prepares `.codex-plus/release.json`, then atomically
renames the executable into place. Compiler or signing failures leave the previous
entry point and record intact. The release record contains the base version,
source commit, dirty state, architecture and build timestamp. A failed metadata
rename after binary publication is reported as an error; rerunning publication
repairs the record. This does not restart any process or reload launchd.

The stable designated requirement must contain both
`identifier "com.codex-plus.launcher"` and the selected certificate fingerprint.
The signer skips replacement only when both match and signature verification
succeeds. Matching only the certificate would accept another app's identity.
Do not change that identifier or certificate for a routine rebuild: existing
macOS permissions depend on the requirement.

`npm run macos:test` performs native compilation, signing, execution, idempotence
and failed-publication recovery checks in `/tmp/.agents`. It skips when not on
macOS or when the configured signing identity is unavailable.

The loaded LaunchAgent must retain `ProcessType=Interactive` and
`AbandonProcessGroup=true`, as described in `account-switch-lifecycle.md`.
Release publication does not run `install.sh`: that script reloads the job.
Validate renderer compatibility against the installed official application
separately; a successful release build is not evidence of a live model request.
