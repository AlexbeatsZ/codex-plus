import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { JSDOM } from "jsdom";

const script = await readFile(new URL("../assets/renderer.js", import.meta.url), "utf8");
const apiScript = await readFile(new URL("../assets/api-providers.js", import.meta.url), "utf8");
const routingScript = await readFile(new URL("../assets/model-routing.js", import.meta.url), "utf8");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

async function flush(rounds = 4) {
  for (let index = 0; index < rounds; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function setup(invoke) {
  const dom = new JSDOM(`<!doctype html><html><head></head><body><div role="menu" id="profile-menu"><button role="menuitem" class="native">设置</button><button role="menuitem" class="native">退出登录</button></div></body></html>`, {
    runScripts: "dangerously",
    url: "app://-/index.html",
  });
  dom.window.Response = class { async json() { return {}; } };
  dom.window.codexPlusInvoke = invoke;
  dom.window.electronBridge = { sendMessageFromView: (message) => message };
  dom.window.eval(script);
  dom.window.eval(apiScript);
  dom.window.eval(routingScript);
  return dom;
}

test("inserts Cable API item above one UsersRound account item", async () => {
  const dom = setup(async () => ({ status: "ok", accounts: [] }));
  await flush();
  const menu = dom.window.document.getElementById("profile-menu");
  const labels = [...menu.children].map((node) => node.textContent.trim());
  assert.deepEqual(labels, ["设置", "API 接入", "切换账户", "退出登录"]);
  const apiItem = menu.querySelector("[data-codex-plus-api-item]");
  assert.equal(apiItem.querySelector("svg")?.querySelectorAll("path").length, 2);
  assert.equal(apiItem.querySelector("svg")?.querySelectorAll("line").length, 1);
  const item = menu.querySelector("[data-codex-plus-account-item]");
  assert.equal(item.querySelector("svg")?.getAttribute("viewBox"), "0 0 24 24");
  assert.equal(item.querySelector(".cp-menu-row")?.textContent, "切换账户");
  dom.window.__codexPlusAccounts.install();
  await flush();
  assert.equal(menu.querySelectorAll("[data-codex-plus-account-item]").length, 1);
});

test("discovers models, edits aliases, and saves without receiving a key", async () => {
  const calls = [];
  const dom = setup(async (path, payload) => {
    calls.push({ path, payload });
    if (path === "/api-providers/catalog") return { status: "ok", models: [] };
    if (path === "/api-providers/list") return { status: "ok", providers: [] };
    if (path === "/api-providers/discover") return { status: "ok", models: [{ modelId: "same-model", displayName: "same-model", visible: true }] };
    if (path === "/api-providers/save") return { status: "ok", providers: [] };
    return { status: "ok", accounts: [] };
  });
  await flush();
  dom.window.document.querySelector("[data-codex-plus-api-item]").click();
  await flush();
  dom.window.document.querySelector("[data-api-new]").click();
  const form = dom.window.document.querySelector("[data-api-form]");
  assert.equal(form.elements.protocol.value, "chatCompletions");
  form.elements.name.value = "Local API";
  form.elements.baseUrl.value = "http://127.0.0.1:18080/v1";
  form.elements.apiKey.value = "test-secret";
  dom.window.document.querySelector("[data-api-discover]").click();
  await flush();
  const alias = dom.window.document.querySelector("[data-model-name]");
  assert.equal(alias.value, "same-model");
  alias.value = "我的模型";
  dom.window.document.querySelector("[data-api-form]").dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
  await flush();
  const save = calls.find((call) => call.path === "/api-providers/save");
  assert.equal(save.payload.models[0].displayName, "我的模型");
  assert.equal(save.payload.models[0].visible, true);
  const lists = calls.filter((call) => call.path === "/api-providers/list");
  assert.ok(lists.every((call) => !("apiKey" in call.payload)));
});

test("routes official and API thread starts and removes thread list provider filter", async () => {
  const dom = setup(async (path) => path === "/api-providers/catalog" ? {
    status: "ok", providerId: "codex-plus-api", models: [{ routeId: "cp-route", modelId: "same", displayName: "Alias", providerName: "API A" }],
  } : { status: "ok", accounts: [] });
  await flush();
  const routing = dom.window.__codexPlusModelRouting;
  await routing.loadCatalog(true);
  routing.setSelectedModel("cp-route");
  assert.equal(routing.selectedModel(), "cp-route");
  assert.equal(routing.state.byRoute.has("cp-route"), true);
  const apiStart = routing.patchRoutingMessage({ type: "mcp-request", request: { method: "thread/start", params: { model: "gpt-5" } } });
  assert.equal(apiStart.request.params.model, "cp-route");
  assert.equal(apiStart.request.params.modelProvider, "codex-plus-api");
  const list = routing.patchRoutingMessage({ type: "mcp-request", request: { method: "thread/list", params: { modelProviders: ["openai"] } } });
  assert.equal(list.request.params.modelProviders.length, 0);
  routing.setSelectedModel("");
  const official = routing.patchRoutingMessage({ type: "mcp-request", request: { method: "thread/start", params: { model: "gpt-5" } } });
  assert.equal(official.request.params.modelProvider, "openai");
});

test("applies API to API turns and controls cross-provider resume with rollback", async () => {
  const dom = setup(async (path) => path === "/api-providers/catalog" ? {
    status: "ok", models: [{ routeId: "cp-a", modelId: "a", displayName: "A", providerName: "API" }, { routeId: "cp-b", modelId: "b", displayName: "B", providerName: "API" }],
  } : { status: "ok", accounts: [] });
  const routing = dom.window.__codexPlusModelRouting;
  await routing.loadCatalog(true);
  routing.setSelectedModel("cp-b");
  const turn = routing.patchRoutingMessage({ type: "mcp-request", request: { method: "turn/start", params: { threadId: "t", model: "cp-a", modelProvider: "codex-plus-api" } } });
  assert.equal(turn.request.params.model, "cp-b");
  assert.throws(() => routing.patchRoutingMessage({ type: "mcp-request", request: { method: "turn/start", params: { threadId: "t", model: "gpt-5", modelProvider: "openai" } } }), /阻止发送/);
  await assert.rejects(routing.experimentalSwitchThread({ threadId: "t", currentModel: "gpt-5", currentProvider: "openai", targetModel: "cp-b", targetProvider: "codex-plus-api", idle: false }), /仍在运行/);

  const calls = [];
  routing.setTransportForTest(async (message) => {
    calls.push(message);
    if (message.method === "thread/resume" && message.params.modelProvider === "codex-plus-api") throw new Error("resume rejected");
    return { modelProvider: message.params?.modelProvider };
  });
  await assert.rejects(routing.experimentalSwitchThread({ threadId: "t", currentModel: "gpt-5", currentProvider: "openai", targetModel: "cp-b", targetProvider: "codex-plus-api", idle: true }), /已尝试恢复/);
  assert.deepEqual(calls.map((call) => call.method), ["thread/shutdown", "thread/resume", "thread/resume"]);
  assert.equal(calls.at(-1).params.modelProvider, "openai");
});

test("installs with a non-extensible Electron bridge and keeps API bridge usable", async () => {
  const calls = [];
  const dom = new JSDOM(`<!doctype html><html><head></head><body><div role="menu"><button role="menuitem">设置</button><button role="menuitem">退出登录</button></div></body></html>`, { runScripts: "dangerously", url: "app://-/index.html" });
  dom.window.Response = class { async json() { return {}; } };
  dom.window.codexPlusInvoke = async (path) => { calls.push(path); return path === "/api-providers/catalog" ? { status: "ok", models: [] } : { status: "ok", providers: [] }; };
  dom.window.electronBridge = Object.freeze({ sendMessageFromView: (message) => message });
  assert.doesNotThrow(() => { dom.window.eval(script); dom.window.eval(apiScript); dom.window.eval(routingScript); });
  await flush();
  dom.window.document.querySelector("[data-codex-plus-api-item]").click();
  await flush();
  assert.ok(calls.includes("/api-providers/list"));
  assert.equal(dom.window.__codexPlusModelRouting.state.diagnostics.some((entry) => entry.event === "immutable-electron-bridge"), true);
  assert.match(dom.window.document.getElementById("codex-plus-api-style").textContent, /color-scheme:dark/);
  assert.match(dom.window.document.getElementById("codex-plus-api-style").textContent, /\.cp-api-select option\{color:#f4f4f5;background:#18181b\}/);
});

test("renders account buttons before independent usage requests finish", async () => {
  const usageOne = deferred();
  const usageTwo = deferred();
  const dom = setup(async (path, payload) => {
    if (path === "/accounts/list") {
      return {
        status: "ok",
        accounts: [
          { accountId: "one", email: "one@example.com", active: true },
          { accountId: "two", email: "two@example.com", active: false },
        ],
      };
    }
    if (path === "/accounts/usage") return payload.accountId === "one" ? usageOne.promise : usageTwo.promise;
    throw new Error(`unexpected ${path}`);
  });
  await flush();
  dom.window.document.querySelector("[data-codex-plus-account-item]").click();
  await flush();
  assert.equal(dom.window.document.querySelectorAll(".cp-account-row").length, 2);
  assert.equal(dom.window.document.querySelector('[data-cp-switch="two"]')?.textContent, "切换");
  assert.equal(dom.window.document.querySelectorAll(".cp-usage-loading").length, 2);
  assert.equal(dom.window.document.querySelector(".cp-account-list + .cp-account-list-actions [data-cp-add]")?.textContent, "添加账户");
  assert.equal(dom.window.document.querySelector(".cp-account-tabs"), null);

  usageOne.resolve({
    status: "ok",
    usage: { rate_limit: { primary_window: { used_percent: 25, limit_window_seconds: 18000, reset_at: 2000000000 } } },
  });
  await flush();
  assert.match(dom.window.document.querySelector('[data-account-id="one"] .cp-account-usage').textContent, /剩余 75%/);
  assert.match(dom.window.document.querySelector('[data-account-id="two"] .cp-account-usage').textContent, /读取中/);
  usageTwo.resolve({ status: "failed", message: "额度暂不可用" });
  await flush();
});

test("file selection only fills the textarea and import requires the second button", async () => {
  const calls = [];
  const auth = JSON.stringify({ auth_mode: "chatgpt", tokens: { account_id: "a" } });
  const dom = setup(async (path, payload) => {
    calls.push({ path, payload });
    if (path === "/accounts/list") return { status: "ok", accounts: [] };
    if (path === "/accounts/import") return { status: "ok", account: { accountId: "a" } };
    throw new Error(`unexpected ${path}`);
  });
  await flush();
  dom.window.document.querySelector("[data-codex-plus-account-item]").click();
  await flush();
  dom.window.document.querySelector("[data-cp-add]").click();
  await flush();
  assert.equal(dom.window.document.querySelector(".cp-import-title")?.textContent, "添加账户");
  assert.equal(dom.window.document.querySelector("[data-cp-view]"), null);
  const fileInput = dom.window.document.querySelector("[data-cp-file]");
  Object.defineProperty(fileInput, "files", {
    configurable: true,
    value: [{ name: "account.txt", text: async () => auth }],
  });
  fileInput.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  await flush();
  assert.equal(dom.window.document.querySelector("[data-cp-auth]").value, auth);
  assert.equal(calls.filter((call) => call.path === "/accounts/import").length, 0);
  assert.deepEqual(
    [...dom.window.document.querySelectorAll(".cp-import-actions button")].map((button) => button.textContent),
    ["返回", "选取文件", "导入"],
  );

  dom.window.document.querySelector("[data-cp-import]").click();
  await flush(8);
  const imports = calls.filter((call) => call.path === "/accounts/import");
  assert.equal(imports.length, 1);
  assert.equal(imports[0].payload.authContents, auth);
  assert.equal(dom.window.document.querySelector("[data-cp-add]")?.textContent, "添加账户");
  assert.equal(dom.window.document.querySelector("[data-cp-auth]"), null);
});

test("invalid JSON preserves the draft and never calls the backend", async () => {
  const calls = [];
  const dom = setup(async (path) => {
    calls.push(path);
    return { status: "ok", accounts: [] };
  });
  await flush();
  dom.window.document.querySelector("[data-codex-plus-account-item]").click();
  await flush();
  dom.window.document.querySelector("[data-cp-add]").click();
  const textarea = dom.window.document.querySelector("[data-cp-auth]");
  textarea.value = "not-json";
  textarea.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  dom.window.document.querySelector("[data-cp-import]").click();
  await flush();
  assert.equal(dom.window.document.querySelector("[data-cp-auth]").value, "not-json");
  assert.match(dom.window.document.querySelector(".cp-account-status").textContent, /有效/);
  assert.equal(calls.filter((path) => path === "/accounts/import").length, 0);
});
