# Codex context synchronization

## Goal

Give ChatGPT mode the local guidance needed to behave consistently with Codex. Global and configured workspace-root `AGENTS` guidance must be present in MCP initialization so the connected AI sees it before using tools; nested instructions and skills remain progressively loaded. The bridge must remain read-only and independent of ChatGPT browser/session automation.

## Instruction chain

The bridge mirrors the locally visible portion of the Codex prompt for a selected workspace directory:

1. `${CODEX_HOME}/AGENTS.override.md`, otherwise `${CODEX_HOME}/AGENTS.md`;
2. one project instruction file per directory from the configured workspace root through the requested directory;
3. within each directory, `AGENTS.override.md`, then `AGENTS.md`, then configured fallback filenames.

The default combined budget is `project_doc_max_bytes` from `config.toml`, or 32 KiB. Callers may request a larger bounded read when diagnosing truncation. The result preserves source order and identifies truncation.

## Initialization injection

When an MCP server process is created, it reads the global instruction candidate and each configured workspace root instruction candidate, deduplicates shared sources, preserves Codex precedence, and appends the bounded bodies to the MCP server `instructions` field. The client therefore receives the effective root guidance in the `initialize` response before tool discovery or invocation.

Initialization is a process-start snapshot. `codex_instructions` remains available to load the current chain for a nested target directory and to pick up instruction edits made after the long-running stdio process started. If the startup payload reaches the configured document limit, its footer directs the client to call that tool before substantive work.

The bridge intentionally does not call this data the complete Codex system prompt. OpenAI's platform system and developer messages are private runtime inputs. Only user-controlled local guidance can be synchronized.

## Skill discovery

The service scans these sources without copying them:

- `${CODEX_HOME}/skills`, with `.system` entries classified separately;
- the official user authoring location `~/.agents/skills`;
- applicable `.agents/skills` directories inside configured workspaces;
- enabled plugin caches from `${CODEX_HOME}/config.toml`;
- remote plugins carrying a local installation marker;
- explicitly configured extra roots.

The bridge mirrors skill text, not arbitrary Codex plugin runtime services. Bundled Computer Use plugins are therefore excluded from Web skill discovery: their instructions require Codex-host-only `node_repl` / `@oai/sky` services that are not part of this MCP. This prevents a skill from being advertised as executable when only its documentation is available. Computer Use remains enabled and usable inside the local Codex host itself.

A skill is valid only when `SKILL.md` has `name` and `description` frontmatter. Duplicate names remain separate and receive stable path-derived IDs, matching Codex's non-merge behavior. `[[skills.config]]` entries with `enabled = false` are excluded. `agents/openai.yaml` controls whether metadata participates in implicit matching.

## Progressive loading and triggers

The tool surface has three skill stages:

1. `load_codex_skill` advertises a compact catalog of implicit-trigger metadata. It is capped at 8,000 characters by default and shortens descriptions before omitting entries.
2. `list_codex_skills` returns a fresh metadata-only catalog, optionally filtered by query and target workspace directory.
3. `load_codex_skill` returns one full `SKILL.md` plus filenames and sizes of its resources. `read_codex_skill_resource` retrieves one referenced text file or supported image only when required.

Explicit-only skills remain visible in `list_codex_skills` but are not advertised as automatic triggers. Changes to instruction bodies, skill bodies, or resources are picked up on every corresponding load call. Changes to the startup AGENTS snapshot or compact trigger metadata take effect when the MCP process is restarted.

## Safety

- Project instruction discovery never walks above the configured workspace root.
- Codex-home reads are limited to the global AGENTS candidates, skill packages, and minimal non-returned configuration fields needed for discovery.
- Skill resource paths are relative, existing, real-path checked, and confined to the selected skill root.
- No account data, API keys, sessions, conversation history, or memory database is synchronized.
- `run_command` retains its existing full-current-user boundary; loading a skill does not execute its scripts automatically.
