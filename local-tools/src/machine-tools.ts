import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { actionAnnotations, type ApprovalMode } from "./approval-policy.js";
import { MachineOperations, type MachineId } from "./machine-operations.js";
import { WorkspaceRegistry } from "./workspaces.js";

const readonlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const workspaceInput = z.string().min(1).describe("Workspace identifier returned by the matching machine workspace_info tool");
const relativePathInput = z.string().default(".").describe("Path relative to the selected workspace root");
const RUN_COMMAND_DEFAULT_TIMEOUT_SECONDS = 30;
const RUN_COMMAND_MAX_TIMEOUT_SECONDS = 45;

function textResult<T extends object>(structuredContent: T) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(structuredContent, null, 2) }],
    structuredContent: structuredContent as Record<string, unknown>,
  };
}

function machineLabel(machine: MachineId): string {
  if (machine === "windows") return "Windows PC Meta-OMEN";
  if (machine === "rog") return "Windows ROG Meta-ROGAlly";
  return "Mac";
}

export function registerMachineTools(server: McpServer, registry: WorkspaceRegistry, approvalMode: ApprovalMode): void {
  const operations = new MachineOperations(registry);

  server.registerTool(
    "machine_info",
    {
      title: "List routed machines",
      description: "Shows the Meta-OMEN, Mac, and ROG targets known to this gateway, including which machine received the current MCP process. Use when the target host is unclear.",
      inputSchema: {},
      outputSchema: {
        localMachine: z.enum(["windows", "mac", "rog"]),
        machines: z.array(z.object({
          id: z.enum(["windows", "mac", "rog"]),
          label: z.string(),
          platform: z.enum(["win32", "darwin"]),
          sshTarget: z.string(),
          sshFallbackTarget: z.string(),
          workspaceRoot: z.string(),
          local: z.boolean(),
        })),
      },
      annotations: readonlyAnnotations,
    },
    async () => textResult(operations.info()),
  );

  for (const machine of ["windows", "mac", "rog"] as const) registerToolsForMachine(server, operations, machine, approvalMode);
}

function registerToolsForMachine(server: McpServer, operations: MachineOperations, machine: MachineId, approvalMode: ApprovalMode): void {
  const prefix = machine;
  const label = machineLabel(machine);
  const route = `Targets the user's ${label} explicitly. If this MCP request lands on another computer, the gateway forwards it over passwordless SSH.`;

  server.registerTool(
    `${prefix}_workspace_info`,
    {
      title: `List ${label} workspaces`,
      description: `${route} Use this first when the ${label} workspace is unclear.`,
      inputSchema: {},
      outputSchema: { workspaces: z.array(z.object({ id: z.string(), root: z.string() })) },
      annotations: readonlyAnnotations,
    },
    async () => textResult(await operations.workspaceInfo(machine)),
  );

  server.registerTool(
    `${prefix}_list_files`,
    {
      title: `List ${label} workspace files`,
      description: `${route} Enumerates files under a directory in a configured ${label} workspace.`,
      inputSchema: {
        workspace: workspaceInput,
        path: relativePathInput,
        glob: z.string().optional().describe("Optional ripgrep glob such as src/**/*.ts"),
        limit: z.number().int().min(1).max(5_000).default(500),
      },
      outputSchema: { files: z.array(z.string()), truncated: z.boolean() },
      annotations: readonlyAnnotations,
    },
    async ({ workspace, path, glob, limit }) => textResult(await operations.listFiles(machine, workspace, path, glob, limit)),
  );

  server.registerTool(
    `${prefix}_search_text`,
    {
      title: `Search ${label} workspace text`,
      description: `${route} Searches text files on the ${label}.`,
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
      textResult(await operations.searchText(machine, workspace, path, query, fixed, glob, limit)),
  );

  server.registerTool(
    `${prefix}_read_file`,
    {
      title: `Read a ${label} workspace text file`,
      description: `${route} Reads a bounded UTF-8 line range from the ${label}.`,
      inputSchema: {
        workspace: workspaceInput,
        path: z.string().min(1).describe("File path relative to the workspace root"),
        startLine: z.number().int().min(1).default(1),
        lineCount: z.number().int().min(1).max(5_000).default(500),
      },
      outputSchema: {
        path: z.string(), startLine: z.number(), endLine: z.number(), totalLines: z.number(), text: z.string(), truncated: z.boolean(),
      },
      annotations: readonlyAnnotations,
    },
    async ({ workspace, path, startLine, lineCount }) => textResult(await operations.readText(machine, workspace, path, startLine, lineCount)),
  );

  server.registerTool(
    `${prefix}_read_image`,
    {
      title: `Read a ${label} workspace image`,
      description: `${route} Reads a PNG, JPEG, GIF, or WebP from the ${label}.`,
      inputSchema: { workspace: workspaceInput, path: z.string().min(1).describe("Image path relative to the workspace root") },
      outputSchema: { path: z.string(), mimeType: z.string(), size: z.number() },
      annotations: readonlyAnnotations,
    },
    async ({ workspace, path }) => {
      const image = await operations.readImage(machine, workspace, path);
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
    `${prefix}_apply_patch`,
    {
      title: `Apply a ${label} workspace patch`,
      description: `${route} Validates and applies a unified Git patch inside one configured ${label} workspace.`,
      inputSchema: { workspace: workspaceInput, patch: z.string().min(1).describe("Unified patch text with --- and +++ file headers") },
      outputSchema: { applied: z.boolean(), paths: z.array(z.string()) },
      annotations: actionAnnotations("workspace-write", approvalMode),
    },
    async ({ workspace, patch }) => textResult(await operations.applyPatch(machine, workspace, patch)),
  );

  server.registerTool(
    `${prefix}_run_command`,
    {
      title: `Run a command on the ${label}`,
      description: `${route} Use this for ${label}-specific commands, builds, configuration, and system operations. Commands use PowerShell on Windows and Bash on macOS. The shell starts in a configured workspace but retains the target user's full authority.`,
      inputSchema: {
        workspace: workspaceInput,
        cwd: relativePathInput.describe("Working directory relative to the workspace root"),
        command: z.string().min(1).describe(machine === "mac" ? "Bash command for the Mac" : `PowerShell command for the ${label}`),
        timeoutSeconds: z.number().int().min(1).max(RUN_COMMAND_MAX_TIMEOUT_SECONDS).default(RUN_COMMAND_DEFAULT_TIMEOUT_SECONDS),
      },
      outputSchema: {
        exitCode: z.number().nullable(), stdout: z.string(), stderr: z.string(), timedOut: z.boolean(), truncated: z.boolean(),
      },
      annotations: actionAnnotations("command", approvalMode),
    },
    async ({ workspace, cwd, command, timeoutSeconds }) => textResult(await operations.runCommand(machine, workspace, cwd, command, timeoutSeconds)),
  );

  server.registerTool(
    `${prefix}_git_status`,
    {
      title: `Read ${label} Git status`,
      description: `${route} Reads short Git branch and working-tree status on the ${label}.`,
      inputSchema: { workspace: workspaceInput },
      outputSchema: { status: z.string() },
      annotations: readonlyAnnotations,
    },
    async ({ workspace }) => textResult(await operations.gitStatus(machine, workspace)),
  );

  server.registerTool(
    `${prefix}_git_diff`,
    {
      title: `Read ${label} Git diff`,
      description: `${route} Reads unstaged or staged Git differences on the ${label}.`,
      inputSchema: {
        workspace: workspaceInput,
        staged: z.boolean().default(false),
        path: z.string().optional().describe("Optional workspace-relative path to limit the diff"),
      },
      outputSchema: { diff: z.string(), truncated: z.boolean() },
      annotations: readonlyAnnotations,
    },
    async ({ workspace, staged, path }) => textResult(await operations.gitDiff(machine, workspace, staged, path)),
  );
}
