import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CodexContextSync } from "../src/codex-context.js";
import { startHttpServer } from "../src/http.js";
import { WorkspaceRegistry } from "../src/workspaces.js";
import { makeAgentTemp } from "./support.js";

test("Streamable HTTP performs MCP handshake, lists tools, and reads a file", async () => {
  const temporary = await makeAgentTemp("codex-chat-http");
  const registry = new WorkspaceRegistry([temporary.directory]);
  const codexHome = path.join(temporary.directory, ".codex");
  const skillRoot = path.join(codexHome, "skills", "transport-skill");
  await mkdir(skillRoot, { recursive: true });
  await writeFile(path.join(temporary.directory, "sample.txt"), "transport works\n", "utf8");
  await writeFile(path.join(codexHome, "AGENTS.md"), "transport guidance\n", "utf8");
  await writeFile(
    path.join(skillRoot, "SKILL.md"),
    "---\nname: transport-skill\ndescription: Verify MCP skill loading.\n---\n\nTransport skill body.\n",
    "utf8",
  );
  const codexContext = new CodexContextSync(registry, {
    codexHome,
  });
  const httpServer = await startHttpServer(registry, { host: "127.0.0.1", port: 0 }, codexContext);
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
        "codex_instructions",
        "git_diff",
        "git_status",
        "list_codex_skills",
        "list_files",
        "load_codex_skill",
        "read_codex_skill_resource",
        "read_file",
        "read_image",
        "run_command",
        "search_text",
        "workspace_info",
      ],
    );
    const runCommand = tools.tools.find((tool) => tool.name === "run_command");
    const timeoutSchema = (runCommand?.inputSchema.properties as Record<string, Record<string, unknown>> | undefined)?.timeoutSeconds;
    assert.equal(timeoutSchema?.default, 30);
    assert.equal(timeoutSchema?.maximum, 45);

    const result = await client.callTool({
      name: "read_file",
      arguments: { workspace: registry.workspaces[0].id, path: "sample.txt", startLine: 1, lineCount: 10 },
    });
    assert.equal(result.isError, undefined);
    assert.equal((result.structuredContent as { text: string }).text, "transport works\n");

    const instructions = await client.callTool({
      name: "codex_instructions",
      arguments: { workspace: registry.workspaces[0].id, path: "." },
    });
    assert.match((instructions.structuredContent as { combined: string }).combined, /transport guidance/);

    const skill = await client.callTool({
      name: "load_codex_skill",
      arguments: { skill: "transport-skill", workspace: registry.workspaces[0].id, path: "." },
    });
    assert.match((skill.structuredContent as { instructions: string }).instructions, /Transport skill body/);
  } finally {
    await transport.close().catch(() => undefined);
    await new Promise<void>((resolve, reject) => httpServer.close((error) => error ? reject(error) : resolve()));
    await temporary.cleanup();
  }
});
