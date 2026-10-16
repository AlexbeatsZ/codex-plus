import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import * as z from "zod/v4";
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
  const schemas = new Map<string, Record<string, z.ZodType>>();
  const server = { registerTool(name: string, definition: {inputSchema: Record<string, z.ZodType>}) {
    names.push(name); schemas.set(name, definition.inputSchema);
  } } as unknown as McpServer;
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
    assert.equal(names.length, 12);
    assert.ok(names.includes("commit_decision"));
    const history = {kind:"fill_gap",item_id:"study",start_at:"2026-10-15T11:00:00+08:00",end_at:"2026-10-15T11:01:00+08:00",reason:"Test",evidence:[{source:"user",reference_id:"m"}]};
    assert.doesNotThrow(() => schemas.get("commit_decision")!.proposal.parse({uptimer_changes:[history]}));
    assert.throws(() => schemas.get("commit_decision")!.proposal.parse({uptimer_changes:[{...history,url:"https://example.com"}]}));
    assert.equal(schemas.get("query_workreview")!.from_at.parse("2026-10-15T11:00:00+08:00"), "2026-10-15T11:00:00+08:00");
    for (const name of ["get_decision_evidence", "query_todo_tasks", "query_uptimer", "query_workreview", "read_evidence_query", "query_course_materials", "read_course_material"]) {
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
