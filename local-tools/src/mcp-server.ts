import { registerAiDecisionTools } from "./ai-decision-tools.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { actionAnnotations, approvalModeFromEnvironment, approvalModeInstruction } from "./approval-policy.js";
import { CodexContextSync } from "./codex-context.js";
import { LocalOperations } from "./operations.js";
import { registerMachineTools } from "./machine-tools.js";
import { WorkspaceRegistry } from "./workspaces.js";

const readonlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const workspaceInput = z.string().min(1).describe("Workspace identifier returned by workspace_info");
const relativePathInput = z.string().default(".").describe("Path relative to the selected workspace root");
const RUN_COMMAND_DEFAULT_TIMEOUT_SECONDS = 30;
const RUN_COMMAND_MAX_TIMEOUT_SECONDS = 45;

function textResult<T extends object>(structuredContent: T) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(structuredContent, null, 2) }],
    structuredContent: structuredContent as Record<string, unknown>,
  };
}

export function createMcpServer(registry: WorkspaceRegistry, codexContext: CodexContextSync): McpServer {
  const operations = new LocalOperations(registry);
  const approvalMode = approvalModeFromEnvironment();
  const initializationInstructions = [
    "Multi-machine routing is enabled. Meta-OMEN is at meta@192.168.31.214 (backup meta@100.113.70.121), the Mac is at meta@192.168.31.174 (backup meta@100.64.2.94), and ROG Meta-ROGAlly is at meta@192.168.31.32 (backup meta@100.106.169.46). When the user names or clearly implies a host, always use the matching omen_*, mac_*, or rog_* tool. Those tools preserve the target even if this Tunnel request is handled by another computer, forwarding over passwordless SSH when necessary. Generic workspace/read/run tools operate only on whichever runtime handled the request and are retained for compatibility; do not use them when machine identity matters.",
    "Operate only within configured workspaces. Call workspace_info first when the workspace is unclear. The synced AGENTS instructions below already apply; call codex_instructions again for nested directories or instructions changed after this MCP process started. When the user names a synced skill or the task matches one of the metadata descriptions attached to load_codex_skill, load that skill before acting; read referenced resources only when needed. Prefer read/search before edits and apply_patch for file changes. run_command executes with the current OS user's authority and is not an OS sandbox; use it only for commands needed by the user's task.",
    approvalModeInstruction(approvalMode),
    codexContext.initializationInstructions(),
  ].filter((instruction): instruction is string => Boolean(instruction)).join("\n\n");
  const server = new McpServer(
    { name: "codex-chat-local-tools", version: "0.3.0" },
    {
      instructions: initializationInstructions,
    },
  );

  registerMachineTools(server, registry, approvalMode);
  registerAiDecisionTools(server);

  server.registerTool(
    "workspace_info",
    {
      title: "List local workspaces",
      description: "Use this first to discover the explicitly configured local workspace identifiers and root paths.",
      inputSchema: {},
      outputSchema: {
        workspaces: z.array(z.object({ id: z.string(), root: z.string() })),
        codexContext: z.object({
          enabled: z.boolean(),
          codexHome: z.string(),
          instructionSync: z.literal("initialization-and-on-demand"),
          skillSync: z.literal("catalog-first"),
          skillCount: z.number(),
        }),
      },
      annotations: readonlyAnnotations,
    },
    async () => textResult({ workspaces: registry.workspaces, codexContext: codexContext.status() }),
  );

  server.registerTool(
    "codex_instructions",
    {
      title: "Load synced Codex instructions",
      description:
        "Call before substantive work in a configured workspace. Loads the current global and project AGENTS instruction chain on demand, using Codex precedence and size limits. This mirrors local Codex-visible guidance, not OpenAI's private platform prompts.",
      inputSchema: {
        workspace: workspaceInput,
        path: relativePathInput.describe("Target directory relative to the workspace; nested AGENTS guidance is resolved through this directory"),
        maxBytes: z.number().int().min(1_024).max(262_144).optional().describe("Optional read cap; defaults to Codex project_doc_max_bytes or 32 KiB"),
      },
      outputSchema: {
        boundary: z.string(),
        workspace: z.string(),
        path: z.string(),
        maxBytes: z.number(),
        sources: z.array(z.object({
          scope: z.enum(["global", "project"]),
          path: z.string(),
          content: z.string(),
          truncated: z.boolean(),
        })),
        combined: z.string(),
        truncated: z.boolean(),
      },
      annotations: readonlyAnnotations,
    },
    async ({ workspace, path, maxBytes }) => textResult(codexContext.loadInstructions(workspace, path, maxBytes)),
  );

  server.registerTool(
    "list_codex_skills",
    {
      title: "List synced Codex skills",
      description:
        "Returns only the current skill metadata index for progressive loading. Use it when the compact startup catalog is incomplete, a skill name is ambiguous, or you need to search descriptions; then call load_codex_skill for exactly one matching skill.",
      inputSchema: {
        workspace: z.string().optional().describe("Optional workspace identifier for repository-scoped skills"),
        path: relativePathInput.describe("Optional target directory used for nested repository skill discovery"),
        query: z.string().optional().describe("Optional case-insensitive filter across ID, name, description, scope, and source"),
      },
      outputSchema: {
        skills: z.array(z.object({
          id: z.string(),
          name: z.string(),
          description: z.string(),
          scope: z.enum(["project", "user", "system", "plugin", "extra"]),
          source: z.string(),
          sourcePath: z.string(),
          implicitInvocation: z.boolean(),
        })),
      },
      annotations: readonlyAnnotations,
    },
    async ({ workspace, path, query }) => textResult({ skills: codexContext.listSkills(workspace, path, query) }),
  );

  server.registerTool(
    "load_codex_skill",
    {
      title: "Load a synced Codex skill",
      description: codexContext.triggerSummary(),
      inputSchema: {
        skill: z.string().min(1).describe("Exact skill ID from the metadata catalog, or a unique exact skill name"),
        workspace: z.string().optional().describe("Optional workspace identifier for repository-scoped skills"),
        path: relativePathInput.describe("Optional target directory used for nested repository skill discovery"),
      },
      outputSchema: {
        id: z.string(),
        name: z.string(),
        description: z.string(),
        scope: z.enum(["project", "user", "system", "plugin", "extra"]),
        source: z.string(),
        sourcePath: z.string(),
        implicitInvocation: z.boolean(),
        root: z.string(),
        instructions: z.string(),
        resources: z.array(z.object({
          path: z.string(),
          kind: z.enum(["reference", "script", "asset", "metadata", "other"]),
          size: z.number(),
        })),
        resourcesTruncated: z.boolean(),
      },
      annotations: readonlyAnnotations,
    },
    async ({ skill, workspace, path }) => textResult(codexContext.loadSkill(skill, workspace, path)),
  );

  server.registerTool(
    "read_codex_skill_resource",
    {
      title: "Read a synced Codex skill resource",
      description:
        "Reads one reference, script, template, metadata file, or supported image from a previously loaded Codex skill. Use only when SKILL.md points to that resource or it is needed for the current workflow.",
      inputSchema: {
        skill: z.string().min(1).describe("Exact skill ID, or a unique exact skill name"),
        resourcePath: z.string().min(1).describe("Path relative to the loaded skill root"),
        startLine: z.number().int().min(1).default(1),
        lineCount: z.number().int().min(1).max(5_000).default(500),
        workspace: z.string().optional().describe("Optional workspace identifier for repository-scoped skills"),
        path: relativePathInput.describe("Optional target directory used for nested repository skill discovery"),
      },
      outputSchema: {
        skillId: z.string(),
        path: z.string(),
        format: z.enum(["text", "image"]),
        mimeType: z.string(),
        size: z.number(),
        startLine: z.number().optional(),
        endLine: z.number().optional(),
        totalLines: z.number().optional(),
        text: z.string().optional(),
        truncated: z.boolean().optional(),
      },
      annotations: readonlyAnnotations,
    },
    async ({ skill, resourcePath, startLine, lineCount, workspace, path }) => {
      const resource = codexContext.readSkillResource(skill, resourcePath, startLine, lineCount, workspace, path);
      const { data, ...structuredContent } = resource;
      if (resource.format === "image" && data) {
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(structuredContent, null, 2) },
            { type: "image" as const, data, mimeType: resource.mimeType },
          ],
          structuredContent,
        };
      }
      return textResult(structuredContent);
    },
  );

  server.registerTool(
    "list_files",
    {
      title: "List workspace files",
      description: "Use this to enumerate files under a directory in a configured workspace before choosing files to inspect.",
      inputSchema: {
        workspace: workspaceInput,
        path: relativePathInput,
        glob: z.string().optional().describe("Optional ripgrep glob such as src/**/*.ts"),
        limit: z.number().int().min(1).max(5_000).default(500),
      },
      outputSchema: {
        files: z.array(z.string()),
        truncated: z.boolean(),
      },
      annotations: readonlyAnnotations,
    },
    async ({ workspace, path, glob, limit }) => textResult(await operations.listFiles(workspace, path, glob, limit)),
  );

  server.registerTool(
    "search_text",
    {
      title: "Search workspace text",
      description: "Use this to locate symbols, messages, or regex patterns across text files in a configured workspace.",
      inputSchema: {
        workspace: workspaceInput,
        path: relativePathInput,
        query: z.string().min(1).describe("Regular expression by default, or literal text when fixed is true"),
        fixed: z.boolean().default(false),
        glob: z.string().optional().describe("Optional ripgrep glob such as **/*.ts"),
        limit: z.number().int().min(1).max(1_000).default(200),
      },
      outputSchema: {
        matches: z.array(z.object({ path: z.string(), line: z.number(), column: z.number(), text: z.string() })),
        truncated: z.boolean(),
      },
      annotations: readonlyAnnotations,
    },
    async ({ workspace, path, query, fixed, glob, limit }) =>
      textResult(await operations.searchText(workspace, path, query, fixed, glob, limit)),
  );

  server.registerTool(
    "read_file",
    {
      title: "Read a workspace text file",
      description: "Use this to read a bounded line range from a UTF-8 text file in a configured workspace.",
      inputSchema: {
        workspace: workspaceInput,
        path: z.string().min(1).describe("File path relative to the workspace root"),
        startLine: z.number().int().min(1).default(1),
        lineCount: z.number().int().min(1).max(5_000).default(500),
      },
      outputSchema: {
        path: z.string(),
        startLine: z.number(),
        endLine: z.number(),
        totalLines: z.number(),
        text: z.string(),
        truncated: z.boolean(),
      },
      annotations: readonlyAnnotations,
    },
    async ({ workspace, path, startLine, lineCount }) =>
      textResult(await operations.readText(workspace, path, startLine, lineCount)),
  );

  server.registerTool(
    "read_image",
    {
      title: "Read a workspace image",
      description: "Use this when visual inspection of a PNG, JPEG, GIF, or WebP file in a configured workspace is needed.",
      inputSchema: {
        workspace: workspaceInput,
        path: z.string().min(1).describe("Image path relative to the workspace root"),
      },
      outputSchema: {
        path: z.string(),
        mimeType: z.string(),
        size: z.number(),
      },
      annotations: readonlyAnnotations,
    },
    async ({ workspace, path }) => {
      const image = await operations.readImage(workspace, path);
      const structuredContent = { path: image.path, mimeType: image.mimeType, size: image.size };
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(structuredContent, null, 2) },
          { type: "image" as const, data: image.data, mimeType: image.mimeType },
        ],
        structuredContent,
      };
    },
  );

  server.registerTool(
    "apply_patch",
    {
      title: "Apply a workspace patch",
      description: "Use this to validate and apply a unified Git patch whose file targets stay inside one configured workspace.",
      inputSchema: {
        workspace: workspaceInput,
        patch: z.string().min(1).describe("Unified patch text with --- and +++ file headers"),
      },
      outputSchema: {
        applied: z.boolean(),
        paths: z.array(z.string()),
      },
      annotations: actionAnnotations("workspace-write", approvalMode),
    },
    async ({ workspace, patch }) => textResult(await operations.applyPatch(workspace, patch)),
  );

  server.registerTool(
    "run_command",
    {
      title: "Run a local command",
      description:
        "Use this for bounded builds, tests, Git operations not covered by read-only tools, or other commands requested by the user. The shell starts in a configured workspace but has full current-user authority and network access. Split or background work that cannot finish within 45 seconds so it cannot block the shared Tunnel stdio channel.",
      inputSchema: {
        workspace: workspaceInput,
        cwd: relativePathInput.describe("Working directory relative to the workspace root"),
        command: z.string().min(1).describe("PowerShell command on Windows, Bash command elsewhere"),
        timeoutSeconds: z.number().int().min(1).max(RUN_COMMAND_MAX_TIMEOUT_SECONDS).default(RUN_COMMAND_DEFAULT_TIMEOUT_SECONDS),
      },
      outputSchema: {
        exitCode: z.number().nullable(),
        stdout: z.string(),
        stderr: z.string(),
        timedOut: z.boolean(),
        truncated: z.boolean(),
      },
      annotations: actionAnnotations("command", approvalMode),
    },
    async ({ workspace, cwd, command, timeoutSeconds }) =>
      textResult(await operations.runCommand(workspace, cwd, command, timeoutSeconds)),
  );

  server.registerTool(
    "git_status",
    {
      title: "Read Git status",
      description: "Use this to inspect the short Git branch and working-tree status for a configured workspace repository.",
      inputSchema: { workspace: workspaceInput },
      outputSchema: { status: z.string() },
      annotations: readonlyAnnotations,
    },
    async ({ workspace }) => textResult({ status: await operations.gitStatus(workspace) }),
  );

  server.registerTool(
    "git_diff",
    {
      title: "Read Git diff",
      description: "Use this to inspect unstaged or staged Git differences in a configured workspace repository.",
      inputSchema: {
        workspace: workspaceInput,
        staged: z.boolean().default(false),
        path: z.string().optional().describe("Optional workspace-relative path to limit the diff"),
      },
      outputSchema: { diff: z.string(), truncated: z.boolean() },
      annotations: readonlyAnnotations,
    },
    async ({ workspace, staged, path }) => textResult(await operations.gitDiff(workspace, staged, path)),
  );

  return server;
}
