import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { MachineOperations, type MachineId } from "./machine-operations.js";
import { WorkspaceRegistry } from "./workspaces.js";

const readonlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const mutatingAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
} as const;

const commandAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
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
  return machine === "windows" ? "Windows PC" : "Mac";
}

export function registerMachineTools(server: McpServer, registry: WorkspaceRegistry): void {
  const operations = new MachineOperations(registry);

  server.registerTool(
    "machine_info",
    {
      title: "List routed machines",
      description: "Shows the Windows PC and Mac targets known to this gateway, including which machine received the current MCP process. Use when the target host is unclear.",
      inputSchema: {},
      outputSchema: {
        localMachine: z.enum(["windows", "mac"]),
        machines: z.array(z.object({
          id: z.enum(["windows", "mac"]),
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

  for (const machine of ["windows", "mac"] as const) registerToolsForMachine(server, operations, machine);
}

function registerToolsForMachine(server: McpServer, operations: MachineOperations, machine: MachineId): void {
  const prefix = machine;
  const label = machineLabel(machine);
  const route = `Targets the user's ${label} explicitly. If this MCP request lands on the other computer, the gateway forwards it over passwordless SSH.`;

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
      annotations: mutatingAnnotations,
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
        command: z.string().min(1).describe(machine === "windows" ? "PowerShell command for the Windows PC" : "Bash command for the Mac"),
        timeoutSeconds: z.number().int().min(1).max(RUN_COMMAND_MAX_TIMEOUT_SECONDS).default(RUN_COMMAND_DEFAULT_TIMEOUT_SECONDS),
      },
      outputSchema: {
        exitCode: z.number().nullable(), stdout: z.string(), stderr: z.string(), timedOut: z.boolean(), truncated: z.boolean(),
      },
      annotations: commandAnnotations,
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
  server.registerTool(
    `${prefix}_desktop_state`,
    {
      title: `Inspect ${label} desktop`,
      description: `${route} Returns cursor position, displays, frontmost app, and visible windows. Use before coordinate-based interaction.`,
      inputSchema: {},
      annotations: readonlyAnnotations,
    },
    async () => textResult(await operations.desktopCall(machine, "state", {}) as object),
  );

  server.registerTool(
    `${prefix}_desktop_screenshot`,
    {
      title: `Screenshot ${label} desktop`,
      description: `${route} Captures the current desktop or a specific window from the interactive user session.`,
      inputSchema: { width: z.number().int().min(320).max(3840).default(1440), windowId: z.number().int().optional() },
      annotations: readonlyAnnotations,
    },
    async ({ width, windowId }) => {
      const image = await operations.desktopCall<{ base64?: string; width: number; height: number; mimeType: string; hash: string; unchanged: boolean }>(machine, "screenshot", { width, windowId });
      const { base64, ...structuredContent } = image;
      return { content: [{ type: "text" as const, text: JSON.stringify(structuredContent, null, 2) }, ...(base64 ? [{ type: "image" as const, data: base64, mimeType: image.mimeType }] : [])], structuredContent };
    },
  );

  server.registerTool(
    `${prefix}_desktop_mouse`,
    {
      title: `Control ${label} mouse`,
      description: `${route} Moves, clicks, drags, or scrolls the mouse in the interactive desktop session.`,
      inputSchema: { action: z.enum(["move", "click", "double_click", "right_click", "drag", "scroll"]), x: z.number().optional(), y: z.number().optional(), deltaY: z.number().default(0), deltaX: z.number().default(0) },
      annotations: mutatingAnnotations,
    },
    async (args) => textResult(await operations.desktopCall(machine, "mouse", args) as object),
  );

  server.registerTool(
    `${prefix}_desktop_keyboard`,
    {
      title: `Control ${label} keyboard`,
      description: `${route} Types literal text or sends one key/shortcut such as Ctrl+L or Cmd+L. Provide exactly one of text or key.`,
      inputSchema: { text: z.string().optional(), key: z.string().optional(), repeat: z.number().int().min(1).max(100).default(1) },
      annotations: mutatingAnnotations,
    },
    async (args) => textResult(await operations.desktopCall(machine, "keyboard", args) as object),
  );

  server.registerTool(
    `${prefix}_desktop_find`,
    {
      title: `Find ${label} UI elements`,
      description: `${route} Searches the accessibility tree for UI elements in a window. Prefer this over coordinates when available.`,
      inputSchema: { windowId: z.number().int(), role: z.string().optional(), label: z.string().optional(), value: z.string().optional(), maxResults: z.number().int().min(1).max(100).default(20) },
      annotations: readonlyAnnotations,
    },
    async (args) => textResult({ elements: await operations.desktopCall(machine, "find", args) as unknown[] }),
  );

  server.registerTool(
    `${prefix}_desktop_ui_action`,
    {
      title: `Act on ${label} UI element`,
      description: `${route} Activates a window, performs an accessibility action, or sets an accessibility element value.`,
      inputSchema: { windowId: z.number().int(), operation: z.enum(["activate_window", "perform", "set_value"]), role: z.string().optional(), label: z.string().optional(), action: z.string().optional(), value: z.string().optional() },
      annotations: mutatingAnnotations,
    },
    async (args) => textResult(await operations.desktopCall(machine, "ui_action", args) as object),
  );
}
