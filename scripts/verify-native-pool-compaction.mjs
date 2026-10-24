// Offline opt-in probe, launched by the Rust subscription test fixture.
// No real credentials, desktop process, network upstream or production state.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";

const [binary, poolBase] = process.argv.slice(2);
assert.ok(binary && poolBase, "Pass native app-server binary and isolated subscription endpoint");
const parent = path.join(os.tmpdir(), ".agents"); fs.mkdirSync(parent, { recursive: true });
const root = fs.mkdtempSync(path.join(parent, "codex-plus-native-compact-"));
const home = path.join(root, "home"); fs.mkdirSync(home);
const nativeModel = "gpt-test", route = `cp-pool-${Buffer.from(nativeModel).toString("base64url")}`;
const catalogPath = process.env.CODEX_PLUS_NATIVE_CATALOG || path.join(os.homedir(), ".codex", "models_cache.json");
const template = JSON.parse(fs.readFileSync(catalogPath, "utf8")).models[0];
const catalogFile = path.join(home, "models.json");
fs.writeFileSync(catalogFile, JSON.stringify({ models: [{ ...template, slug: nativeModel, context_window: 1050000 }] }));
let firstRequests = 0;
const server = http.createServer(async (request, response) => {
  let raw = ""; for await (const chunk of request) raw += chunk;
  assert.equal(JSON.parse(raw).model, nativeModel); firstRequests += 1;
  const item = { type: "message", id: "m1", role: "assistant", content: [{ type: "output_text", text: "READY" }] };
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const event of [
    { type: "response.created", response: { id: "r1" } },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { id: "r1", status: "completed", output: [item], usage: { input_tokens: 900000, output_tokens: 5, total_tokens: 900005 } } },
  ]) response.write(`data: ${JSON.stringify(event)}\n\n`);
  response.end();
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const oldBase = `http://127.0.0.1:${server.address().port}/v1`;
fs.writeFileSync(path.join(home, "config.toml"), `web_search="disabled"
[features]
remote_compaction_v2=true
[model_providers.fixture]
name="fixture"
base_url="${oldBase}"
wire_api="responses"
requires_openai_auth=false
supports_websockets=false
[model_providers.fixture.capabilities]
remote_compaction="v2"
[model_providers.codex-plus-account-pool]
name="isolated pool"
base_url="${poolBase}"
wire_api="responses"
experimental_bearer_token="codex-plus-loopback"
requires_openai_auth=false
supports_websockets=false
[model_providers.codex-plus-account-pool.capabilities]
remote_compaction="v2"
`);
const app = spawn(binary, ["app-server", "--listen", "stdio://", "-c", `model_catalog_json=${JSON.stringify(catalogFile)}`],
  { cwd: root, env: { ...process.env, CODEX_HOME: home }, stdio: ["pipe", "pipe", "pipe"] });
app.stderr.on("data", () => {});
const lines = createInterface({ input: app.stdout }); const pending = new Map(), events = []; let sequence = 0;
lines.on("line", line => {
  let message; try { message = JSON.parse(line); } catch { return; }
  const call = pending.get(message.id);
  if (call) { clearTimeout(call.timer); pending.delete(message.id); message.error ? call.reject(Error(JSON.stringify(message.error))) : call.resolve(message.result); }
  else if (message.method) events.push(message);
});
const rpc = (method, params) => new Promise((resolve, reject) => {
  const id = ++sequence, timer = setTimeout(() => reject(Error(`Timeout: ${method}`)), 20000);
  pending.set(id, { resolve, reject, timer }); app.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
});
async function turn(threadId, model) {
  const offset = events.length;
  await rpc("turn/start", { threadId, model, effort: "low", input: [{ type: "text", text: "Reply READY" }] });
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const result = events.slice(offset).find(event => event.method === "turn/completed");
    if (result) { assert.equal(result.params.turn.status, "completed", JSON.stringify(result.params.turn.error)); return offset; }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw Error("Native turn completion timeout");
}
try {
  await rpc("initialize", { clientInfo: { name: "pool_compact_fixture", version: "1" }, capabilities: { experimentalApi: true } });
  app.stdin.write('{"method":"initialized"}\n');
  const started = await rpc("thread/start", { cwd: root, model: nativeModel, modelProvider: "fixture", approvalPolicy: "never", sandbox: "read-only", baseInstructions: "Do not invoke tools." });
  await turn(started.thread.id, nativeModel);
  const forked = await rpc("thread/fork", { threadId: started.thread.id, model: route, modelProvider: "codex-plus-account-pool", cwd: root, approvalPolicy: "never", sandbox: "read-only" });
  const offset = await turn(forked.thread.id, route);
  assert.ok(events.slice(offset).some(event => event.method === "item/completed" && event.params.item.type === "contextCompaction"));
  assert.equal(firstRequests, 1);
  console.log("Native inherited-history compaction and subsequent pool turn completed via isolated broker");
} finally {
  for (const call of pending.values()) clearTimeout(call.timer);
  lines.close();
  if (process.platform === "win32" && app.exitCode === null) spawnSync("taskkill.exe", ["/PID", String(app.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
  else app.kill();
  server.closeAllConnections(); server.close();
  // Wait for native process handles before removing the Windows fixture.
  if (app.exitCode === null) await new Promise(resolve => app.once("exit", resolve));
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
