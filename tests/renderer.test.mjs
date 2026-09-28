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
  const dom = new JSDOM(`<!doctype html><html><head></head><body><div role="menu" id="edit-menu"><button role="menuitem" class="native">撤销</button><button role="menuitem" class="native">设置 Ctrl+,</button></div><div role="menu" id="profile-menu"><button role="menuitem" class="native">设置</button><button role="menuitem" class="native">退出登录</button></div></body></html>`, {
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
  assert.equal(apiItem.querySelector("svg")?.getAttribute("width"), "16");
  assert.equal(apiItem.querySelector("svg")?.getAttribute("height"), "16");
  const item = menu.querySelector("[data-codex-plus-account-item]");
  assert.equal(item.querySelector("svg")?.getAttribute("viewBox"), "0 0 24 24");
  assert.equal(item.querySelector("svg")?.getAttribute("width"), "16");
  assert.equal(item.querySelector("svg")?.getAttribute("height"), "16");
  assert.equal(item.querySelector(".cp-menu-row")?.textContent, "切换账户");
  assert.match(dom.window.document.getElementById("codex-plus-account-style").textContent, /--cp-accent:#339cff/);
  assert.match(dom.window.document.getElementById("codex-plus-account-style").textContent, /\.cp-account-list \{ overflow:hidden; border:1px solid var\(--cp-border\)/);
  assert.match(dom.window.document.getElementById("codex-plus-api-style").textContent, /--cp-accent:#339cff/);
  dom.window.__codexPlusAccounts.install();
  await flush();
  assert.equal(menu.querySelectorAll("[data-codex-plus-account-item]").length, 1);
});

test("does not inject account or API items into the application Edit menu", async () => {
  const dom = setup(async () => ({ status: "ok", accounts: [] }));
  await flush();
  const editMenu = dom.window.document.getElementById("edit-menu");
  assert.equal(editMenu.querySelector("[data-codex-plus-account-item]"), null);
  assert.equal(editMenu.querySelector("[data-codex-plus-api-item]"), null);
  assert.deepEqual([...editMenu.children].map((node) => node.textContent.trim()), ["撤销", "设置 Ctrl+,"]);
});

test("menu observers ignore unrelated DOM churn and react to a new profile menu", async () => {
  const dom = setup(async () => ({ status: "ok", accounts: [] }));
  await flush();
  dom.window.document.getElementById("profile-menu").remove();
  await flush();

  const originalQuerySelectorAll = dom.window.document.querySelectorAll.bind(dom.window.document);
  let fullMenuScans = 0;
  dom.window.document.querySelectorAll = (selector) => {
    if (selector === '[role="menuitem"]') fullMenuScans += 1;
    return originalQuerySelectorAll(selector);
  };

  const unrelated = dom.window.document.createElement("section");
  dom.window.document.body.appendChild(unrelated);
  for (let index = 0; index < 100; index += 1) {
    unrelated.appendChild(dom.window.document.createElement("span"));
  }
  await flush();
  assert.equal(fullMenuScans, 0);

  const profile = dom.window.document.createElement("div");
  profile.id = "replacement-profile-menu";
  profile.setAttribute("role", "menu");
  profile.innerHTML = '<button role="menuitem">设置</button><button role="menuitem">退出登录</button>';
  dom.window.document.body.appendChild(profile);
  await flush();
  assert.ok(fullMenuScans >= 2);
  assert.deepEqual(
    [...profile.children].map((node) => node.textContent.trim()),
    ["设置", "API 接入", "切换账户", "退出登录"],
  );
});

test("reinjecting model routing does not add document click listeners", async () => {
  const dom = setup(async () => ({ status: "ok", models: [] }));
  await flush();
  const original = dom.window.document.addEventListener.bind(dom.window.document);
  let added = 0;
  dom.window.document.addEventListener = (type, ...args) => {
    if (type === "click") added += 1;
    return original(type, ...args);
  };

  dom.window.eval(routingScript);
  dom.window.eval(routingScript);
  await flush();
  assert.equal(added, 0);
  dom.window.close();
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
  const discoveredForm = dom.window.document.querySelector("[data-api-form]");
  assert.equal(discoveredForm.elements.name.value, "Local API");
  assert.equal(discoveredForm.elements.baseUrl.value, "http://127.0.0.1:18080/v1");
  assert.equal(discoveredForm.elements.apiKey.value, "test-secret");
  assert.equal(discoveredForm.elements.protocol.value, "chatCompletions");
  assert.equal(discoveredForm.elements.enabled.checked, true);
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

test("routes official and API thread starts with the native all-provider list sentinel", async () => {
  const dom = setup(async (path) => path === "/api-providers/catalog" ? {
    status: "ok", providerId: "codex-plus-api", models: [{ routeId: "cp-route", modelId: "same", displayName: "Alias", providerName: "API A" }],
  } : { status: "ok", accounts: [] });
  await flush();
  const routing = dom.window.__codexPlusModelRouting;
  await routing.loadCatalog(true);
  assert.equal(routing.state.byRoute.has("cp-route"), true);
  const apiStart = routing.patchRoutingMessage({ type: "mcp-request", request: { method: "thread/start", params: { model: "cp-route" } } });
  assert.equal(apiStart.request.params.model, "cp-route");
  assert.equal(apiStart.request.params.modelProvider, "codex-plus-api");
  const list = routing.patchRoutingMessage({ type: "mcp-request", request: { method: "thread/list", params: { modelProviders: ["openai"], sourceKinds: ["vscode"], archived: false } } });
  assert.equal(list.request.params.modelProviders, null);
  assert.deepEqual(list.request.params.sourceKinds, ["vscode"]);
  assert.equal(list.request.params.archived, false);
  const official = routing.patchRoutingMessage({ type: "mcp-request", request: { method: "thread/start", params: { model: "gpt-5" } } });
  assert.equal(official.request.params.modelProvider, "openai");
});

test("applies API to API turns and routes cross-provider forks", async () => {
  const dom = setup(async (path) => path === "/api-providers/catalog" ? {
    status: "ok", models: [{ routeId: "cp-a", modelId: "a", displayName: "A", providerName: "API" }, { routeId: "cp-b", modelId: "b", displayName: "B", providerName: "API" }],
  } : { status: "ok", accounts: [] });
  const routing = dom.window.__codexPlusModelRouting;
  await routing.loadCatalog(true);
  const turn = routing.patchRoutingMessage({ type: "mcp-request", request: { method: "turn/start", params: { threadId: "t", model: "cp-b", modelProvider: "codex-plus-api" } } });
  assert.equal(turn.request.params.model, "cp-b");
  assert.throws(() => routing.patchRoutingMessage({ type: "mcp-request", request: { method: "turn/start", params: { threadId: "t", model: "cp-b", modelProvider: "openai" } } }), /阻止发送/);
  const fork = routing.patchRoutingMessage({ type: "mcp-request", request: { method: "thread/fork", params: { threadId: "t", model: "cp-b" } } });
  assert.equal(fork.request.params.modelProvider, "codex-plus-api");
  await assert.rejects(routing.experimentalSwitchThread({ threadId: "t", currentModel: "gpt-5", currentProvider: "openai", targetModel: "cp-b", targetProvider: "codex-plus-api", idle: false }), /仍在运行/);

  const calls = [];
  routing.setTransportForTest(async (message) => {
    calls.push(message);
    return { thread: { id: "forked", modelProvider: message.params?.modelProvider } };
  });
  const switched = await routing.experimentalSwitchThread({ threadId: "t", currentModel: "gpt-5", currentProvider: "openai", targetModel: "cp-b", targetProvider: "codex-plus-api", idle: true });
  assert.deepEqual(calls.map((call) => call.method), ["thread/fork"]);
  assert.equal(calls[0].params.modelProvider, "codex-plus-api");
  assert.equal("excludeTurns" in calls[0].params, false);
  assert.equal(switched.threadId, "forked");
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
  assert.equal(dom.window.__codexPlusModelRouting.version, 16);
  assert.match(dom.window.document.getElementById("codex-plus-api-style").textContent, /color-scheme:dark/);
  assert.match(dom.window.document.getElementById("codex-plus-api-style").textContent, /\.cp-api-select option \{ color:var\(--cp-text\); background:var\(--cp-bg\); \}/);
});

test("patches the real app-server client for native models and provider routing", async () => {
  const dom = setup(async (path) => path === "/api-providers/catalog" ? {
    status: "ok", models: [{ routeId: "cp-route", modelId: "upstream-model", displayName: "API Alias", providerName: "API A" }],
  } : { status: "ok", accounts: [] });
  const routing = dom.window.__codexPlusModelRouting;
  await routing.loadCatalog(true);
  dom.window.confirm = () => true;
  const calls = [];
  const client = {
    requestPromises: new dom.window.Map(),
    async enqueueRequest(method, params) {
      calls.push({ method, params });
      if (method === "list-models") return { data: [{ id: "gpt-5", model: "gpt-5", displayName: "GPT-5", supportedReasoningEfforts: [] }] };
      if (method === "thread/list") return { data: [] };
      if (method === "thread/start") return { thread: { id: "new-thread", modelProvider: params.modelProvider, status: { type: "idle" } } };
      if (method === "thread/read") {
        const provider = ["new-thread", "api-child"].includes(params.threadId) ? "codex-plus-api" : "openai";
        return { thread: { id: params.threadId, modelProvider: provider, status: { type: "idle" } } };
      }
      return {};
    },
    async sendRequest(method, params, options) {
      return this.enqueueRequest(method, params, options);
    },
    async prewarmThreadStart(params, options) {
      return this.enqueueRequest("thread/start", params, options, () => {});
    },
  };
  assert.equal(routing.installRequestClientForTest(client), true);
  const addThreadRow = (threadId, title) => {
    const row = dom.window.document.createElement("div");
    row.setAttribute("data-app-action-sidebar-thread-id", `local:${threadId}`);
    row.setAttribute("data-app-action-sidebar-thread-host-id", "local");
    row.setAttribute("data-app-action-sidebar-thread-title", title);
    row.addEventListener("click", () => row.setAttribute("data-clicked", "true"));
    dom.window.document.body.append(row);
    return row;
  };
  addThreadRow("existing", "Official source");
  addThreadRow("new-thread", "API source");
  const apiChildRow = addThreadRow("api-child", "API child");
  const gptChildRow = addThreadRow("gpt-child", "GPT child");
  routing.setAppDispatchForTest(async (method, params) => {
    calls.push({ method: `dispatch:${method}`, params });
    if (method === "fork-conversation-from-latest") return params.conversationId === "existing" ? "api-child" : "gpt-child";
    return {};
  });
  let prewarmClears = 0;
  assert.equal(routing.installConversationManagerForTest({ requestClient: client, clearPrewarmedThreads: () => { prewarmClears += 1; } }), true);
  assert.equal(prewarmClears, 1);
  routing.setSelectedModel("cp-route");
  assert.equal(prewarmClears, 2);
  const models = await client.sendRequest("list-models", {});
  assert.deepEqual(models.data.map((model) => model.model), ["gpt-5", "cp-route"]);
  assert.equal(models.data[1].displayName, "API Alias");
  await client.sendRequest("thread/start", { model: "cp-route" });
  assert.equal(calls.find((call) => call.method === "thread/start").params.modelProvider, "codex-plus-api");
  await client.prewarmThreadStart({ model: "cp-route" });
  assert.equal(calls.filter((call) => call.method === "thread/start").at(-1).params.modelProvider, "codex-plus-api");
  await client.sendRequest("thread/list", { modelProviders: ["openai"] });
  assert.equal(calls.find((call) => call.method === "thread/list").params.modelProviders, null);
  await client.sendRequest("turn/start", { threadId: "existing", model: "cp-route" });
  assert.deepEqual(calls.slice(-5).map((call) => call.method), ["thread/read", "dispatch:fork-conversation-from-latest", "thread/read", "dispatch:set-thread-title", "turn/start"]);
  assert.equal(calls.at(-4).params.model, "cp-route");
  assert.equal(calls.at(-1).params.threadId, "api-child");
  await flush();
  assert.equal(apiChildRow.getAttribute("data-clicked"), "true");
  const officialOption = dom.window.document.createElement("button");
  officialOption.setAttribute("role", "option");
  officialOption.setAttribute("data-value", "gpt-5");
  officialOption.textContent = "GPT-5";
  dom.window.document.body.append(officialOption);
  officialOption.click();
  await client.sendRequest("turn/start", { threadId: "new-thread", modelProvider: "openai" });
  assert.deepEqual(calls.slice(-5).map((call) => call.method), ["thread/read", "dispatch:fork-conversation-from-latest", "thread/read", "dispatch:set-thread-title", "turn/start"]);
  assert.equal(calls.at(-4).params.model, "gpt-5");
  assert.equal(calls.at(-1).params.threadId, "gpt-child");
  assert.equal(calls.at(-1).params.model, "gpt-5");
  assert.equal(routing.selectedModel(), "");
  await flush();
  assert.equal(gptChildRow.getAttribute("data-clicked"), "true");
});

test("does not fork or send when the user cancels a provider branch", async () => {
  const dom = setup(async (path) => path === "/api-providers/catalog" ? {
    status: "ok", models: [{ routeId: "cp-route", modelId: "upstream-model", displayName: "API Alias", providerName: "API A" }],
  } : { status: "ok", accounts: [] });
  const routing = dom.window.__codexPlusModelRouting;
  await routing.loadCatalog(true);
  dom.window.confirm = () => false;
  const calls = [];
  const client = {
    requestPromises: new dom.window.Map(),
    async enqueueRequest(method, params) {
      calls.push({ method, params });
      if (method === "list-models") return { data: [{ id: "gpt-5", model: "gpt-5", displayName: "GPT-5", supportedReasoningEfforts: [] }] };
      if (method === "thread/start") return { thread: { id: "api-thread", model: params.model, modelProvider: params.modelProvider, status: { type: "idle" } } };
      if (method === "thread/read") return { thread: { id: params.threadId, model: "cp-route", modelProvider: "codex-plus-api", status: { type: "idle" } } };
      return {};
    },
    async sendRequest(method, params, options) {
      return this.enqueueRequest(method, params, options);
    },
  };
  routing.installRequestClientForTest(client);
  await client.sendRequest("list-models", {});
  await client.sendRequest("thread/start", { model: "cp-route" });
  const officialOption = dom.window.document.createElement("button");
  officialOption.setAttribute("role", "option");
  officialOption.setAttribute("data-value", "gpt-5");
  officialOption.textContent = "GPT-5";
  dom.window.document.body.append(officialOption);
  officialOption.click();
  await assert.rejects(client.sendRequest("turn/start", { threadId: "api-thread" }), /已取消跨 provider 历史分支/);
  assert.equal(calls.at(-1).method, "thread/read");
  assert.equal(calls.some((call) => call.method === "turn/start" || call.method === "thread/fork"), false);
  assert.equal(routing.selectedModel(), "cp-route");
});

test("blocks the turn when a provider fork cannot be verified", async () => {
  const dom = setup(async (path) => path === "/api-providers/catalog" ? {
    status: "ok", models: [{ routeId: "cp-route", modelId: "upstream-model", displayName: "API Alias", providerName: "API A" }],
  } : { status: "ok", accounts: [] });
  const routing = dom.window.__codexPlusModelRouting;
  await routing.loadCatalog(true);
  dom.window.confirm = () => true;
  const calls = [];
  const client = {
    requestPromises: new dom.window.Map(),
    async enqueueRequest(method, params) {
      calls.push({ method, params });
      if (method === "list-models") return { data: [{ id: "gpt-5", model: "gpt-5", displayName: "GPT-5", supportedReasoningEfforts: [] }] };
      if (method === "thread/start") return { thread: { id: "api-thread", model: params.model, modelProvider: params.modelProvider, status: { type: "idle" } } };
      if (method === "thread/read") return { thread: { id: params.threadId, model: "cp-route", modelProvider: "codex-plus-api", status: { type: "idle" } } };
      return {};
    },
    async sendRequest(method, params, options) {
      return this.enqueueRequest(method, params, options);
    },
  };
  routing.installRequestClientForTest(client);
  routing.setAppDispatchForTest(async (method, params) => {
    calls.push({ method: `dispatch:${method}`, params });
    if (method === "fork-conversation-from-latest") return "bad-child";
    return {};
  });
  await client.sendRequest("list-models", {});
  await client.sendRequest("thread/start", { model: "cp-route" });
  const officialOption = dom.window.document.createElement("button");
  officialOption.setAttribute("role", "option");
  officialOption.setAttribute("data-value", "gpt-5");
  officialOption.textContent = "GPT-5";
  dom.window.document.body.append(officialOption);
  officialOption.click();
  await assert.rejects(client.sendRequest("turn/start", { threadId: "api-thread" }), /provider 验证失败：codex-plus-api/);
  assert.equal(calls.some((call) => call.method === "turn/start"), false);
  assert.equal(routing.selectedModel(), "cp-route");
});

test("renders account buttons before independent usage requests finish", async () => {
  const usageOne = deferred();
  const usageTwo = deferred();
  const dom = setup(async (path, payload) => {
    if (path === "/accounts/list") {
      return {
        status: "ok",
        accounts: [
          { recordId: "one", accountId: "workspace", email: "one@example.com", active: true },
          { recordId: "two", accountId: "workspace", email: "two@example.com", active: false },
        ],
      };
    }
    if (path === "/accounts/usage") return payload.recordId === "one" ? usageOne.promise : usageTwo.promise;
    throw new Error(`unexpected ${path}`);
  });
  await flush();
  dom.window.document.querySelector("[data-codex-plus-account-item]").click();
  await flush();
  assert.equal(dom.window.document.querySelectorAll(".cp-account-row").length, 2);
  assert.equal(dom.window.document.querySelector('[data-cp-switch="two"]')?.textContent, "切换");
  assert.equal(dom.window.document.querySelector('[data-cp-delete="one"]')?.disabled, true);
  assert.equal(dom.window.document.querySelector('[data-cp-delete="two"]')?.disabled, false);
  assert.equal(dom.window.document.querySelectorAll(".cp-usage-loading").length, 2);
  assert.equal(dom.window.document.querySelector(".cp-account-list + .cp-account-list-actions [data-cp-add]")?.textContent, "导入 auth.json");
  assert.equal(dom.window.document.querySelector("[data-cp-web-login]")?.textContent, "网页登录新账户");
  assert.equal(dom.window.document.querySelector(".cp-account-tabs"), null);

  usageOne.resolve({
    status: "ok",
    usage: { rate_limit: { primary_window: { used_percent: 25, limit_window_seconds: 18000, reset_at: 2000000000 } } },
  });
  await flush();
  assert.match(dom.window.document.querySelector('[data-record-id="one"] .cp-account-usage').textContent, /剩余 75%/);
  assert.match(dom.window.document.querySelector('[data-record-id="two"] .cp-account-usage').textContent, /读取中/);
  usageTwo.resolve({ status: "failed", message: "额度暂不可用" });
  await flush();
});

test("file selection only fills the textarea and import requires the second button", async () => {
  const calls = [];
  const auth = JSON.stringify({ auth_mode: "chatgpt", tokens: { account_id: "a" } });
  const dom = setup(async (path, payload) => {
    calls.push({ path, payload });
    if (path === "/accounts/list") return { status: "ok", accounts: [] };
    if (path === "/accounts/import") return { status: "ok", account: { recordId: "a", accountId: "workspace" } };
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
  assert.equal(dom.window.document.querySelector("[data-cp-add]")?.textContent, "导入 auth.json");
  assert.equal(dom.window.document.querySelector("[data-cp-auth]"), null);
});

test("deletes only an inactive saved account after explicit confirmation", async () => {
  const calls = [];
  const dom = setup(async (path, payload) => {
    calls.push({ path, payload });
    if (path === "/accounts/list") return {
      status: "ok",
      accounts: [
        { recordId: "one", accountId: "workspace", email: "one@example.com", active: true },
        { recordId: "two", accountId: "workspace", email: "two@example.com", active: false },
      ],
    };
    if (path === "/accounts/usage") return { status: "ok", usage: {} };
    if (path === "/accounts/delete") return { status: "ok", recordId: payload.recordId };
    throw new Error(`unexpected ${path}`);
  });
  dom.window.confirm = () => true;
  await flush();
  dom.window.document.querySelector("[data-codex-plus-account-item]").click();
  await flush();

  assert.equal(dom.window.document.querySelector('[data-cp-delete="one"]').disabled, true);
  dom.window.document.querySelector('[data-cp-delete="two"]').click();
  await flush();

  const deletes = calls.filter((call) => call.path === "/accounts/delete");
  assert.deepEqual(deletes.map((call) => call.payload.recordId), ["two"]);
  assert.equal(dom.window.document.querySelector('[data-record-id="two"]'), null);
  assert.match(dom.window.document.querySelector(".cp-account-status").textContent, /已删除/);
});

test("web login requires confirmation and requests the controlled restart", async () => {
  const calls = [];
  const dom = setup(async (path, payload) => {
    calls.push({ path, payload });
    if (path === "/accounts/list") return { status: "ok", accounts: [] };
    if (path === "/accounts/web-login") return { status: "accepted", message: "正在重启" };
    throw new Error(`unexpected ${path}`);
  });
  let confirmed = false;
  dom.window.confirm = () => confirmed;
  await flush();
  dom.window.document.querySelector("[data-codex-plus-account-item]").click();
  await flush();

  dom.window.document.querySelector("[data-cp-web-login]").click();
  await flush();
  assert.equal(calls.filter((call) => call.path === "/accounts/web-login").length, 0);

  confirmed = true;
  dom.window.document.querySelector("[data-cp-web-login]").click();
  await flush();
  assert.equal(calls.filter((call) => call.path === "/accounts/web-login").length, 1);
  assert.equal(dom.window.document.querySelector("[data-cp-web-login]").textContent, "正在重启…");
  assert.match(dom.window.document.querySelector(".cp-account-status").textContent, /正在重启/);
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

const bridgeScript = (
  await readFile(new URL("../assets/bridge.js", import.meta.url), "utf8")
).replace('"__CODEX_PLUS_BINDING_NAME__"', '"codexPlusAccountsBridgeV1"');

function bridgeDom() {
  const dom = new JSDOM("<!doctype html><html><head></head><body></body></html>", {
    runScripts: "dangerously",
    url: "app://-/index.html",
  });
  return dom;
}

test("bridge fails the promise when the launcher never answers", async () => {
  const dom = bridgeDom();
  const seen = [];
  dom.window.codexPlusAccountsBridgeV1 = (raw) => seen.push(JSON.parse(raw));
  dom.window.eval(bridgeScript);

  await assert.rejects(
    dom.window.codexPlusInvoke("/accounts/list", {}, { timeoutMs: 20 }),
    /请求超时/,
  );
  assert.equal(seen.length, 1);
  assert.equal(seen[0].path, "/accounts/list");
  assert.equal(dom.window.__codexPlusPending.size, 0);
});

test("bridge resolves a request when the launcher answers", async () => {
  const dom = bridgeDom();
  let payload = null;
  dom.window.codexPlusAccountsBridgeV1 = (raw) => { payload = JSON.parse(raw); };
  dom.window.eval(bridgeScript);

  const pending = dom.window.codexPlusInvoke("/accounts/list", {});
  await flush();
  assert.equal(payload.path, "/accounts/list");
  assert.equal(dom.window.__codexPlusBridgeResolve(payload.id, { status: "ok" }), true);
  assert.deepEqual(await pending, { status: "ok" });
  assert.equal(dom.window.__codexPlusPending.size, 0);
  assert.equal(dom.window.__codexPlusBridgeResolve(payload.id, { status: "ok" }), false);
});

test("re-injecting the bridge fails requests left over from the dead connection", async () => {
  const dom = bridgeDom();
  dom.window.codexPlusAccountsBridgeV1 = () => {};
  dom.window.eval(bridgeScript);

  const stranded = dom.window.codexPlusInvoke("/accounts/list", {});
  await flush();
  assert.equal(dom.window.__codexPlusPending.size, 1);

  dom.window.eval(bridgeScript);
  await assert.rejects(stranded, /重新连接/);
  assert.equal(dom.window.__codexPlusPending.size, 0);
});
