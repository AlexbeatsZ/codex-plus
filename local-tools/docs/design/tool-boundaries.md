# Tool boundaries

## Scope

This project is intentionally a tool-only MCP server. It provides local coding operations to ChatGPT mode and has no browser controller, ChatGPT login/session handling, Responses API proxy, answer reader, widget, or custom user interface.

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

## Important command boundary

`run_command` is deliberately transparent instead of pretending to be a sandbox. Its working directory is constrained to a configured workspace, but the spawned shell has the permissions of the user running the server and a shell command can address paths outside that workspace or access the network. Tool metadata marks it as destructive and open-world. Users who need stronger isolation should run this MCP server inside a dedicated container or virtual machine.

## Transport and secrets

The HTTP server binds to `127.0.0.1` by default. ChatGPT reaches it through an outbound Secure MCP Tunnel. Tunnel credentials belong to the tunnel client configuration and are never accepted, logged, or persisted by this MCP server.

On Windows, `scripts/tunnel-client.ps1` reads the ignored `.env.local` file and maps `OPENAI_API_KEY` to the tunnel client's expected `CONTROL_PLANE_API_KEY` only for the client process. The configured stdio command uses `scripts/start-tunnel-mcp.ps1`, which removes both variables before launching the MCP server so the child cannot inherit the runtime credential.
