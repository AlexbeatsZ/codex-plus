// Invoked by the Rust mock fixture. Every credential and upstream is synthetic.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { once } from "node:events";

const [binary, home, externalRoute, poolRoute] = process.argv.slice(2);
const source = process.env.CODEX_PLUS_NATIVE_CATALOG || path.join(os.homedir(), ".codex/models_cache.json");
const template = JSON.parse(fs.readFileSync(source, "utf8")).models[0];
// Keep fake ChatGPT auth, without a selected workspace requiring live HTTPS
// accounts/check. No actual account, pairing or workspace policy is changed.
const auth = JSON.parse(fs.readFileSync(path.join(home, "auth.json"), "utf8"));
delete auth.tokens.account_id;
const clientHome = path.join(home, "isolated-client");
fs.mkdirSync(clientHome);
fs.copyFileSync(path.join(home, "config.toml"), path.join(clientHome, "config.toml"));
fs.writeFileSync(path.join(clientHome, "auth.json"), JSON.stringify(auth));
fs.writeFileSync(path.join(home, "models_cache.json"), JSON.stringify({ models: [{ ...template, slug: "gpt-test", display_name: "Official fixture", use_responses_lite: false, tool_mode: "direct" }] }));
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/TOKEN|KEY|AUTH|PROXY|CODEX|OPENAI/.test(key)));
env.CODEX_HOME = clientHome;
const app = spawn(binary, ["app-server", "--listen", "stdio://", "-c", "analytics.enabled=false"], { cwd: home, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
const lines = createInterface({ input: app.stdout });
let sequence = 0, stderr = "";
const calls = new Map(), waiters = [];
app.stderr.on("data", bytes => { stderr = (stderr + bytes).slice(-6000); });
lines.on("line", line => {
  let message; try { message = JSON.parse(line); } catch { return; }
  const call = calls.get(message.id);
  if (call) { clearTimeout(call.timer); calls.delete(message.id); message.error ? call.reject(Error(JSON.stringify(message.error))) : call.resolve(message.result); }
  for (const waiter of waiters) if (message.method === waiter.method && waiter.filter(message.params)) { clearTimeout(waiter.timer); waiter.resolve(message.params); }
});
const rpc = (method, params) => new Promise((resolve, reject) => {
  const id = ++sequence;
  const timer = setTimeout(() => reject(Error(`Timeout ${method}: ${stderr}`)), 20000);
  calls.set(id, { resolve, reject, timer });
  app.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
});
const waitFor = (method, filter) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(Error(`Event timeout ${method}: ${stderr}`)), 20000);
  waiters.push({ method, filter, resolve, timer });
});
try {
  await rpc("initialize", { clientInfo: { name: "native_mobile_fixture", version: "1" }, capabilities: { experimentalApi: true } });
  app.stdin.write('{"method":"initialized"}\n');
  const models = await rpc("model/list", { includeHidden: true, limit: 100 });
  for (const route of ["gpt-test", externalRoute, poolRoute]) assert.ok(models.data.some(model => model.model === route), `Native catalog missing ${route}: ${JSON.stringify(models)} ${stderr}`);
  const create = async (model, provider = "openai") => (await rpc("thread/start", { cwd: clientHome, model, modelProvider: provider, approvalPolicy: "never", sandbox: "read-only", baseInstructions: "Reply OK. Do not call tools." })).thread;
  const turn = async (threadId, model) => {
    const completed = waitFor("turn/completed", params => params.threadId === threadId);
    await rpc("turn/start", { threadId, model, input: [{ type: "text", text: "Isolated mobile gateway fixture. Reply OK." }] });
    const result = await completed;
    assert.equal(result.turn.status, "completed", `${JSON.stringify(result.turn)} ${stderr}`);
  };
  const thread = await create("gpt-test");
  for (const model of ["gpt-test", externalRoute, poolRoute]) await turn(thread.id, model);
  assert.equal((await rpc("thread/read", { threadId: thread.id, includeTurns: true })).thread.turns.length, 3);
  const compacted = waitFor("item/completed", params => params.threadId === thread.id && params.item.type === "contextCompaction");
  const compactFinished = waitFor("turn/completed", params => params.threadId === thread.id);
  await rpc("thread/compact/start", { threadId: thread.id });
  await compacted;
  await compactFinished;
  await turn(thread.id, poolRoute);
  const legacy = await create(externalRoute, "codex-plus-api");
  await turn(legacy.id, externalRoute);
  const forked = await rpc("thread/fork", { threadId: legacy.id, model: externalRoute, modelProvider: "openai" });
  assert.equal(forked.thread.modelProvider, "openai");
  const inherited = await rpc("thread/read", { threadId: forked.thread.id, includeTurns: true });
  assert.ok(inherited.thread.turns.length >= 1, "Native fork must preserve source history");
  await turn(forked.thread.id, poolRoute);
  const list = await rpc("thread/list", { cursor: null, limit: 100, modelProviders: null, useStateDbOnly: true });
  assert.ok(list.data.some(entry => entry.id === thread.id));
  assert.ok(list.data.some(entry => entry.id === forked.thread.id));
  assert.ok(!list.data.some(entry => entry.id === legacy.id));
  assert.equal((await rpc("thread/read", { threadId: legacy.id, includeTurns: true })).thread.turns.length, 1);
  console.log(JSON.stringify({ check: "native-mobile-gateway", nativeCatalog: true, sameThreadThreeChannels: true, compactionAndContinuation: true, inheritedHistory: true, sourcePreserved: true, defaultListVisible: true, realModelRequests: 0 }));
} finally {
  for (const { timer } of calls.values()) clearTimeout(timer);
  for (const { timer } of waiters) clearTimeout(timer);
  lines.close();
  if (app.exitCode === null && app.signalCode === null) { const exit = once(app, "exit"); app.kill("SIGTERM"); await exit; }
}
