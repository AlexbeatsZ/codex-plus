(() => {
  "use strict";

  const String = window.String;
  const functionToString = (() => {}).toString;
  const VERSION = 13;
  const PROVIDER = "codex-plus-api";
  const SELECTED_KEY = "codex-plus:selected-model";
  const state = {
    catalog: [],
    byRoute: new Map(),
    officialModels: new Set(),
    officialNames: new Map(),
    loaded: false,
    selected: "",
    selectedProvider: "",
    diagnostics: [],
    requestClients: 0,
    nativeModelQueries: 0,
  };
  const clientOriginals = new WeakMap();
  const installedManagers = new WeakSet();
  const threadProviders = new Map();
  const threadModels = new Map();
  let originalSendMessageFromView = null;
  let activeRequestClient = null;
  let activeConversationManager = null;
  let appServerHost = null;
  let queryClient = null;
  let installTimer = null;

  if (window.__codexPlusModelRouting?.version === VERSION) {
    window.__codexPlusModelRouting.install();
    return;
  }

  function diagnostic(event, detail = {}) {
    state.diagnostics.push({ event, at: Date.now(), ...detail });
    if (state.diagnostics.length > 100) state.diagnostics.shift();
  }

  async function invoke(path, payload = {}) {
    if (typeof window.codexPlusInvoke !== "function") throw new Error("codex-plus bridge 尚未就绪");
    const result = await window.codexPlusInvoke(path, payload);
    if (["failed", "error"].includes(String(result?.status || "").toLowerCase())) throw new Error(result?.message || "操作失败");
    return result;
  }

  function cloneModelContainer(value) {
    if (Array.isArray(value)) return [...value];
    if (!value || typeof value !== "object") return value;
    const clone = { ...value };
    for (const key of ["data", "models", "result"]) {
      if (Array.isArray(clone[key])) clone[key] = [...clone[key]];
      else if (clone[key] && typeof clone[key] === "object") clone[key] = cloneModelContainer(clone[key]);
    }
    return clone;
  }

  function refreshNativeModelQueries() {
    if (!queryClient?.getQueryCache || !queryClient?.setQueryData) return 0;
    let count = 0;
    for (const query of queryClient.getQueryCache().getAll()) {
      const key = query?.queryKey;
      if (!Array.isArray(key) || key[0] !== "models" || key[1] !== "list") continue;
      queryClient.setQueryData(key, (current) => patchModelResult(cloneModelContainer(current)));
      count += 1;
    }
    state.nativeModelQueries = count;
    if (count) diagnostic("native-model-cache-refreshed", { count });
    return count;
  }

  async function loadCatalog(force = false) {
    if (state.loaded && !force) return state.catalog;
    const result = await invoke("/api-providers/catalog", {});
    state.catalog = Array.isArray(result?.models) ? result.models : [];
    state.byRoute = new Map(state.catalog.map((model) => [String(model.routeId || ""), model]));
    state.loaded = true;
    diagnostic("catalog-loaded", { count: state.catalog.length });
    refreshNativeModelQueries();
    return state.catalog;
  }

  function selectedModel() {
    try { return localStorage.getItem(SELECTED_KEY) || state.selected; } catch { return state.selected; }
  }

  function discardPrewarmedThreads(reason) {
    const manager = activeConversationManager;
    if (!manager) return false;
    try {
      if (typeof manager.clearPrewarmedThreads === "function") manager.clearPrewarmedThreads();
      else if (typeof manager.prewarmedThreadManager?.discardAllPrewarmedThreads === "function") manager.prewarmedThreadManager.discardAllPrewarmedThreads();
      else return false;
      diagnostic("prewarmed-threads-cleared", { reason });
      return true;
    } catch (error) {
      diagnostic("prewarmed-threads-clear-failed", { reason, message: String(error?.message || error) });
      return false;
    }
  }

  function setSelectedModel(model) {
    const previous = selectedModel();
    state.selected = String(model || "");
    state.selectedProvider = state.selected ? PROVIDER : "openai";
    try {
      if (model) localStorage.setItem(SELECTED_KEY, model);
      else localStorage.removeItem(SELECTED_KEY);
    } catch {}
    if (previous !== state.selected) discardPrewarmedThreads("model-selection-changed");
  }

  function descriptor(model) {
    const routeId = String(model.routeId || "");
    return {
      id: routeId,
      model: routeId,
      upgrade: null,
      upgradeInfo: null,
      availabilityNux: null,
      displayName: model.displayName || routeId,
      description: `${model.providerName || "API"} · ${model.modelId || routeId}`,
      hidden: false,
      supportedReasoningEfforts: ["low", "medium", "high", "xhigh"].map((reasoningEffort) => ({ reasoningEffort, description: `${reasoningEffort} effort` })),
      defaultReasoningEffort: "medium",
      inputModalities: ["text", "image"],
      supportsPersonality: false,
      additionalSpeedTiers: [],
      serviceTiers: [],
      defaultServiceTier: null,
      isDefault: false,
    };
  }

  function rememberOfficialModels(array) {
    if (!Array.isArray(array)) return;
    for (const item of array) {
      if (!item || typeof item !== "object") continue;
      const id = String(item.model || item.id || "");
      if (!id || state.byRoute.has(id)) continue;
      state.officialModels.add(id);
      const name = String(item.displayName || "").trim();
      if (name) state.officialNames.set(name, id);
    }
  }

  function patchDescriptorArray(array, allowEmpty = false) {
    if (!Array.isArray(array) || !array.every((item) => item && typeof item === "object")) return false;
    const looksLikeModels = (allowEmpty && array.length === 0) || array.some((item) => typeof item.model === "string" || (typeof item.id === "string" && Array.isArray(item.supportedReasoningEfforts)));
    if (!looksLikeModels) return false;
    rememberOfficialModels(array);
    const ids = new Set(array.flatMap((item) => [item.model, item.id]).filter(Boolean).map(String));
    let changed = false;
    for (const model of state.catalog) {
      if (!ids.has(String(model.routeId))) { array.push(descriptor(model)); changed = true; }
    }
    return changed;
  }

  function patchStringArray(array) {
    if (!Array.isArray(array) || !array.every((item) => typeof item === "string")) return false;
    let changed = false;
    for (const model of state.catalog) {
      if (!array.includes(model.routeId)) { array.push(model.routeId); changed = true; }
    }
    return changed;
  }

  function patchModelResult(value) {
    if (!value || typeof value !== "object") return value;
    const candidates = [
      { value: value.models, allowEmpty: true },
      { value: value.data },
      { value: value.result },
      { value: value.result?.data },
      { value: value.result?.models, allowEmpty: true },
      { value: value.message?.result?.data },
      { value: value.message?.result?.models, allowEmpty: true },
    ];
    for (const candidate of candidates) {
      if (!patchDescriptorArray(candidate.value, candidate.allowEmpty)) patchStringArray(candidate.value);
    }
    return value;
  }

  function providerForModel(model) {
    const id = String(model || "");
    if (!id) return "";
    if (state.byRoute.has(id)) return PROVIDER;
    if (state.officialModels.has(id) || /^(gpt-|codex-|o[1-9](?:-|$))/i.test(id)) return "openai";
    return "";
  }

  function routeParams(method, params = {}) {
    if (method === "thread/list") return { ...params, modelProviders: [] };
    if (method === "thread/start" || method === "thread/resume") {
      const targetProvider = providerForModel(params.model);
      return targetProvider ? { ...params, modelProvider: targetProvider } : params;
    }
    if (method === "turn/start") {
      const desiredModel = String(params.model || selectedModel() || "");
      if (!desiredModel) return params;
      const targetProvider = providerForModel(desiredModel);
      const currentProvider = String(params.modelProvider || params.model_provider || "");
      if (currentProvider && targetProvider && currentProvider !== targetProvider) {
        diagnostic("cross-provider-turn-blocked", { currentProvider, targetProvider });
        throw new Error("当前任务需要先完成 provider 切换，消息已阻止发送");
      }
      return targetProvider ? { ...params, model: desiredModel } : params;
    }
    return params;
  }

  function methodOf(message) {
    if (!message || typeof message !== "object") return "";
    if (message.type === "fetch" && typeof message.url === "string") return message.url.match(/vscode:\/\/codex\/([^?#]+)/)?.[1] || "";
    if (message.type === "send-cli-request-for-host") return String(message.method || message.params?.method || "");
    if ((message.type === "mcp-request" || message.type === "worker-request") && message.request) return String(message.request.method || "");
    return String(message.type || "");
  }

  function paramsOf(message) {
    if (message.type === "fetch") {
      if (typeof message.body === "string") { try { return { params: JSON.parse(message.body), wrap: (params) => ({ ...message, body: JSON.stringify(params) }) }; } catch { return null; } }
      if (message.body && typeof message.body === "object") return { params: message.body, wrap: (params) => ({ ...message, body: params }) };
    }
    if (message.type === "send-cli-request-for-host") return { params: message.params || {}, wrap: (params) => ({ ...message, params }) };
    if ((message.type === "mcp-request" || message.type === "worker-request") && message.request) return { params: message.request.params || {}, wrap: (params) => ({ ...message, request: { ...message.request, params } }) };
    return { params: message, wrap: (params) => params };
  }

  function patchRoutingMessage(message) {
    const target = paramsOf(message);
    if (!target) return message;
    return target.wrap(routeParams(methodOf(message), target.params));
  }

  function rememberThread(value, fallbackModel = "", fallbackProvider = "") {
    const thread = value?.thread || value;
    const threadId = String(thread?.id || thread?.threadId || "");
    if (!threadId) return;
    const provider = String(thread?.modelProvider || thread?.model_provider || fallbackProvider || "");
    if (provider) threadProviders.set(threadId, provider);
    if (fallbackModel) threadModels.set(threadId, fallbackModel);
  }

  function rememberThreadResult(method, params, result) {
    if (method === "thread/list" && Array.isArray(result?.data)) {
      for (const thread of result.data) rememberThread(thread);
      return;
    }
    if (["thread/start", "thread/read", "thread/resume"].includes(method)) {
      rememberThread(result, String(params?.model || ""), String(params?.modelProvider || ""));
    }
  }

  function isIdleThread(thread) {
    const type = String(thread?.status?.type || thread?.status || "idle").toLowerCase();
    return type === "idle" || type === "notloaded" || type === "not_loaded";
  }

  async function switchThreadWithClient(client, original, { threadId, currentModel, currentProvider, targetModel, targetProvider, idle = true }) {
    if (!idle) throw new Error("任务仍在运行，不能切换 provider");
    if (!threadId) throw new Error("缺少任务 ID");
    if (currentProvider === targetProvider) return { status: "ok", inPlace: true };
    await original.call(client, "thread/shutdown", { threadId });
    try {
      const resumed = await original.call(client, "thread/resume", { threadId, model: targetModel, modelProvider: targetProvider });
      const verified = String(resumed?.thread?.modelProvider || resumed?.modelProvider || resumed?.model_provider || "");
      if (verified !== targetProvider) throw new Error(`provider 验证失败：${verified || "未返回 provider"}`);
      threadProviders.set(threadId, targetProvider);
      threadModels.set(threadId, targetModel);
      setSelectedModel(targetProvider === PROVIDER ? targetModel : "");
      diagnostic("provider-switch-complete", { currentProvider, targetProvider });
      return { status: "ok", provider: targetProvider };
    } catch (error) {
      const rollback = { threadId, modelProvider: currentProvider };
      if (currentModel) rollback.model = currentModel;
      try { await original.call(client, "thread/resume", rollback); } catch {}
      diagnostic("provider-switch-rollback", { currentProvider, targetProvider });
      throw new Error(`provider 切换失败，已尝试恢复原任务：${error?.message || error}`);
    }
  }

  async function prepareRequest(client, original, method, params = {}) {
    if (method !== "turn/start") return routeParams(method, params);
    const desiredModel = String(params.model || selectedModel() || "");
    const targetProvider = providerForModel(desiredModel);
    const threadId = String(params.threadId || params.thread_id || "");
    if (!desiredModel || !targetProvider || !threadId) return routeParams(method, params);
    let currentProvider = String(params.modelProvider || params.model_provider || threadProviders.get(threadId) || "");
    let thread = null;
    if (!currentProvider) {
      const read = await original.call(client, "thread/read", { threadId, includeTurns: false });
      thread = read?.thread || null;
      rememberThread(read);
      currentProvider = String(thread?.modelProvider || thread?.model_provider || "");
    }
    if (currentProvider && currentProvider !== targetProvider) {
      if (!thread) {
        const read = await original.call(client, "thread/read", { threadId, includeTurns: false });
        thread = read?.thread || null;
        rememberThread(read);
      }
      await switchThreadWithClient(client, original, {
        threadId,
        currentModel: threadModels.get(threadId) || "",
        currentProvider,
        targetModel: desiredModel,
        targetProvider,
        idle: isIdleThread(thread),
      });
    }
    return { ...params, model: desiredModel };
  }

  function isRequestClient(value) {
    return !!value && typeof value.sendRequest === "function" && typeof value.enqueueRequest === "function" && typeof value.requestPromises?.get === "function" && typeof value.requestPromises?.set === "function";
  }

  function installRequestClient(client) {
    if (!isRequestClient(client) || clientOriginals.has(client)) return false;
    const originalEnqueue = client.enqueueRequest;
    const rawRequest = function (method, params, options) {
      return originalEnqueue.call(this, method, params, options);
    };
    clientOriginals.set(client, rawRequest);
    client.enqueueRequest = async function (method, params, options, dispatch, trace) {
      const normalizedMethod = String(method || "");
      const nextParams = await prepareRequest(this, rawRequest, normalizedMethod, params || {});
      if (["thread/start", "thread/resume", "turn/start"].includes(normalizedMethod)) {
        diagnostic("app-server-request-routed", {
          method: normalizedMethod,
          model: String(nextParams?.model || ""),
          modelProvider: String(nextParams?.modelProvider || nextParams?.model_provider || ""),
          transport: "enqueueRequest",
        });
      }
      const result = await originalEnqueue.call(this, method, nextParams, options, dispatch, trace);
      rememberThreadResult(normalizedMethod, nextParams, result);
      if (normalizedMethod === "list-models" || normalizedMethod === "model/list") return patchModelResult(result);
      return result;
    };
    activeRequestClient = client;
    state.requestClients += 1;
    diagnostic("app-server-client-installed", { count: state.requestClients });
    return true;
  }

  function installConversationManager(manager) {
    if (!manager || !isRequestClient(manager.requestClient)) return false;
    installRequestClient(manager.requestClient);
    if (installedManagers.has(manager)) return false;
    installedManagers.add(manager);
    activeConversationManager = manager;
    discardPrewarmedThreads("routing-installed");
    diagnostic("conversation-manager-installed");
    return true;
  }

  function reactRootFiber() {
    const roots = [document.getElementById("root"), document.body?.firstElementChild].filter(Boolean);
    for (const element of roots) {
      const key = Object.getOwnPropertyNames(element).find((name) => name.startsWith("__reactContainer$"));
      if (key) return element[key]?.stateNode?.current || element[key];
    }
    return null;
  }

  function findAppServerHost() {
    const root = reactRootFiber();
    if (!root) return null;
    const queue = [root];
    const seen = new Set();
    while (queue.length && seen.size < 100000) {
      const fiber = queue.shift();
      if (!fiber || seen.has(fiber)) continue;
      seen.add(fiber);
      let source = "";
      try { source = String(fiber.type || ""); } catch {}
      if (source.includes("setMessageHandler")) {
        const host = fiber.memoizedState?.memoizedState?.current;
        if (host && typeof host.get === "function" && host.node?.queryClient) return host;
      }
      if (fiber.child) queue.push(fiber.child);
      if (fiber.sibling) queue.push(fiber.sibling);
    }
    return null;
  }

  async function primeRequestClient() {
    const urls = [...new Set([
      ...[...document.scripts].map((node) => node.src),
      ...[...document.querySelectorAll("link[href]")].map((node) => node.href),
      ...performance.getEntriesByType("resource").map((entry) => entry.name),
    ])];
    const url = urls.find((candidate) => candidate.includes("/assets/app-initial-"));
    if (!url) return false;
    const module = await import(url);
    const dispatch = typeof module.Txt === "function" ? module.Txt : Object.values(module).find((value) => {
      if (typeof value !== "function") return false;
      try {
        const source = functionToString.call(value);
        return source.includes("sendRequest(e,t)") && source.includes("sendRequest(e,t,n)");
      } catch {
        return false;
      }
    });
    if (!dispatch) { diagnostic("app-server-dispatch-not-found"); return false; }
    await dispatch("list-models-for-host", { hostId: "local", includeHidden: true, cursor: null, limit: 100 });
    return true;
  }

  async function installAppServer() {
    if (!appServerHost) appServerHost = findAppServerHost();
    if (!appServerHost) return false;
    queryClient = appServerHost.node?.queryClient || appServerHost.queryClient || null;
    const originalGet = appServerHost.__codexPlusOriginalGet || appServerHost.get;
    if (!appServerHost.__codexPlusOriginalGet) {
      Object.defineProperty(appServerHost, "__codexPlusOriginalGet", { value: originalGet, configurable: true });
    }
    appServerHost.get = function (...args) {
      const value = originalGet.apply(this, args);
      installRequestClient(value);
      installConversationManager(value);
      return value;
    };
    try { await primeRequestClient(); } catch (error) { diagnostic("app-server-prime-failed", { message: String(error?.message || error) }); }
    if (!state.loaded || state.catalog.length === 0) {
      try { await loadCatalog(true); } catch (error) { diagnostic("catalog-retry-failed", { message: String(error?.message || error) }); }
    }
    refreshNativeModelQueries();
    diagnostic("app-server-routing-installed", { requestClients: state.requestClients, nativeModelQueries: state.nativeModelQueries });
    return state.requestClients > 0;
  }

  async function experimentalSwitchThread({ threadId, currentModel, currentProvider, targetModel, targetProvider, idle }) {
    if (!idle) throw new Error("任务仍在运行，不能切换 provider");
    if (originalSendMessageFromView) {
      await originalSendMessageFromView({ type: "send-cli-request-for-host", method: "thread/shutdown", params: { threadId } });
      try {
        const resumed = await originalSendMessageFromView({ type: "send-cli-request-for-host", method: "thread/resume", params: { threadId, model: targetModel, modelProvider: targetProvider } });
        const verified = String(resumed?.thread?.modelProvider || resumed?.modelProvider || resumed?.model_provider || "");
        if (verified !== targetProvider) throw new Error(`provider 验证失败：${verified || "未返回 provider"}`);
        setSelectedModel(targetProvider === PROVIDER ? targetModel : "");
        return { status: "ok", provider: targetProvider };
      } catch (error) {
        try { await originalSendMessageFromView({ type: "send-cli-request-for-host", method: "thread/resume", params: { threadId, model: currentModel, modelProvider: currentProvider } }); } catch {}
        throw new Error(`provider 切换失败，已尝试恢复原任务：${error?.message || error}`);
      }
    }
    if (!activeRequestClient) throw new Error("Codex app-server client 不可用");
    return switchThreadWithClient(activeRequestClient, clientOriginals.get(activeRequestClient), { threadId, currentModel, currentProvider, targetModel, targetProvider, idle });
  }

  function install() {
    if (window.__codexPlusResponsePatch !== VERSION) {
      const original = Response.prototype.json;
      Response.prototype.json = async function (...args) {
        const result = await original.apply(this, args);
        if (!state.loaded) { try { await loadCatalog(); } catch {} }
        return patchModelResult(result);
      };
      window.__codexPlusResponsePatch = VERSION;
    }
    document.addEventListener("click", (event) => {
      const option = event.target?.closest?.('[role="option"],[role="menuitemradio"],[data-value]');
      if (!option) return;
      const value = String(option.getAttribute("data-value") || "").trim();
      const label = String(option.textContent || "").replace(/\s+/g, " ").trim();
      const api = state.catalog.find((model) => value === model.routeId || label === String(model.displayName || "").trim() || label.startsWith(`${String(model.displayName || "").trim()} `));
      if (api) setSelectedModel(api.routeId);
      else if (state.officialModels.has(value) || state.officialNames.has(label) || /^(gpt-|codex-|o[1-9](?:-|$))/i.test(value)) setSelectedModel("");
    }, true);
    void loadCatalog().catch((error) => diagnostic("catalog-failed", { message: String(error?.message || error) }));
    void installAppServer().then((installed) => {
      if (!installed && document.getElementById("root") && !installTimer) {
        let attempts = 0;
        installTimer = setInterval(() => {
          attempts += 1;
          void installAppServer().then((ok) => { if (ok || attempts >= 40) { clearInterval(installTimer); installTimer = null; } });
        }, 250);
      }
    });
  }

  window.__codexPlusModelRouting = {
    version: VERSION,
    install,
    loadCatalog,
    patchModelResult,
    patchRoutingMessage,
    routeParams,
    selectedModel,
    setSelectedModel,
    experimentalSwitchThread,
    installRequestClientForTest: installRequestClient,
    installConversationManagerForTest: installConversationManager,
    refreshNativeModelQueries,
    setTransportForTest: (send) => { originalSendMessageFromView = send; },
    state,
  };
  install();
})();
