# Codex Chat Local Tools

A tool-only MCP component embedded in the `codex-plus` repository that gives Codex ChatGPT mode access to explicitly selected local coding workspaces and the local Codex guidance used to work in them.

It intentionally does **not** contain the browser automation, ChatGPT response proxy, answer scraping, model injection, or UI modifications from [`miuuyy/codex-chatgpt-web`](https://github.com/miuuyy/codex-chatgpt-web).

## Included tools

- Discover configured workspaces.
- List files and search text with ripgrep.
- Read bounded text ranges and supported images.
- Validate and apply unified Git patches.
- Run PowerShell on Windows or Bash on Linux/macOS.
- Inspect Git status and diffs.
- Inject the effective global and configured workspace-root `AGENTS.md` instruction chain into MCP initialization, then reload nested/current chains on demand.
- Discover Codex skills by metadata, load one matching `SKILL.md`, then fetch only the referenced resources needed for the task.

Path-based tools enforce configured workspace roots. `run_command` starts inside a workspace but is **not** an OS sandbox: it has the permissions and network access of the account running this server. Foreground commands default to 30 seconds and are capped at 45 seconds; a timeout terminates the spawned process tree and force-closes inherited pipes so one descendant cannot block the shared Tunnel stdio channel. Split or background longer work and inspect it in later calls.

## Codex context synchronization

The context bridge injects the global and configured workspace-root `AGENTS` chain into the MCP `initialize` response. The payload follows Codex precedence, is deduplicated across workspaces, and is bounded by `project_doc_max_bytes` (32 KiB by default), so the connected AI sees those instructions before choosing or calling a tool.

Skills continue to use progressive disclosure instead of placing every skill body in the MCP prompt:

1. MCP metadata exposes a compact, bounded catalog of skill names and descriptions for implicit matching.
2. `list_codex_skills` refreshes and filters the full metadata-only catalog when needed.
3. `load_codex_skill` loads exactly one current `SKILL.md` and returns a resource inventory.
4. `read_codex_skill_resource` reads only a referenced file or supported image needed by that skill.

`codex_instructions` loads the current global and project `AGENTS` chain for a target directory, including override precedence and Codex's configured project-document size limit. Use it for nested instructions or changes made after the long-running MCP process started; source bodies are read on every call. The startup AGENTS payload and compact trigger catalog are rebuilt when the MCP process starts.

Discovery includes `~/.codex/skills`, `~/.agents/skills`, applicable repository `.agents/skills`, enabled/installed Codex plugin caches, and extra roots supplied by `--skill-root` or `CODEX_CHAT_SKILL_ROOTS`. This mirrors local Codex-visible guidance only; OpenAI's platform system/developer prompts are private runtime inputs and cannot be read by this server.

## Requirements

- Node.js 20 or newer.
- `git` and `rg` (ripgrep) available on `PATH`.
- PowerShell on Windows, Bash on Linux/macOS.

## Build and run

```powershell
cd C:\Users\Meta\Project\Workspaces\codex-plus\local-tools
npm install
npm run build
.\scripts\start.ps1 -Root C:\Users\Meta\Project\Workspaces\YourProject
```

The server listens at `http://127.0.0.1:3344/mcp`; `http://127.0.0.1:3344/healthz` is a small local health check. Add more roots by passing an array:

```powershell
.\scripts\start.ps1 -Root C:\Project\One,C:\Project\Two
```

For a client that launches a stdio MCP process directly:

```powershell
node .\dist\cli.js --stdio --root C:\Users\Meta\Project\Workspaces\YourProject
```

Optional context controls:

```powershell
node .\dist\cli.js --stdio --root C:\Project\One --codex-home C:\Users\Meta\.codex --skill-root C:\Project\SharedSkills
node .\dist\cli.js --stdio --root C:\Project\One --no-codex-context
```

## Codex plugin descriptor

The repository includes `.codex-plugin/plugin.json` and `.mcp.json`. The descriptor expects the loopback HTTP server to be running on port 3344. No widget or copied static skill bundle is included: MCP injects the bounded AGENTS chain at startup and reads nested instructions and skill bodies from their current local sources when requested.

## Connect from ChatGPT mode

ChatGPT cannot directly dial a private loopback endpoint. Use OpenAI's Secure MCP Tunnel, which makes an outbound connection from this machine without exposing a public inbound port.

1. Build this project and install the official client into this project's ignored `.tools` directory:

   ```powershell
   npm run build
   .\scripts\install-tunnel-client.ps1
   ```

2. Create a tunnel in [OpenAI Platform tunnel settings](https://platform.openai.com/settings/organization/tunnels). The runtime key principal needs **Tunnels Read + Use**; creating the tunnel needs **Tunnels Read + Manage**.
3. Save the runtime key as `OPENAI_API_KEY` in the ignored `.env.local` file. The wrapper maps it to `CONTROL_PLANE_API_KEY` for `tunnel-client` and removes both variables before the MCP child starts.
4. Initialize a project-local stdio profile, replacing the sample tunnel ID and workspace root:

   ```powershell
   # Use forward slashes: tunnel-client parses backslashes as command escapes.
   $mcpCommand = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:/Users/Meta/Project/Workspaces/codex-plus/local-tools/scripts/start-tunnel-mcp.ps1 -Root C:/Users/Meta/Project/Workspaces/codex-plus'
   .\scripts\tunnel-client.ps1 init --sample sample_mcp_stdio_local --profile codex-chat-local-tools --profile-dir .\.tunnel-client --tunnel-id tunnel_0123456789abcdef0123456789abcdef --mcp-command $mcpCommand
   ```

5. Validate the profile, then either run it in the foreground or let `codex-plus.exe` register the managed local runtime automatically:

   ```powershell
   .\scripts\tunnel-client.ps1 doctor --profile codex-chat-local-tools --profile-dir .\.tunnel-client --explain

   # Foreground
   .\scripts\tunnel-client.ps1 run --profile codex-chat-local-tools --profile-dir .\.tunnel-client

   # Manual equivalent of the codex-plus startup integration
   .\scripts\tunnel-client.ps1 runtimes connect --alias codex-chat-local-tools --tunnel-id tunnel_0123456789abcdef0123456789abcdef --profile codex-chat-local-tools --profile-dir .\.tunnel-client --mcp-command $mcpCommand --runtime-api-key env:CONTROL_PLANE_API_KEY
   .\scripts\tunnel-client.ps1 runtimes status codex-chat-local-tools --json
   ```

6. In ChatGPT/Codex Chat mode, enable Developer mode under **Settings → Security and login**, add an app using **Tunnel**, and review the thirteen tools before enabling it.

The OpenAI API key used by `tunnel-client` is external to this server. Never commit `.env.local`, put the key in a script or profile, or pass it to the MCP process. The parent `codex-plus.exe` starts this managed runtime on explicit, attach, web-login, and Windows login-startup paths.

Official references:

- [Build an MCP server](https://developers.openai.com/plugins/build/mcp-server)
- [Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)
- [Connect from ChatGPT](https://developers.openai.com/plugins/deploy/connect-chatgpt)
- [Build skills](https://developers.openai.com/codex/skills)
- [Custom instructions with AGENTS.md](https://developers.openai.com/codex/guides/agents-md)

## Checks

```powershell
npm run check
```

The test suite creates disposable workspaces only under `C:\Users\Meta\AppData\Local\Temp\.agents\` on Windows or `/tmp/.agents/` elsewhere.
