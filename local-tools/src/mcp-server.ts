import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { LocalOperations } from "./operations.js";
import { WorkspaceRegistry } from "./workspaces.js";

const readonlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const workspaceInput = z.string().min(1).describe("Workspace identifier returned by workspace_info");
const relativePathInput = z.string().default(".").describe("Path relative to the selected workspace root");

function textResult<T extends object>(structuredContent: T) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(structuredContent, null, 2) }],
    structuredContent: structuredContent as Record<string, unknown>,
  };
}

export function createMcpServer(registry: WorkspaceRegistry): McpServer {
  const operations = new LocalOperations(registry);
  const server = new McpServer(
    { name: "codex-chat-local-tools", version: "0.1.0" },
    {
      instructions:
        "Operate only within configured workspaces. Call workspace_info first when the workspace is unclear. Prefer read/search before edits and apply_patch for file changes. run_command executes with the current OS user's authority and is not an OS sandbox; use it only for commands needed by the user's task.",
    },
  );

  server.registerTool(
    "workspace_info",
    {
      title: "List local workspaces",
      description: "Use this first to discover the explicitly configured local workspace identifiers and root paths.",
      inputSchema: {},
      outputSchema: {
        workspaces: z.array(z.object({ id: z.string(), root: z.string() })),
      },
      annotations: readonlyAnnotations,
    },
    async () => textResult({ workspaces: registry.workspaces }),
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
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ workspace, patch }) => textResult(await operations.applyPatch(workspace, patch)),
  );

  server.registerTool(
    "run_command",
    {
      title: "Run a local command",
      description:
        "Use this for builds, tests, Git operations not covered by read-only tools, or other commands requested by the user. The shell starts in a configured workspace but has full current-user authority and network access.",
      inputSchema: {
        workspace: workspaceInput,
        cwd: relativePathInput.describe("Working directory relative to the workspace root"),
        command: z.string().min(1).describe("PowerShell command on Windows, Bash command elsewhere"),
        timeoutSeconds: z.number().int().min(1).max(300).default(90),
      },
      outputSchema: {
        exitCode: z.number().nullable(),
        stdout: z.string(),
        stderr: z.string(),
        timedOut: z.boolean(),
        truncated: z.boolean(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
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
