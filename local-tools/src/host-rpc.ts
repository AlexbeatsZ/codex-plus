import { stdin, stdout } from "node:process";
import { LocalOperations } from "./operations.js";
import { WorkspaceRegistry } from "./workspaces.js";

interface HostRpcRequest {
  operation: string;
  arguments?: Record<string, unknown>;
}

async function readRequest(): Promise<HostRpcRequest> {
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) throw new Error("host-rpc requires one JSON request on stdin");
  return JSON.parse(text) as HostRpcRequest;
}

function rootFromArgs(): string {
  const index = process.argv.indexOf("--root");
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) throw new Error("host-rpc requires --root <workspace-root>");
  return value;
}

function stringArg(args: Record<string, unknown>, name: string, fallback?: string): string {
  const value = args[name] ?? fallback;
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  return value;
}

function numberArg(args: Record<string, unknown>, name: string, fallback?: number): number {
  const value = args[name] ?? fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${name} must be a number`);
  return value;
}

function booleanArg(args: Record<string, unknown>, name: string, fallback = false): boolean {
  const value = args[name] ?? fallback;
  if (typeof value !== "boolean") throw new Error(`${name} must be a boolean`);
  return value;
}

async function dispatch(request: HostRpcRequest) {
  const registry = new WorkspaceRegistry([rootFromArgs()]);
  const operations = new LocalOperations(registry);
  const args = request.arguments ?? {};

  switch (request.operation) {
    case "workspace_info":
      return { workspaces: registry.workspaces };
    case "list_files":
      return operations.listFiles(stringArg(args, "workspace"), stringArg(args, "path", "."), typeof args.glob === "string" ? args.glob : undefined, numberArg(args, "limit", 500));
    case "search_text":
      return operations.searchText(stringArg(args, "workspace"), stringArg(args, "path", "."), stringArg(args, "query"), booleanArg(args, "fixed"), typeof args.glob === "string" ? args.glob : undefined, numberArg(args, "limit", 200));
    case "read_file":
      return operations.readText(stringArg(args, "workspace"), stringArg(args, "path"), numberArg(args, "startLine", 1), numberArg(args, "lineCount", 500));
    case "read_image":
      return operations.readImage(stringArg(args, "workspace"), stringArg(args, "path"));
    case "apply_patch":
      return operations.applyPatch(stringArg(args, "workspace"), stringArg(args, "patch"));
    case "run_command":
      return operations.runCommand(stringArg(args, "workspace"), stringArg(args, "cwd", "."), stringArg(args, "command"), numberArg(args, "timeoutSeconds", 30));
    case "git_status":
      return { status: await operations.gitStatus(stringArg(args, "workspace")) };
    case "git_diff":
      return operations.gitDiff(stringArg(args, "workspace"), booleanArg(args, "staged"), typeof args.path === "string" ? args.path : undefined);
    default:
      throw new Error(`Unsupported host-rpc operation: ${request.operation}`);
  }
}

try {
  const result = await dispatch(await readRequest());
  stdout.write(`${JSON.stringify({ ok: true, result })}\n`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  stdout.write(`${JSON.stringify({ ok: false, error: message })}\n`);
  process.exitCode = 1;
}