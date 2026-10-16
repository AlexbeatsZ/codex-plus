# Host release branches

The Windows hosts have separate maintained source and release versions. A host
check that merely skips registration does not satisfy the OMEN component boundary.

| Branch | Release | Contents | Deployment |
| --- | --- | --- | --- |
| `main` | `0.3.2` | Shared launcher and ordinary local-tools; no AI Decision/Todoist adapter | Common development and macOS base release |
| `codex/omen` | `0.3.2-omen` | Shared functionality; adapter source, imports, tests and compiled modules are absent | OMEN |
| `codex/rog` | `0.3.2-rog` | Shared functionality plus AI Decision/Todoist forwarding adapter | ROG |

`release-channel.json` records the branch, version and component inventory.
Both hosts retain their existing project directory and `codex-plus.exe` entry
point. Account/provider data and private Tunnel configuration are not shared.
The independent AI Decision service remains outside this repository.

## Maintaining shared fixes

Make common fixes on `main`, then merge `main` into each host branch. Preserve
the branch's Cargo version and release manifest while resolving conflicts.
Never merge the ROG branch into `main` or OMEN: promote only genuinely common
changes. Adapter changes belong exclusively to `codex/rog`.

After updating each branch, build local-tools with its normal clean build and
run `npm run release:verify -- --channel omen` or `--channel rog`. This checks
the release identity, import/registration and both source and compiled module
inventory. Base/OMEN checks also reject adapter symbols throughout local-tools
source, tests and build output, preventing a future merge from restoring them.
Run the existing renderer/MCP tests and any Rust checks required by the change.

## Files-only deployment

Checkout only the assigned host branch, clean-build local-tools and build the
Windows launcher. Verify the release manifest before copying the binary to the
standard release path. Record its version, branch and source commit in ignored
`.codex-plus/release.json`. No private bridge configuration is copied to OMEN.

For the 2026-10-01 Windows deployment, the user forbids starting, stopping or
restarting Codex, its launcher and Tunnel. Replacing files does not change a running process; actual
acceptance waits for the user's own next launcher start or Windows login. Keep
an old mapped EXE in the prescribed temporary directory when Windows refuses
deletion, and remove it only after its process naturally exits.

Mac release publication uses `bash macos/release.sh` and preserves the same
component boundary. It signs before replacing the fixed entry point and records
the source revision without restarting processes; see `macos-release.md`.
