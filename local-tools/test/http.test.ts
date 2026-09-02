import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startHttpServer } from "../src/http.js";
import { WorkspaceRegistry } from "../src/workspaces.js";
import { makeAgentTemp } from "./support.js";

test("Streamable HTTP performs MCP handshake, lists tools, and reads a file", async () => {
  const temporary = await makeAgentTemp("codex-chat-http");
  const registry = new WorkspaceRegistry([temporary.directory]);
  await writeFile(path.join(temporary.directory, "sample.txt"), "transport works\n", "utf8");
  const httpServer = await startHttpServer(registry, { host: "127.0.0.1", port: 0 });
  const address = httpServer.address() as AddressInfo;
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`));
  const client = new Client({ name: "codex-chat-local-tools-test", version: "1.0.0" });

  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.deepEqual(
      tools.tools.map((tool) => tool.name).sort(),
      [
        "apply_patch",
        "git_diff",
        "git_status",
        "list_files",
        "read_file",
        "read_image",
        "run_command",
        "search_text",
        "workspace_info",
      ],
    );

    const result = await client.callTool({
      name: "read_file",
      arguments: { workspace: registry.workspaces[0].id, path: "sample.txt", startLine: 1, lineCount: 10 },
    });
    assert.equal(result.isError, undefined);
    assert.equal((result.structuredContent as { text: string }).text, "transport works\n");
  } finally {
    await transport.close().catch(() => undefined);
    await new Promise<void>((resolve, reject) => httpServer.close((error) => error ? reject(error) : resolve()));
    await temporary.cleanup();
  }
});
