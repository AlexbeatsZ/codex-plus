# Tool boundaries

## Scope

This project is intentionally a tool-only MCP server. It provides local coding operations and a read-only Codex context bridge to ChatGPT mode. It has no browser controller, ChatGPT login/session handling, Responses API proxy, answer reader, widget, or custom user interface.

## Workspace model

One or more workspace roots are supplied with repeated `--root` arguments or the `CODEX_CHAT_LOCAL_ROOTS` environment variable. When neither is present, the current working directory is the only root.

Every path-based tool takes a `workspace` identifier and a relative path. Existing paths are resolved through real paths so a symlink cannot silently escape the configured root. New patch targets are checked through their nearest existing ancestor.

## Tools

| Tool | Effect | Boundary |
| --- | --- | --- |
| `workspace_info` | Lists configured workspaces | Read-only |
| `list_files` | Lists files with ripgrep | Read-only, root scoped |
| `search_text` | Searches text with ripgrep | Read-only, root scoped |
| `read_file` | Reads a bounded text range | Read-only, root scoped |
| `read_image` | Returns a supported image as MCP image content | Read-only, root scoped |
| `apply_patch` | Checks and applies a unified Git patch | Write, root scoped |
| `run_command` | Runs PowerShell or Bash from a workspace | Full current-user process authority |
| `git_status` | Reads repository status | Read-only |
| `git_diff` | Reads working-tree or staged differences | Read-only |
| `codex_instructions` | Loads the applicable global/project `AGENTS` chain | Read-only, fixed Codex-home files plus root-scoped project files |
| `list_codex_skills` | Lists current skill metadata without bodies | Read-only, approved Codex and configured skill roots |
| `load_codex_skill` | Loads one selected `SKILL.md` and resource inventory | Read-only, approved Codex and configured skill roots |
| `read_codex_skill_resource` | Reads one resource from a selected skill | Read-only, selected skill root scoped |

## Codex context boundary

The bridge mirrors only instructions that exist as local files and are visible to Codex: global/project `AGENTS` guidance plus discovered skill packages. It cannot access or reconstruct OpenAI's private platform system/developer prompts, and tool results state this boundary explicitly.

Skill discovery reads metadata at connection time to produce an at-most-8,000-character implicit-trigger catalog. Full bodies are excluded. Catalog and load calls rescan the source files, while `load_codex_skill` returns only one `SKILL.md`; supporting resources remain separate until requested. Skills marked `allow_implicit_invocation: false` stay available for explicit selection but are omitted from the startup trigger catalog.

Skill resource reads resolve real paths against the selected real skill root. A symlink or traversal cannot escape that root. Text reads are bounded, supported images have a separate size cap, and unrelated Codex files such as account credentials, sessions, memory stores, or `config.toml` contents are never returned.

## Important command boundary

`run_command` is deliberately transparent instead of pretending to be a sandbox. Its working directory is constrained to a configured workspace, but the spawned shell has the permissions of the user running the server and a shell command can address paths outside that workspace or access the network. Tool metadata marks it as destructive and open-world. Users who need stronger isolation should run this MCP server inside a dedicated container or virtual machine.

The stdio Tunnel channel is shared and serializes MCP calls behind an active command. Synchronous commands therefore default to 30 seconds and are capped at 45 seconds, leaving room inside the hosted request deadline for a response and a retry. Longer work must be split into bounded phases or started as a project-owned background job with later status checks; a single foreground command must not monopolize the Tunnel transport.

## Transport and secrets

The HTTP server binds to `127.0.0.1` by default. ChatGPT reaches it through an outbound Secure MCP Tunnel. Tunnel credentials belong to the tunnel client configuration and are never accepted, logged, or persisted by this MCP server.

On Windows, `scripts/tunnel-client.ps1` reads the ignored `.env.local` file and maps `OPENAI_API_KEY` to the tunnel client's expected `CONTROL_PLANE_API_KEY` only for the client process. The configured stdio command uses `scripts/start-tunnel-mcp.ps1`, which removes both variables before launching the MCP server so the child cannot inherit the runtime credential.
