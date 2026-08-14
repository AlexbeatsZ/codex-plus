(() => {
  "use strict";

  const String = window.String;
  const functionToString = (() => {}).toString;
  const VERSION = 16;
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
    pendingOfficialModel: "",
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
  let appServerDispatch = null;
  let appServerHost = null;
  let queryClient = null;
  let installTimer = null;
  let pendingThreadNavigation = null;

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
    if (state.pendingOfficialModel) return state.pendingOfficialModel;
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
    state.pendingOfficialModel = "";
    state.selected = String(model || "");
    state.selectedProvider = state.selected ? PROVIDER : "openai";
    try {
      if (model) localStorage.setItem(SELECTED_KEY, model);
      else localStorage.removeItem(SELECTED_KEY);
    } catch {}
    if (previous !== state.selected) discardPrewarmedThreads("model-selection-changed");
  }

  function setSelectedOfficialModel(model) {
    const next = String(model || "");
    const previous = selectedModel();
    state.pendingOfficialModel = next;
    state.selected = "";
    state.selectedProvider = next ? "openai" : "";
    try { localStorage.removeItem(SELECTED_KEY); } catch {}
    if (previous !== next) discardPrewarmedThreads("model-selection-changed");
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
    if (method === "thread/list") return { ...params, modelProviders: null };
    if (method === "thread/start" || method === "thread/resume" || method === "thread/fork") {
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
    const model = String(fallbackModel || thread?.model || "");
    if (model && providerForModel(model) === provider && (fallbackModel || !threadModels.has(threadId))) threadModels.set(threadId, model);
  }

  function rememberThreadResult(method, params, result) {
    if (method === "thread/list" && Array.isArray(result?.data)) {
      for (const thread of result.data) rememberThread(thread);
      return;
    }
    if (["thread/start", "thread/read", "thread/resume", "thread/fork"].includes(method)) {
      rememberThread(result, String(params?.model || ""), String(params?.modelProvider || ""));
    }
  }

  function isIdleThread(thread) {
    const type = String(thread?.status?.type || thread?.status || "idle").toLowerCase();
    return ["idle", "notloaded", "not_loaded", "systemerror", "system_error", "failed"].includes(type);
  }

  function restoreSelection(model, provider) {
    if (provider === PROVIDER && model) setSelectedModel(model);
    else if (provider === "openai" && model) setSelectedOfficialModel(model);
    else setSelectedModel("");
  }

  function threadElement(threadId, hostId = "") {
    for (const element of document.querySelectorAll("[data-app-action-sidebar-thread-id]")) {
      const value = String(element.getAttribute("data-app-action-sidebar-thread-id") || "");
      if ((hostId && value === `${hostId}:${threadId}`) || (!hostId && value.endsWith(`:${threadId}`))) return element;
    }
    return null;
  }

  function threadUiInfo(threadId) {
    const element = threadElement(threadId);
    return {
      hostId: String(element?.getAttribute("data-app-action-sidebar-thread-host-id") || "local"),
      title: String(element?.getAttribute("data-app-action-sidebar-thread-title") || element?.textContent || "").trim(),
    };
  }

  function navigateToThread(threadId, hostId) {
    let attempts = 0;
    const navigate = () => {
      attempts += 1;
      const element = threadElement(threadId, hostId);
      if (element) {
        element.click();
        diagnostic("provider-fork-navigated", { threadId, hostId, attempts });
        return;
      }
      if (attempts < 40) window.setTimeout(navigate, 100);
      else diagnostic("provider-fork-navigation-failed", { threadId, hostId });
    };
    window.setTimeout(navigate, 0);
  }

  function providerLabel(provider) {
    return provider === PROVIDER ? "API 模型" : "GPT";
  }

  function confirmProviderFork(currentProvider, targetProvider) {
    return window.confirm(`当前 Codex 不能在同一个任务 ID 内从 ${providerLabel(currentProvider)} 切换到 ${providerLabel(targetProvider)}。\n\n继续会创建一个继承完整对话历史的新任务分支，把本条消息发送到新分支，并自动切换过去；原任务会保留。\n\n是否继续？`);
  }

  async function forkThreadWithClient(client, original, { threadId, currentModel, currentProvider, targetModel, targetProvider, idle = true, ask = true }) {
    if (!idle) throw new Error("任务仍在运行，不能切换 provider");
    if (!threadId) throw new Error("缺少任务 ID");
    if (currentProvider === targetProvider) return { status: "ok", inPlace: true };
    if (ask && !confirmProviderFork(currentProvider, targetProvider)) {
      restoreSelection(currentModel, currentProvider);
      diagnostic("provider-fork-cancelled", { currentProvider, targetProvider });
      throw new Error("已取消跨 provider 历史分支，消息未发送");
    }
    const ui = threadUiInfo(threadId);
    try {
      let childId = "";
      if (appServerDispatch) {
        childId = String(await appServerDispatch("fork-conversation-from-latest", {
          hostId: ui.hostId,
          conversationId: threadId,
          model: targetModel,
        }) || "");
      } else {
        const forked = await original.call(client, "thread/fork", { threadId, model: targetModel, modelProvider: targetProvider });
        childId = String(forked?.thread?.id || forked?.threadId || forked?.id || "");
      }
      if (!childId) throw new Error("fork 未返回新任务 ID");
      const read = await original.call(client, "thread/read", { threadId: childId, includeTurns: false });
      const verified = String(read?.thread?.modelProvider || read?.modelProvider || read?.model_provider || "");
      if (verified !== targetProvider) throw new Error(`provider 验证失败：${verified || "未返回 provider"}`);
      threadProviders.set(childId, targetProvider);
      threadModels.set(childId, targetModel);
      if (appServerDispatch && ui.title) {
        try { await appServerDispatch("set-thread-title", { hostId: ui.hostId, conversationId: childId, title: ui.title }); } catch {}
      }
      pendingThreadNavigation = appServerDispatch ? { threadId: childId, hostId: ui.hostId } : null;
      diagnostic("provider-fork-complete", { sourceThreadId: threadId, targetThreadId: childId, currentProvider, targetProvider });
      return { status: "ok", provider: targetProvider, threadId: childId };
    } catch (error) {
      restoreSelection(currentModel, currentProvider);
      diagnostic("provider-fork-failed", { currentProvider, targetProvider, message: String(error?.message || error) });
      throw new Error(`跨 provider 历史分支失败，原任务未改变，消息已阻止发送：${error?.message || error}`);
    }
  }

  async function prepareRequest(client, original, method, params = {}) {
    if (method !== "turn/start") return routeParams(method, params);
    const desiredModel = String(params.model || selectedModel() || "");
    const targetProvider = providerForModel(desiredModel);
    const threadId = String(params.threadId || params.thread_id || "");
    if (!desiredModel || !targetProvider || !threadId) return routeParams(method, params);
    // A turn request may already describe the newly selected provider. The
    // source thread is authoritative: its provider is fixed at creation time.
    let currentProvider = String(threadProviders.get(threadId) || "");
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
      const forked = await forkThreadWithClient(client, original, {
        threadId,
        currentModel: threadModels.get(threadId) || "",
        currentProvider,
        targetModel: desiredModel,
        targetProvider,
        idle: isIdleThread(thread),
      });
      const next = { ...params, model: desiredModel };
      if ("thread_id" in next && !("threadId" in next)) next.thread_id = forked.threadId;
      else next.threadId = forked.threadId;
      return next;
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
      if (["thread/start", "thread/resume", "thread/fork", "turn/start"].includes(normalizedMethod)) {
        diagnostic("app-server-request-routed", {
          method: normalizedMethod,
          model: String(nextParams?.model || ""),
          modelProvider: String(nextParams?.modelProvider || nextParams?.model_provider || ""),
          transport: "enqueueRequest",
        });
      }
      const result = await originalEnqueue.call(this, method, nextParams, options, dispatch, trace);
      if (normalizedMethod === "turn/start" && state.pendingOfficialModel && String(nextParams?.model || "") === state.pendingOfficialModel) {
        state.pendingOfficialModel = "";
        state.selectedProvider = "";
      }
      if (normalizedMethod === "turn/start" && pendingThreadNavigation) {
        const sentThreadId = String(nextParams?.threadId || nextParams?.thread_id || "");
        if (sentThreadId === pendingThreadNavigation.threadId) {
          const navigation = pendingThreadNavigation;
          pendingThreadNavigation = null;
          navigateToThread(navigation.threadId, navigation.hostId);
        }
      }
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
    appServerDispatch = dispatch;
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
      const forked = await originalSendMessageFromView({ type: "send-cli-request-for-host", method: "thread/fork", params: { threadId, model: targetModel, modelProvider: targetProvider } });
      const verified = String(forked?.thread?.modelProvider || forked?.modelProvider || forked?.model_provider || "");
      if (verified !== targetProvider) throw new Error(`provider 验证失败：${verified || "未返回 provider"}`);
      return { status: "ok", provider: targetProvider, threadId: String(forked?.thread?.id || forked?.threadId || forked?.id || "") };
    }
    if (!activeRequestClient) throw new Error("Codex app-server client 不可用");
    return forkThreadWithClient(activeRequestClient, clientOriginals.get(activeRequestClient), { threadId, currentModel, currentProvider, targetModel, targetProvider, idle, ask: false });
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
      else {
        const officialByLabel = state.officialNames.get(label) || [...state.officialNames].find(([name]) => label.startsWith(`${name} `))?.[1] || "";
        const official = state.officialModels.has(value) || /^(gpt-|codex-|o[1-9](?:-|$))/i.test(value) ? value : officialByLabel;
        if (official) setSelectedOfficialModel(official);
      }
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
    setAppDispatchForTest: (dispatch) => { appServerDispatch = dispatch; },
    state,
  };
  install();
})();
