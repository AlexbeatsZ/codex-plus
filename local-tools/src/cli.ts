#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "./mcp-server.js";
import { startHttpServer } from "./http.js";
import { rootsFromEnvironment, WorkspaceRegistry } from "./workspaces.js";

interface CliOptions {
  roots: string[];
  host: string;
  port: number;
  stdio: boolean;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const registry = new WorkspaceRegistry(rootsFromEnvironment(process.cwd(), options.roots));

  if (options.stdio) {
    const server = createMcpServer(registry);
    await server.connect(new StdioServerTransport());
    console.error(`codex-chat-local-tools ready on stdio (${registry.workspaces.map((item) => item.id).join(", ")})`);
    return;
  }

  const httpServer = await startHttpServer(registry, { host: options.host, port: options.port });
  const address = httpServer.address();
  const displayPort = typeof address === "object" && address ? address.port : options.port;
  console.log(`codex-chat-local-tools listening at http://${options.host}:${displayPort}/mcp`);
  console.log(`workspaces: ${registry.workspaces.map((item) => `${item.id}=${item.root}`).join(", ")}`);

  const shutdown = () => httpServer.close(() => process.exit(0));
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    roots: [],
    host: process.env.CODEX_CHAT_LOCAL_HOST ?? "127.0.0.1",
    port: parsePort(process.env.CODEX_CHAT_LOCAL_PORT ?? "3344"),
    stdio: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--root") options.roots.push(requiredValue(args, ++index, "--root"));
    else if (arg === "--host") options.host = requiredValue(args, ++index, "--host");
    else if (arg === "--port") options.port = parsePort(requiredValue(args, ++index, "--port"));
    else if (arg === "--stdio") options.stdio = true;
    else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function requiredValue(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value.`);
  return value;
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error(`Invalid port: ${value}`);
  return port;
}

function printHelp(): void {
  console.log(`codex-chat-local-tools [options]

Options:
  --root <path>   Add an allowed workspace root (repeatable)
  --host <host>   HTTP bind host (default: 127.0.0.1)
  --port <port>   HTTP port (default: 3344; use 0 for an ephemeral port)
  --stdio         Use stdio transport instead of HTTP
  -h, --help      Show this help

Environment:
  CODEX_CHAT_LOCAL_ROOTS  Roots separated by the platform path delimiter
  CODEX_CHAT_LOCAL_HOST   HTTP bind host
  CODEX_CHAT_LOCAL_PORT   HTTP port`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
