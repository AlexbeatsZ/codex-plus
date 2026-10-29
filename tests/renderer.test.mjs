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

test("legacy task migration stays in API settings and submits only the selected task and model", async () => {
  const dom = setup(async () => ({ status: "ok", providers: [], models: [] }));
  try {
    await flush();
    const submitted = [];
    dom.window.__codexPlusModelRouting = {
      loadCatalog: async () => {},
      legacyThreads: async () => [{ id: "legacy-one", title: "Old <task>" }, { id: "legacy-two", title: "Second task" }],
      state: { catalog: [{ routeId: "cp-selected", nativeProviderId: "openai", providerName: "API A", displayName: "Model" }] },
      migrateLegacyThread: async (...args) => { submitted.push(args); return { threadId: "child" }; },
    };
    dom.window.__codexPlusApi.open(); await flush();
    dom.window.document.querySelector("[data-api-mobile]").click(); await flush();
    assert.equal(dom.window.document.querySelector("[data-mobile-thread] option").textContent, "Old <task>");
    assert.equal(dom.window.document.querySelector("[data-api-body] task"), null);
    dom.window.document.querySelector("[data-mobile-thread]").value = "legacy-two";
    assert.equal(submitted.length, 0);
    dom.window.document.querySelector("[data-mobile-create]").click(); await flush();
    assert.deepEqual(submitted, [["legacy-two", "cp-selected"]]);
    assert.equal(dom.window.document.querySelector("#codex-plus-api-modal"), null);
  } finally { dom.window.close(); }
});

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

function setupSignedOut(invoke, body) {
  const dom = new JSDOM(`<!doctype html><html><head></head><body>${body}</body></html>`, {
    runScripts: "dangerously",
    url: "app://-/index.html",
  });
  dom.window.codexPlusInvoke = invoke;
  dom.window.eval(script);
  return dom;
}

test("signed-out login screen gets one account entry beside the native login buttons", async () => {
  const calls = [];
  const dom = setupSignedOut(async (path) => {
    calls.push(path);
    return { status: "ok", accounts: [{ recordId: "a".repeat(64), email: "saved@example.com", active: false }] };
  }, '<main><div id="login-actions"><button class="primary">使用 ChatGPT 登录</button><button class="secondary">使用 API 密钥</button></div><button>Continue in ChatGPT</button></main>');
  await flush();
  const actions = dom.window.document.getElementById("login-actions");
  assert.deepEqual([...actions.children].map((node) => node.textContent.trim()), ["使用 ChatGPT 登录", "使用 API 密钥", "切换账户 / 导入 auth.json"]);
  const entry = actions.querySelector("[data-codex-plus-signed-out-account]");
  assert.equal(entry.type, "button");
  assert.ok(entry.classList.contains("secondary"));
  assert.equal(dom.window.document.querySelectorAll("[data-codex-plus-signed-out-account]").length, 1);

  dom.window.__codexPlusAccounts.install();
  await flush();
  assert.equal(actions.querySelectorAll("[data-codex-plus-signed-out-account]").length, 1);

  entry.click();
  await flush();
  const modal = dom.window.document.getElementById("codex-plus-account-modal");
  assert.match(modal.querySelector(".cp-account-subtitle").textContent, /当前未登录/);
  assert.ok(modal.querySelector("[data-cp-add]"));
  assert.equal(modal.querySelector("[data-cp-web-login]"), null);
  assert.ok(modal.querySelector("[data-cp-switch]"));
  assert.deepEqual(calls.slice(0, 1), ["/accounts/list"]);
});

test("signed-out entry appears when React renders the login screen later", async () => {
  const dom = setupSignedOut(async () => ({ status: "ok", accounts: [] }), '<div id="root"></div>');
  await flush();
  assert.equal(dom.window.document.querySelector("[data-codex-plus-signed-out-account]"), null);
  const root = dom.window.document.getElementById("root");
  root.innerHTML = '<div><button>Sign in with ChatGPT</button></div>';
  await flush();
  const group = root.firstElementChild;
  assert.deepEqual([...group.children].map((node) => node.textContent.trim()), ["Sign in with ChatGPT", "切换账户 / 导入 auth.json"]);
});

test("logged-in profile menu modal still offers web login", async () => {
  const dom = setup(async () => ({ status: "ok", accounts: [] }));
  await flush();
  assert.equal(dom.window.document.querySelector("[data-codex-plus-signed-out-account]"), null);
  dom.window.document.querySelector("[data-codex-plus-account-item]").click();
  await flush();
  assert.ok(dom.window.document.querySelector("[data-cp-web-login]"));
  assert.match(dom.window.document.querySelector(".cp-account-subtitle").textContent, /切换 ChatGPT 账户/);
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
  assert.deepEqual(Array.from(list.request.params.modelProviders), []);
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
  assert.equal(dom.window.__codexPlusModelRouting.version, 23);
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
  routing.setNativeForkForTest(async (host, hostId, params) => {
    calls.push({ method: "native-fork", params });
    return { status: "created", conversationId: params.sourceConversationId === "existing" ? "api-child" : "gpt-child", synchronization: { status: "complete" } };
  });
  let prewarmClears = 0;
  const manager = { requestClient: client, forkConversationFromLatest() {}, setThreadTitle: async (id, title) => { calls.push({ method: "native-title", id, title }); }, clearPrewarmedThreads: () => { prewarmClears += 1; }, executeTurnStart: async (threadId, operation) => {
    assert.equal(operation.request.threadId, threadId);
    return client.sendRequest("turn/start", operation.request);
  } };
  assert.equal(routing.installConversationManagerForTest(manager), true);
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
  assert.deepEqual(Array.from(calls.find((call) => call.method === "thread/list").params.modelProviders), []);
  await manager.executeTurnStart("existing", { request: { threadId: "existing", model: "cp-route", input: [] } });
  assert.deepEqual(calls.slice(-5).map((call) => call.method), ["thread/read", "native-fork", "thread/read", "native-title", "turn/start"]);
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
  await manager.executeTurnStart("new-thread", { request: { threadId: "new-thread", model: null, input: [], collaborationMode: { mode: "default", settings: { model: "gpt-5", reasoning_effort: "high" } } } });
  assert.deepEqual(calls.slice(-5).map((call) => call.method), ["thread/read", "native-fork", "thread/read", "native-title", "turn/start"]);
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
  const manager = { requestClient: client, forkConversationFromLatest() {}, clearPrewarmedThreads() {}, executeTurnStart() { assert.fail("cancelled switch must not register a native turn"); } };
  routing.installConversationManagerForTest(manager);
  await assert.rejects(manager.executeTurnStart("api-thread", { request: { threadId: "api-thread", collaborationMode: { settings: { model: "gpt-5" } } } }), /已取消跨 provider 历史分支/);
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
  routing.setNativeForkForTest(async (host, hostId, params) => {
    calls.push({ method: "native-fork", params });
    return { status: "created", conversationId: "bad-child", synchronization: { status: "complete" } };
  });
  await client.sendRequest("list-models", {});
  await client.sendRequest("thread/start", { model: "cp-route" });
  const officialOption = dom.window.document.createElement("button");
  officialOption.setAttribute("role", "option");
  officialOption.setAttribute("data-value", "gpt-5");
  officialOption.textContent = "GPT-5";
  dom.window.document.body.append(officialOption);
  officialOption.click();
  const manager = { requestClient: client, forkConversationFromLatest() {}, clearPrewarmedThreads() {}, executeTurnStart() { assert.fail("unverified switch must not register a native turn"); } };
  routing.installConversationManagerForTest(manager);
  await assert.rejects(manager.executeTurnStart("api-thread", { request: { threadId: "api-thread", collaborationMode: { settings: { model: "gpt-5" } } } }), /provider 验证失败：codex-plus-api/);
  assert.equal(calls.some((call) => call.method === "turn/start"), false);
  assert.equal(routing.selectedModel(), "cp-route");
});

test("model-less turns preserve their thread settings despite global API or official selections", async (t) => {
  const dom = setup(async () => ({ status: "ok", models: [{ routeId: "cp-route", displayName: "API Alias" }] }));
  dom.reconfigure({ url: "https://codex.test" });
  t.after(() => dom.window.close());
  const routing = dom.window.__codexPlusModelRouting;
  await routing.loadCatalog(true);
  let confirmations = 0;
  dom.window.confirm = () => { confirmations += 1; return false; };
  const calls = [];
  const client = {
    requestPromises: new dom.window.Map(),
    async enqueueRequest(method, params) { calls.push({ method, params }); return {}; },
    sendRequest(method, params) { return this.enqueueRequest(method, params); },
  };
  routing.installRequestClientForTest(client);
  // A persisted route can belong to another conversation or a previous app run.
  dom.window.localStorage.setItem("codex-plus:selected-model", "cp-route");
  for (const params of [{ threadId: "official-thread" }, { thread_id: "api-thread", model: null, collaborationMode: null }]) {
    assert.equal(routing.routeParams("turn/start", params), params);
    await client.sendRequest("turn/start", params);
    assert.equal(calls.at(-1).params, params);
  }
  const official = dom.window.document.createElement("button");
  official.setAttribute("role", "option"); official.setAttribute("data-value", "gpt-5");
  dom.window.document.body.append(official); official.click();
  const params = { threadId: "api-thread" };
  await client.sendRequest("turn/start", params);
  assert.equal(calls.at(-1).params, params);
  // Even a route removed since the last selection cannot affect model-less sends.
  dom.window.localStorage.setItem("codex-plus:selected-model", "cp-deleted");
  await client.sendRequest("turn/start", { threadId: "official-thread" });
  assert.deepEqual(calls.map(call => call.method), ["turn/start", "turn/start", "turn/start", "turn/start"]);
  assert.equal(confirmations, 0);
});

test("native collaboration models override stale global and top-level models", async (t) => {
  const dom = setup(async () => ({ status: "ok", models: [{ routeId: "cp-route", displayName: "API Alias" }] }));
  dom.reconfigure({ url: "https://codex.test" });
  t.after(() => dom.window.close());
  const routing = dom.window.__codexPlusModelRouting;
  await routing.loadCatalog(true);
  routing.setSelectedModel("cp-route");
  dom.window.confirm = () => { assert.fail("same-provider turns must not fork"); };
  const calls = [];
  const client = {
    requestPromises: new dom.window.Map(),
    async enqueueRequest(method, params) {
      calls.push({ method, params });
      if (method === "thread/read") return { thread: { id: params.threadId, modelProvider: params.threadId === "official" ? "openai" : "codex-plus-api" } };
      return {};
    },
    sendRequest(method, params) { return this.enqueueRequest(method, params); },
  };
  routing.installRequestClientForTest(client);
  for (const [threadId, model, fallback] of [["official", "gpt-6.1-sol", "cp-route"], ["api", "cp-route", "gpt-6.1-sol"]]) {
    const collaborationMode = { mode: "default", settings: { model, reasoning_effort: "high", developer_instructions: null } };
    const params = { threadId, model: fallback, collaborationMode, input: [] };
    assert.equal(routing.routeParams("turn/start", params).model, model);
    await client.sendRequest("turn/start", params);
    assert.equal(calls.at(-1).params.model, model);
    assert.equal(calls.at(-1).params.collaborationMode, collaborationMode);
  }
  assert.deepEqual(calls.map(call => call.method), ["thread/read", "turn/start", "thread/read", "turn/start"]);
  assert.throws(() => routing.routeParams("turn/start", { collaborationMode: { settings: { model: "cp-deleted" } } }), /已删除/);
});

test("the model probe learns official labels without a matching Query cache or enqueue result", async (t) => {
  const dom = setup(async () => ({ status: "ok", models: [{ routeId: "cp-route", displayName: "API Alias" }] }));
  dom.reconfigure({ url: "https://codex.test" });
  t.after(() => dom.window.close());
  await flush();
  const routing = dom.window.__codexPlusModelRouting;
  routing.setSelectedModel("cp-route");
  const client = {
    hostId: "local", requestPromises: new dom.window.Map(),
    enqueueRequest() {},
    async sendRequest(method, params, options) {
      await this.enqueueRequest(method, params, options);
      return { data: [{ model: "gpt-6.1-sol", displayName: "GPT-6.1 Sol" }, { model: "cp-removed", displayName: "Removed API" }] };
    },
  };
  let clears = 0;
  const manager = { requestClient: client, clearPrewarmedThreads() { clears += 1; }, forkConversationFromLatest() {} };
  const queryClient = { getQueryCache: () => ({ getAll: () => [] }), setQueryData() { assert.fail("no model cache exists yet"); } };
  const scope = { node: { queryClient }, get: () => client };
  const root = dom.window.document.createElement("div"); root.id = "root";
  root.__reactContainer$probe = { memoizedProps: { value: scope }, memoizedState: { memoizedState: manager } };
  dom.window.document.body.append(root);
  await routing.install();
  assert.equal(routing.health().ready, true);
  assert.equal(routing.state.officialModels.has("gpt-6.1-sol"), true);
  assert.equal(routing.state.officialNames.get("GPT-6.1 Sol"), "gpt-6.1-sol");
  assert.equal(routing.state.officialModels.has("cp-removed"), false);
  const option = dom.window.document.createElement("button");
  option.setAttribute("role", "option"); option.textContent = "GPT-6.1 Sol High";
  dom.window.document.body.append(option); option.click();
  assert.equal(dom.window.localStorage.getItem("codex-plus:selected-model"), null);
  assert.equal(routing.selectedModel(), "gpt-6.1-sol");
  assert.equal(clears, 2);
});

test("discovers modern React scopes and clients without minified names", async () => {
  let catalog = [{ routeId: "cp-route", modelId: "upstream", displayName: "Before" }];
  const dom = setup(async () => ({ status: "ok", models: catalog }));
  await flush();
  const routing = dom.window.__codexPlusModelRouting;
  assert.equal(routing.health().ready, false);
  const queries = [{ queryKey: ["models", "list", "local"], state: { data: { data: [{ model: "gpt-test", displayName: "Native" }] } } }];
  const queryClient = {
    getQueryCache: () => ({ getAll: () => queries }),
    setQueryData: (key, update) => { queries[0].state.data = update(queries[0].state.data); },
  };
  const calls = [];
  const client = {
    hostId: "local", requestPromises: new dom.window.Map(),
    sendRequest(method, params, options) { return this.enqueueRequest(method, params, options); },
    async enqueueRequest(...args) { calls.push(args); return { data: [{ model: "gpt-test", displayName: "Native" }] }; },
  };
  let cleared = 0;
  const manager = { requestClient: client, clearPrewarmedThreads() { cleared += 1; }, forkConversationFromLatest() {} };
  const scope = { node: { queryClient }, get: () => client };
  const root = dom.window.document.createElement("div");
  root.id = "root";
  root.__reactContainer$modern = { memoizedState: { memoizedState: { current: scope }, next: { memoizedState: [manager, []] } } };
  dom.window.document.body.append(root);
  routing.install();
  await flush();
  assert.equal(routing.health().ready, true);
  assert.equal(routing.health().modelProbe, true);
  assert.equal(cleared, 1);
  assert.equal(calls[0][0], "model/list");
  assert.deepEqual(Array.from(queries[0].state.data.data, m => m.model), ["gpt-test", "cp-route"]);
  catalog = [{ ...catalog[0], displayName: "After" }];
  await routing.loadCatalog(true);
  assert.equal(queries[0].state.data.data[1].displayName, "After");
  catalog = [];
  await routing.loadCatalog(true);
  assert.deepEqual(Array.from(queries[0].state.data.data, m => m.model), ["gpt-test"]);
  await assert.rejects(client.sendRequest("thread/start", { model: "cp-route" }), /已删除/);
  const dispatch = () => {}, trace = {};
  await client.enqueueRequest("thread/start", { model: "gpt-test" }, {}, dispatch, trace);
  assert.equal(calls.at(-1)[3], dispatch);
  assert.equal(calls.at(-1)[4], trace);
  routing.install();
  await flush();
  assert.equal(cleared, 1);
  dom.window.close();
});

test("does not mutate unrelated HTTP response JSON", async () => {
  const dom = setup(async () => ({ status: "ok", models: [{ routeId: "cp-route" }] }));
  await dom.window.__codexPlusModelRouting.loadCatalog(true);
  assert.deepEqual(await new dom.window.Response().json(), {});
  dom.window.close();
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

test("fixed subscription API configures account order and model visibility without switching login", async () => {
  const a="a".repeat(64), b="b".repeat(64), calls=[];
  const models=[{modelId:"gpt-test",displayName:"My model",visible:true}];
  const fixed={id:"chatgpt-subscription",kind:"subscription",fixed:true,name:"ChatGPT 订阅",enabled:false,models};
  const dom=setup(async(path,payload)=>{
    calls.push({path,payload:JSON.parse(JSON.stringify(payload||{}))});
    if(path==="/api-providers/list")return {status:"ok",providers:[fixed]};
    if(path==="/api-providers/subscription/get")return {status:"ok",config:{enabled:false,accountOrder:[a,b],models,proxyUrl:""},accounts:[{recordId:a,email:"a@example.test"},{recordId:b,email:"b@example.test"}]};
    if(path==="/api-providers/subscription/save")return {status:"ok",config:payload};
    return {status:"ok",models:[]};
  });
  dom.window.__codexPlusApi.open();await flush();
  assert.equal(dom.window.document.querySelector('[data-api-delete="chatgpt-subscription"]'),null);
  dom.window.document.querySelector('[data-api-edit="chatgpt-subscription"]').click();await flush();
  assert.equal(dom.window.document.querySelector('input[name="apiKey"]'),null);
  assert.equal(dom.window.document.querySelector('input[name="baseUrl"]'),null);
  dom.window.document.querySelector('[data-model-name="0"]').value="Custom name";
  dom.window.document.querySelector('[data-sub-up="'+b+'"]').click();
  assert.equal(dom.window.document.querySelector('[data-model-name="0"]').value,"Custom name");
  const enabled=dom.window.document.querySelector('[data-sub-enabled]');enabled.checked=true;enabled.dispatchEvent(new dom.window.Event("change"));
  dom.window.document.querySelector('[data-sub-save]').click();await flush();
  const saved=calls.find(c=>c.path==="/api-providers/subscription/save").payload;
  assert.deepEqual(saved.accountOrder,[b,a]);assert.equal(saved.enabled,true);assert.equal(saved.models[0].displayName,"Custom name");
  assert.equal(calls.some(c=>c.path==="/accounts/switch"),false);
  assert.ok(dom.window.document.querySelector('[data-codex-plus-account-item]'));
  assert.match(dom.window.document.body.textContent,/订阅 API 已保存/);
  dom.window.close();
});

test("subscription account opt-out and failed saves preserve the complete API draft", async () => {
  const a="a".repeat(64),b="b".repeat(64);
  const fixed={id:"chatgpt-subscription",kind:"subscription",name:"ChatGPT 订阅",models:[],enabled:false};
  const dom=setup(async(path,payload)=>{
    if(path==="/api-providers/list")return {status:"ok",providers:[fixed]};
    if(path==="/api-providers/subscription/get")return {status:"ok",config:{enabled:false,accountOrder:[a,b],models:[],proxyUrl:""},accounts:[{recordId:a,email:"a@example.test"},{recordId:b,email:"b@example.test"}],blockedAccounts:[{recordId:a,blocked:true,reason:"凭据失效，请更新"}]};
    if(path==="/api-providers/subscription/discover"){assert.deepEqual(JSON.parse(JSON.stringify(payload.accountOrder)),[b]);return {status:"ok",models:[{modelId:"gpt-test",displayName:"gpt-test",visible:true}]};}
    if(path==="/api-providers/subscription/save")return {status:"failed",message:"账户不存在，请刷新"};
    return {status:"ok",models:[]};
  });
  dom.window.__codexPlusApi.open();await flush();dom.window.document.querySelector('[data-api-edit="chatgpt-subscription"]').click();await flush();
  assert.match(dom.window.document.body.textContent,/凭据失效/);
  const input=dom.window.document.querySelector('[data-sub-account="'+a+'"]');input.checked=false;input.dispatchEvent(new dom.window.Event("change"));
  const proxy=dom.window.document.querySelector('[data-sub-proxy]');proxy.value="http://127.0.0.1:7897";proxy.dispatchEvent(new dom.window.Event("input"));
  dom.window.document.querySelector('[data-sub-discover]').click();await flush();
  dom.window.document.querySelector('[data-sub-save]').click();await flush();
  assert.match(dom.window.document.body.textContent,/账户不存在/);assert.match(dom.window.document.body.textContent,/gpt-test/);
  assert.equal(dom.window.document.querySelector('[data-sub-proxy]').value,"http://127.0.0.1:7897");
  dom.window.close();
});

test("subscription controls survive the native input reset and labels enable discovery", async () => {
  const id = "a".repeat(64), calls = [];
  const dom = setup(async (path, payload) => {
    calls.push({path, payload});
    if (path === "/api-providers/list") return {status:"ok",providers:[{id:"chatgpt-subscription",kind:"subscription",name:"ChatGPT 订阅",models:[],enabled:false}]};
    if (path === "/api-providers/subscription/get") return {status:"ok",config:{enabled:false,accountOrder:[],models:[],proxyUrl:""},accounts:[{recordId:id,email:"a@example.test"}]};
    if (path === "/api-providers/subscription/discover") return {status:"ok",models:[{modelId:"gpt-test",displayName:"gpt-test",visible:true}]};
    if (path === "/api-providers/subscription/save") return {status:"ok",config:payload};
    return {status:"ok",models:[]};
  });
  const reset = dom.window.document.createElement("style");
  reset.textContent = 'input,textarea,select,optgroup { appearance:none; background-color:transparent; border-radius:0; }';
  dom.window.document.head.append(reset);
  dom.window.__codexPlusApi.open(); await flush();
  dom.window.document.querySelector('[data-api-edit="chatgpt-subscription"]').click(); await flush();
  const document = dom.window.document;
  assert.equal(document.querySelector('[data-sub-discover]').disabled, true);
  for (const input of document.querySelectorAll('.cp-api-dialog input[type="checkbox"]')) {
    const style = dom.window.getComputedStyle(input);
    assert.equal(style.appearance, "auto");
    assert.equal(style.width, "16px");
    assert.equal(style.height, "16px");
  }
  document.querySelector('[data-sub-enabled]').closest('label').click();
  document.querySelector('[data-sub-account]').closest('label').click();
  assert.equal(document.querySelector('[data-sub-enabled]').checked, true);
  assert.equal(document.querySelector('[data-sub-account]').checked, true);
  assert.equal(document.querySelector('[data-sub-discover]').disabled, false);
  document.querySelector('[data-sub-discover]').click(); await flush();
  assert.equal(dom.window.getComputedStyle(document.querySelector('[data-model-visible]')).appearance, "auto");
  document.querySelector('[data-sub-save]').click(); await flush();
  const saved = calls.find(c => c.path === '/api-providers/subscription/save').payload;
  assert.equal(saved.enabled, true);
  assert.deepEqual(saved.accountOrder, [id]);
  assert.equal(saved.models[0].visible, true);
  dom.window.close();
});

test("account pool uses its native compaction provider for thread starts and subsequent turns", async () => {
  const model={routeId:'cp-pool-test',modelId:'gpt-test',displayName:'账户池 · gpt-test',providerId:'chatgpt-subscription',nativeProviderId:'codex-plus-account-pool'};
  const dom=setup(async()=>({status:'ok',models:[model]}));
  const router=dom.window.__codexPlusModelRouting;
  await router.loadCatalog(true);
  router.setSelectedModel(model.routeId);
  assert.equal(router.state.selectedProvider,'codex-plus-account-pool');
  assert.equal(router.routeParams('thread/start',{model:model.routeId}).modelProvider,'codex-plus-account-pool');
  assert.equal(router.routeParams('turn/start',{model:model.routeId,modelProvider:'codex-plus-account-pool'}).model,model.routeId);
  assert.throws(()=>router.routeParams('turn/start',{model:model.routeId,modelProvider:'openai'}),/先完成 provider 切换/);
  dom.window.close();
});

test("native signed-out heading anchors the new Continue sign-in button", async () => {
  const dom=setupSignedOut(async()=>({status:"ok",accounts:[]}),'<main><h1>登录 ChatGPT</h1><div><button>继续登录</button></div><button>使用其他方式登录</button></main>');
  await flush();assert.equal(dom.window.document.querySelectorAll('[data-codex-plus-signed-out-account]').length,1);dom.window.close();
});

test("signed-out entry follows React text updates but ignores unrelated text churn", async () => {
  const dom=setupSignedOut(async()=>({status:"ok",accounts:[]}),'<main><h1>登录 ChatGPT</h1><div><button>Loading...</button></div></main><section><span>unrelated</span></section>');
  await flush();const button=dom.window.document.querySelector('button');button.firstChild.data='继续登录';await flush();
  assert.equal(dom.window.document.querySelectorAll('[data-codex-plus-signed-out-account]').length,1);
  let scans=0;const original=dom.window.document.querySelectorAll.bind(dom.window.document);dom.window.document.querySelectorAll=selector=>{if(selector==='button,[role="button"]')scans++;return original(selector);};
  for(let i=0;i<100;i++)dom.window.document.querySelector('section span').firstChild.data=String(i);
  await flush();assert.equal(scans,0);dom.window.close();
});
