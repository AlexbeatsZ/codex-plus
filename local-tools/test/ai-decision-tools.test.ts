import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAiDecisionTools } from "../src/ai-decision-tools.js";
import { makeAgentTemp } from "./support.js";

test("AI Decision tools are registered only on ROG, never read OMEN config", async () => {
  const temporary = await makeAgentTemp("ai-decision-host-gate");
  const previousMachine = process.env.CODEX_PLUS_MACHINE_ID;
  const previousConfig = process.env.AI_DECISION_BRIDGE_CONFIG;
  const configPath = path.join(temporary.directory, "bridge.json");
  process.env.AI_DECISION_BRIDGE_CONFIG = configPath;
  const names: string[] = [];
  const server = { registerTool(name: string) { names.push(name); } } as unknown as McpServer;
  try {
    await writeFile(configPath, "invalid JSON must not be read on other hosts");
    for (const machine of ["omen", "mac"]) {
      process.env.CODEX_PLUS_MACHINE_ID = machine;
      assert.doesNotThrow(() => registerAiDecisionTools(server));
    }
    assert.deepEqual(names, []);
    process.env.CODEX_PLUS_MACHINE_ID = "rog";
    await writeFile(configPath, JSON.stringify({ url: "http://127.0.0.1:1", token: "test-only" }));
    registerAiDecisionTools(server);
    assert.equal(names.length, 10);
    assert.ok(names.includes("commit_decision"));
    for (const name of ["get_decision_evidence", "query_todo_tasks", "query_uptimer", "query_workreview", "read_evidence_query"]) {
      assert.ok(names.includes(name));
    }
  } finally {
    if (previousMachine === undefined) delete process.env.CODEX_PLUS_MACHINE_ID;
    else process.env.CODEX_PLUS_MACHINE_ID = previousMachine;
    if (previousConfig === undefined) delete process.env.AI_DECISION_BRIDGE_CONFIG;
    else process.env.AI_DECISION_BRIDGE_CONFIG = previousConfig;
    await temporary.cleanup();
  }
});
