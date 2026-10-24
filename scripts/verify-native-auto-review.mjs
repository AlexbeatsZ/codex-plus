import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";

if (process.argv[2] === "--fixture-mcp") {
  const executionFile = process.argv[3];
  const lines = createInterface({ input: process.stdin });
  lines.on("line", line => {
    const request = JSON.parse(line);
    if (request.id == null) return;
    let result;
    if (request.method === "initialize") {
      result = { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } };
    } else if (request.method === "tools/list") {
      result = { tools: [{ name: "probe", description: "Record execution of this isolated local test fixture.", inputSchema: { type: "object", properties: {}, additionalProperties: false }, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true } }] };
    } else if (request.method === "tools/call") {
      assert.equal(request.params.name, "probe");
      fs.appendFileSync(executionFile, "executed\n");
      result = { content: [{ type: "text", text: "FIXTURE_EXECUTED" }] };
    } else if (request.method === "ping") {
      result = {};
    } else {
      process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Unknown fixture method" } })}\n`);
      return;
    }
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
  });
} else {
  await verify();
}

async function verify() {
  const [binary, baseUrl, model, provider] = process.argv.slice(2);
  assert.ok(binary && baseUrl && model && provider, "Pass native binary, isolated broker URL, route and provider");
  const parent = path.join(os.tmpdir(), ".agents");
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, "codex-plus-native-review-"));
  const home = path.join(root, "home");
  fs.mkdirSync(home);
  const executionFile = path.join(root, "executions.txt");
  const catalogPath = process.env.CODEX_PLUS_NATIVE_CATALOG || path.join(os.homedir(), ".codex", "models_cache.json");
  const sourceModels = JSON.parse(fs.readFileSync(catalogPath, "utf8")).models;
  const reviewer = sourceModels.find(entry => entry.slug === "codex-auto-review");
  assert.ok(reviewer, "Native catalog must contain its original approval reviewer");
  const catalogFile = path.join(home, "models.json");
  fs.writeFileSync(catalogFile, JSON.stringify({ models: [{ ...sourceModels[0], slug: model, tool_mode: "direct", use_responses_lite: false }, reviewer] }));
  fs.writeFileSync(path.join(home, "config.toml"), `web_search="disabled"
approvals_reviewer="auto_review"
chatgpt_base_url=${JSON.stringify(`${baseUrl}/fixture-services`)}
[model_providers.${provider}]
name="isolated review fixture"
base_url=${JSON.stringify(baseUrl)}
wire_api="responses"
experimental_bearer_token="codex-plus-loopback"
requires_openai_auth=false
supports_websockets=false
request_max_retries=0
stream_max_retries=0
[mcp_servers.fixture]
command=${JSON.stringify(process.execPath)}
args=${JSON.stringify([fileURLToPath(import.meta.url), "--fixture-mcp", executionFile])}
default_tools_approval_mode="prompt"
omit_tools_from=[]
[features]
plugins=false
apps=false
`);
  const app = spawn(binary, ["app-server", "--listen", "stdio://", "-c", `model_catalog_json=${JSON.stringify(catalogFile)}`],
    { cwd: root, env: { ...process.env, CODEX_HOME: home }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  let stderr = "";
  app.stderr.on("data", bytes => { stderr = (stderr + bytes).slice(-6000); });
  const lines = createInterface({ input: app.stdout });
  const pending = new Map(), events = [];
  let sequence = 0;
  lines.on("line", line => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    const call = pending.get(message.id);
    if (call) {
      clearTimeout(call.timer);
      pending.delete(message.id);
      if (message.error) call.reject(Error(JSON.stringify(message.error)));
      else call.resolve(message.result);
    } else if (message.method) {
      if (message.id != null) {
        app.stdin.write(`${JSON.stringify({ id: message.id, error: { code: -32601, message: "Fixture never grants human approval" } })}\n`);
      }
      events.push(message);
    }
  });
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(Error(`Timeout: ${method}\n${stderr}`)); }, 20000);
    pending.set(id, { resolve, reject, timer });
    app.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  });
  const executions = () => fs.existsSync(executionFile) ? fs.readFileSync(executionFile, "utf8").trim().split("\n").length : 0;
  try {
    await rpc("initialize", { clientInfo: { name: "native_review_fixture", version: "1" }, capabilities: { experimentalApi: true } });
    app.stdin.write('{"method":"initialized"}\n');
    for (const decision of ["allow", "deny"]) {
      const started = await rpc("thread/start", { cwd: root, model, modelProvider: provider, approvalPolicy: "on-request", approvalsReviewer: "auto_review", sandbox: "read-only", baseInstructions: "Use the fixture MCP probe once and report its result." });
      const offset = events.length;
      await rpc("turn/start", { threadId: started.thread.id, model, effort: "low", input: [{ type: "text", text: `fixture-${decision}: Call the fixture probe once.` }] });
      const deadline = Date.now() + 25000;
      let completed;
      while (Date.now() < deadline) {
        completed = events.slice(offset).find(entry => entry.method === "turn/completed");
        if (completed) break;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      assert.ok(completed, `No native turn completion: ${JSON.stringify(events.slice(offset))}\n${stderr}`);
      assert.equal(completed.params.turn.status, "completed", JSON.stringify(completed.params.turn.error));
      assert.equal(executions(), 1, `${decision}: native approval must gate actual fixture execution: ${JSON.stringify(events.slice(offset).filter(entry => entry.method === "item/completed" || entry.method === "error" || entry.id != null))}\n${stderr}`);
      assert.ok(events.slice(offset).some(entry => /approval.*review|auto.*review/i.test(JSON.stringify(entry))), "Native review events must be present");
      assert.ok(!events.slice(offset).some(entry => entry.id != null), "No human approval may substitute for automatic review");
    }
    console.log(`${provider}: native MCP allow executed once; deny did not execute; original reviewer preserved`);
  } finally {
    for (const call of pending.values()) clearTimeout(call.timer);
    lines.close();
    if (app.exitCode === null) {
      if (process.platform === "win32") spawnSync("taskkill.exe", ["/PID", String(app.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      else app.kill();
      if (app.exitCode === null) await new Promise(resolve => app.once("exit", resolve));
    }
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}
