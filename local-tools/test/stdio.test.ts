import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { makeAgentTemp } from "./support.js";

test("compiled CLI performs an MCP handshake over stdio", async () => {
  const temporary = await makeAgentTemp("codex-chat-stdio");
  await writeFile(path.join(temporary.directory, "stdio.txt"), "stdio works\n", "utf8");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.resolve("dist/cli.js"), "--stdio", "--root", temporary.directory],
    cwd: process.cwd(),
    stderr: "pipe",
  });
  const client = new Client({ name: "codex-chat-stdio-test", version: "1.0.0" });

  try {
    await client.connect(transport);
    const result = await client.callTool({ name: "workspace_info", arguments: {} });
    const workspaces = (result.structuredContent as { workspaces: Array<{ id: string; root: string }> }).workspaces;
    assert.equal(workspaces.length, 1);
    assert.equal(path.normalize(workspaces[0].root), path.normalize(temporary.directory));

    const timedOut = await client.callTool({
      name: "run_command",
      arguments: {
        workspace: workspaces[0].id,
        cwd: ".",
        command: process.platform === "win32" ? "Start-Sleep -Seconds 2" : "sleep 2",
        timeoutSeconds: 1,
      },
    });
    assert.equal((timedOut.structuredContent as { timedOut: boolean }).timedOut, true);
    const retry = await client.callTool({ name: "workspace_info", arguments: {} });
    assert.notEqual(retry.isError, true, JSON.stringify(retry));
  } finally {
    await transport.close().catch(() => undefined);
    await temporary.cleanup();
  }
});

test(
  "Windows tunnel wrapper strips tunnel-only environment before starting the MCP child",
  { skip: process.platform !== "win32" },
  async () => {
    const temporary = await makeAgentTemp("codex-chat-tunnel-stdio");
    const transport = new StdioClientTransport({
      command: "powershell.exe",
      args: [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        path.resolve("scripts/start-tunnel-mcp.ps1"),
        "-Root",
        temporary.directory,
      ],
      cwd: process.cwd(),
      env: {
        ...process.env,
        CONTROL_PLANE_API_KEY: "test-control-plane-secret",
        OPENAI_API_KEY: "test-openai-secret",
        HTTPS_PROXY: "http://127.0.0.1:7897",
      },
      stderr: "pipe",
    });
    const client = new Client({ name: "codex-chat-tunnel-stdio-test", version: "1.0.0" });

    try {
      await client.connect(transport);
      const workspaceResult = await client.callTool({ name: "workspace_info", arguments: {} });
      const workspace = (workspaceResult.structuredContent as { workspaces: Array<{ id: string }> }).workspaces[0].id;
      const result = await client.callTool({
        name: "run_command",
        arguments: {
          workspace,
          cwd: ".",
          command:
            "if ($env:CONTROL_PLANE_API_KEY -or $env:OPENAI_API_KEY -or $env:HTTPS_PROXY) { exit 9 }; Write-Output 'tunnel-environment-stripped'",
        },
      });
      assert.notEqual(result.isError, true, JSON.stringify(result));
      assert.match(JSON.stringify(result.content), /tunnel-environment-stripped/);
    } finally {
      await transport.close().catch(() => undefined);
      await temporary.cleanup();
    }
  },
);
