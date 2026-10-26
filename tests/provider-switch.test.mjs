import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { JSDOM } from "jsdom";

const script = await readFile(new URL("../assets/model-routing.js", import.meta.url), "utf8");
const models = [
  { routeId: "cp-api-other", modelId: "other", nativeProviderId: "codex-plus-api" },
  { routeId: "cp-api", modelId: "external", nativeProviderId: "codex-plus-api" },
  { routeId: "cp-pool", modelId: "gpt-5", nativeProviderId: "codex-plus-account-pool" },
];
const provider = model => models.find(entry => entry.routeId === model)?.nativeProviderId || "openai";

async function fixture(sourceModel, targetModel, options = {}) {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { runScripts: "dangerously", url: "app://-/index.html" });
  dom.window.codexPlusInvoke = async () => ({ models });
  dom.window.confirm = () => options.confirm !== false;
  dom.window.eval(script);
  const routing = dom.window.__codexPlusModelRouting;
  await routing.loadCatalog(true);
  const calls = [], turns = new Map();
  const threads = new Map([["source", { id: "source", model: sourceModel, modelProvider: provider(sourceModel), status: { type: "idle" } }]]);
  const conversations = new Map([["source", { latestModel: sourceModel, previousTurnModel: sourceModel, latestReasoningEffort: "low" }]]);
  const client = {
    hostId: "local", requestPromises: new Map(),
    async enqueueRequest(method, params, requestOptions, dispatch, trace) {
      calls.push({ method, params, requestOptions, dispatch, trace });
      if (method === "thread/read") return { thread: { ...threads.get(params.threadId) } };
      if (method === "thread/settings/update") {
        threads.get(params.threadId).model = params.model;
        return {};
      }
      if (method === "turn/start") return { turn: { id: "turn", status: "inProgress" } };
      return {};
    },
    sendRequest(...args) { return this.enqueueRequest(...args); },
  };
  const manager = {
    requestClient: client, forkConversationFromLatest() {}, clearPrewarmedThreads() {},
    getConversation(threadId) { return conversations.get(threadId); },
    async updateThreadSettingsForNextTurn(threadId, settings) {
      await client.sendRequest("thread/settings/update", { threadId, ...settings });
      Object.assign(conversations.get(threadId), { latestModel: settings.model, latestReasoningEffort: settings.effort });
    },
    async executeTurnStart(threadId, operation, ...args) {
      assert.equal(threadId, operation.request.threadId);
      calls.push({ method: "native-register", threadId, operation, args });
      turns.set(threadId, "inProgress");
      await client.sendRequest("turn/start", operation.request, ...args);
      return "native-result";
    },
  };
  routing.installConversationManagerForTest(manager);
  routing.setNativeForkForTest(async (host, hostId, params) => {
    calls.push({ method: "native-fork", params, hostId });
    await options.forkWait;
    const childProvider = options.wrongProvider ? provider(sourceModel) : provider(targetModel);
    threads.set("child", { id: "child", model: targetModel, modelProvider: childProvider, status: { type: "idle" } });
    conversations.set("child", { latestModel: targetModel });
    return { status: "created", conversationId: "child", synchronization: { status: "complete" } };
  });
  return { dom, routing, manager, client, calls, turns, threads, conversations };
}

for (const [sourceModel, targetModel] of [["gpt-5", "cp-pool"], ["cp-pool", "gpt-5"], ["cp-api", "cp-pool"], ["cp-pool", "cp-api"]]) {
  test("registers the native turn on the destination before sending " + sourceModel + " -> " + targetModel, async () => {
    const context = await fixture(sourceModel, targetModel);
    const { dom, manager, calls, turns, threads, conversations } = context;
    try {
      await manager.updateThreadSettingsForNextTurn("source", { model: targetModel, effort: "high" });
      const persistedModelBeforeTurn = threads.get("source").model;
      assert.equal(conversations.get("source").latestModel, targetModel);
      const input = [{ type: "text", text: "continue" }], attachments = [{ id: "attachment" }];
      const dispatch = () => {}, requestOptions = { priority: "foreground" }, trace = { id: "trace" };
      const operation = { request: { threadId: "source", input, clientUserMessageId: "stable" }, context: { attachments } };
      assert.equal(await manager.executeTurnStart("source", operation, requestOptions, dispatch, trace), "native-result");
      const sent = calls.find(call => call.method === "turn/start");
      const registered = calls.find(call => call.method === "native-register");
      assert.equal(sent.params.threadId, "child");
      assert.equal(registered.threadId, "child");
      assert.equal(persistedModelBeforeTurn, sourceModel);
      assert.equal(sent.params.model, targetModel);
      assert.equal(sent.params.effort, "high");
      assert.equal(sent.params.input, input);
      assert.equal(sent.params.clientUserMessageId, "stable");
      assert.equal(registered.operation.context.attachments, attachments);
      assert.equal(sent.requestOptions, requestOptions);
      assert.equal(sent.dispatch, dispatch);
      assert.equal(sent.trace, trace);
      assert.equal(operation.request.threadId, "source");
      assert.equal(turns.has("source"), false);
      turns.set(sent.params.threadId, "completed");
      assert.equal(turns.get(registered.threadId), "completed");
      assert.equal(threads.get("source").model, sourceModel);
      assert.equal(conversations.get("source").latestModel, sourceModel);
      assert.equal(calls.filter(call => call.method === "native-fork").length, 1);
    } finally { dom.window.close(); }
  });
}

test("does not redirect a raw request after a source turn has already been registered", async () => {
  const { dom, client, calls } = await fixture("gpt-5", "cp-pool");
  try {
    await assert.rejects(client.sendRequest("turn/start", { threadId: "source", model: "cp-pool", input: [] }), /原生发送事务开始前/);
    assert.equal(calls.some(call => ["turn/start", "native-fork"].includes(call.method)), false);
  } finally { dom.window.close(); }
});

for (const options of [{ confirm: false }, { wrongProvider: true }]) {
  test("preserves the source and registers no pending turn when switching fails " + JSON.stringify(options), async () => {
    const { dom, manager, calls, turns, conversations, threads } = await fixture("cp-pool", "gpt-5", options);
    try {
      await manager.updateThreadSettingsForNextTurn("source", { model: "gpt-5", effort: "high" });
      await assert.rejects(manager.executeTurnStart("source", { request: { threadId: "source", input: [] } }), options.confirm === false ? /已取消/ : /provider 验证失败/);
      assert.equal(turns.size, 0);
      assert.equal(calls.some(call => call.method === "turn/start"), false);
      assert.equal(threads.get("source").model, "cp-pool");
      assert.equal(conversations.get("source").latestModel, "cp-pool");
      assert.equal(conversations.get("source").latestReasoningEffort, "low");
    } finally { dom.window.close(); }
  });
}

test("deduplicates provider transitions per conversation", async () => {
  let releaseFork;
  const forkWait = new Promise(resolve => { releaseFork = resolve; });
  const { dom, manager, calls } = await fixture("gpt-5", "cp-pool", { forkWait });
  try {
    const operation = { request: { threadId: "source", model: "cp-pool", input: [] } };
    const first = manager.executeTurnStart("source", operation);
    while (!calls.some(call => call.method === "native-fork")) await new Promise(resolve => setTimeout(resolve, 0));
    await assert.rejects(manager.executeTurnStart("source", operation), /正在切换/);
    releaseFork();
    await first;
    assert.equal(calls.filter(call => call.method === "native-fork").length, 1);
    assert.equal(calls.filter(call => call.method === "turn/start").length, 1);
  } finally { releaseFork(); dom.window.close(); }
});

test("same-provider model changes use the original conversation and never fork", async () => {
  const { dom, manager, calls, turns } = await fixture("cp-api", "cp-api-other");
  try {
    await manager.updateThreadSettingsForNextTurn("source", { model: "cp-api-other" });
    await manager.executeTurnStart("source", { request: { threadId: "source", model: "cp-api-other", input: [] } });
    assert.equal(calls.find(call => call.method === "turn/start").params.threadId, "source");
    assert.equal(turns.has("child"), false);
    assert.equal(calls.some(call => call.method === "native-fork"), false);
  } finally { dom.window.close(); }
});

test("staged settings and the global picker cannot redirect a different conversation", async () => {
  const { dom, manager, routing, calls, threads, conversations } = await fixture("gpt-5", "cp-pool");
  try {
    threads.set("other", { id: "other", model: "gpt-5", modelProvider: "openai", status: { type: "idle" } });
    conversations.set("other", { latestModel: "gpt-5" });
    await manager.updateThreadSettingsForNextTurn("source", { model: "cp-pool" });
    routing.setSelectedModel("cp-pool");
    const operation = { request: { threadId: "other", input: [] } };
    await manager.executeTurnStart("other", operation);
    assert.equal(calls.find(call => call.method === "native-register").operation, operation);
    assert.equal(calls.find(call => call.method === "turn/start").params.threadId, "other");
    assert.equal(calls.some(call => call.method === "native-fork"), false);
  } finally { dom.window.close(); }
});

test("an empty continuation retains its collaboration settings on the new conversation", async () => {
  const { dom, manager, calls } = await fixture("cp-pool", "cp-api");
  try {
    const collaborationMode = { mode: "default", settings: { model: "cp-api", reasoning_effort: "high", developer_instructions: "preserve" } };
    await manager.executeTurnStart("source", { request: { threadId: "source", model: null, input: [], collaborationMode, turnTrigger: "model_switch" } });
    const sent = calls.find(call => call.method === "turn/start");
    assert.equal(sent.params.collaborationMode, collaborationMode);
    assert.equal(sent.params.turnTrigger, "model_switch");
    assert.equal(sent.params.input.length, 0);
    assert.equal(sent.params.threadId, "child");
  } finally { dom.window.close(); }
});

test("an active source cannot create a branch or an optimistic native turn", async () => {
  const { dom, manager, threads, calls, turns } = await fixture("gpt-5", "cp-pool");
  try {
    threads.get("source").status = { type: "active" };
    await assert.rejects(manager.executeTurnStart("source", { request: { threadId: "source", model: "cp-pool", input: [] } }), /仍在运行/);
    assert.equal(turns.size, 0);
    assert.equal(calls.some(call => call.method === "native-fork"), false);
  } finally { dom.window.close(); }
});
