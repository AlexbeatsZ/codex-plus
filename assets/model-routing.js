(() => {
  "use strict";

  const String = window.String;
  const functionToString = (() => {}).toString;
  const VERSION = 23;
  const PROVIDER = "codex-plus-api";
  const POOL_PROVIDER = "codex-plus-account-pool";
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
    modelProbe: false,
    forkReady: false,
    clickListenerInstalled: false,
  };
  const clientOriginals = new WeakMap();
  const installedManagers = new WeakSet();
  const pendingModelChanges = new Map();
  const pendingProviderTurns = new Set();
  const threadProviders = new Map();
  const threadModels = new Map();
  let originalSendMessageFromView = null;
  let activeRequestClient = null;
  let activeConversationManager = null;
  let nativeFork = null;
  let appServerHost = null;
  let queryClient = null;
  let installTimer = null;
  let installing = null;
  const managersByHost = new Map();
  const clientsByHost = new Map();
  const installedHosts = new WeakSet();

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
    // Stored selections can outlive their catalog entry; validate only when routing.
    state.selectedProvider = state.selected ? state.byRoute.get(state.selected)?.nativeProviderId || PROVIDER : "openai";
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
      if (!id || /^cp-/.test(id) || state.byRoute.has(id)) continue;
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
    // Replace our descriptors so aliases, visibility and deletions reach cached lists.
    const official = array.filter((item) => !/^cp-/.test(String(item.model || item.id || "")));
    const native = new Map(array.map(item => [String(item.model || item.id || ""), item]));
    const api = state.catalog.map(model => {
      const original = native.get(model.routeId);
      if (model.nativeProviderId !== "openai" || !original) return descriptor(model);
      return { ...original, displayName: model.providerId === "chatgpt-subscription" ? model.displayName : `${model.providerName || "API"} · ${model.displayName}`, description: `${model.providerName || "API"} · ${model.modelId}` };
    });
    array.splice(0, array.length, ...official, ...api);
    return true;
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
    if (state.byRoute.has(id)) return state.byRoute.get(id).nativeProviderId || PROVIDER;
    if (/^cp-/.test(id)) throw new Error("该 API 模型已删除、隐藏或停用，请重新选择模型");
    if (state.officialModels.has(id) || /^(gpt-|codex-|o[1-9](?:-|$))/i.test(id)) return "openai";
    return "";
  }

  function turnModel(params) {
    // Native collaboration settings take precedence over the legacy model field.
    // A missing model inherits thread settings, never another composer's selection.
    return String(params.collaborationMode?.settings?.model || params.model || "");
  }

  function routeParams(method, params = {}) {
    if (method === "thread/list") return { ...params, modelProviders: [] };
    if (method === "thread/start" || method === "thread/resume" || method === "thread/fork") {
      const targetProvider = providerForModel(params.model);
      return targetProvider ? { ...params, modelProvider: targetProvider } : params;
    }
    if (method === "turn/start") {
      const desiredModel = turnModel(params);
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
    if ([PROVIDER, POOL_PROVIDER].includes(provider) && model) setSelectedModel(model);
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
    return provider === POOL_PROVIDER ? "订阅 API 模型" : provider === PROVIDER ? "API 模型" : "GPT";
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
      if (nativeFork && appServerHost) {
        const forked = await nativeFork(appServerHost, String(client.hostId || ui.hostId), {
          sourceConversationId: threadId,
          model: targetModel,
        });
        if (forked?.status !== "created" || forked?.synchronization?.status !== "complete") {
          throw new Error(forked?.synchronization?.message || forked?.reason || "原生任务分支未完成同步");
        }
        childId = String(forked.conversationId || "");
      } else {
        throw new Error("当前版本的原生历史分支接口尚未就绪");
      }
      if (!childId) throw new Error("fork 未返回新任务 ID");
      const read = await original.call(client, "thread/read", { threadId: childId, includeTurns: false });
      const verified = String(read?.thread?.modelProvider || read?.modelProvider || read?.model_provider || "");
      if (verified !== targetProvider) throw new Error(`provider 验证失败：${verified || "未返回 provider"}`);
      threadProviders.set(childId, targetProvider);
      threadModels.set(childId, targetModel);
      if (ui.title) {
        try { await managersByHost.get(String(client.hostId || ui.hostId))?.setThreadTitle?.(childId, ui.title); } catch {}
      }
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
    const desiredModel = turnModel(params);
    const targetProvider = providerForModel(desiredModel);
    const threadId = String(params.threadId || params.thread_id || "");
    if (!desiredModel || !targetProvider || !threadId) return routeParams(method, params);
    // A turn request may already describe the newly selected provider. The
    // source thread is authoritative: its provider is fixed at creation time.
    let currentProvider = String(threadProviders.get(threadId) || "");
    if (!currentProvider) {
      const read = await original.call(client, "thread/read", { threadId, includeTurns: false });
      rememberThread(read);
      currentProvider = String(read?.thread?.modelProvider || read?.thread?.model_provider || "");
    }
    if (!currentProvider) throw new Error("无法确认当前任务的 provider，消息未发送");
    if (currentProvider && currentProvider !== targetProvider) {
      throw new Error("跨 provider 切换必须在原生发送事务开始前完成，消息已阻止发送");
    }
    return { ...params, model: desiredModel };
  }

  function isRequestClient(value) {
    return !!value && typeof value.sendRequest === "function" && typeof value.enqueueRequest === "function" && typeof value.requestPromises?.get === "function" && typeof value.requestPromises?.set === "function";
  }

  function threadKey(client, threadId) {
    return `${String(client.hostId || "local")}:${threadId}`;
  }

  async function stageModelChange(client, original, params) {
    const model = turnModel(params);
    const threadId = String(params.threadId || "");
    if (!model || !threadId) return false;
    await loadCatalog(false);
    const targetProvider = providerForModel(model);
    if (!targetProvider) return false;
    const key = threadKey(client, threadId);
    const read = await original.call(client, "thread/read", { threadId, includeTurns: false });
    rememberThread(read);
    const currentProvider = String(read?.thread?.modelProvider || "");
    if (!currentProvider) throw new Error("无法确认当前任务的 provider，模型未切换");
    if (currentProvider === targetProvider) {
      pendingModelChanges.delete(key);
      return false;
    }
    if (pendingProviderTurns.has(key)) throw new Error("该任务正在切换 provider，请等待切换完成");
    const manager = managersByHost.get(String(client.hostId || "local"));
    if (typeof manager?.executeTurnStart !== "function") throw new Error("原生发送事务接口尚未就绪，模型未切换");
    const previous = pendingModelChanges.get(key);
    const conversation = manager.getConversation?.(threadId);
    const previousModel = previous?.previousModel || threadModels.get(threadId) || [conversation?.previousTurnModel, conversation?.latestModel].find(value => value && providerForModel(value) === currentProvider) || "";
    pendingModelChanges.set(key, { model, effort: params.effort, previousModel, previousEffort: previous?.previousEffort ?? conversation?.latestReasoningEffort });
    diagnostic("provider-model-change-staged", { threadId, currentProvider, targetProvider });
    return true;
  }

  async function executeManagedTurn(manager, original, threadId, operation, args) {
    await loadCatalog(false);
    const client = manager.requestClient;
    const key = threadKey(client, threadId);
    const staged = pendingModelChanges.get(key);
    const desiredModel = turnModel(operation?.request || {}) || staged?.model || "";
    const targetProvider = providerForModel(desiredModel);
    if (!desiredModel || !targetProvider) return original.call(manager, threadId, operation, ...args);
    const rawRequest = clientOriginals.get(client);
    const read = await rawRequest.call(client, "thread/read", { threadId, includeTurns: false });
    rememberThread(read);
    const currentProvider = String(read?.thread?.modelProvider || "");
    if (!currentProvider) throw new Error("无法确认当前任务的 provider，消息未发送");
    if (currentProvider === targetProvider) return original.call(manager, threadId, operation, ...args);
    if (pendingProviderTurns.has(key)) throw new Error("该任务正在切换 provider，请等待切换完成");
    if (!isIdleThread(read.thread)) throw new Error("任务仍在运行，不能切换 provider");
    pendingProviderTurns.add(key);
    const currentModel = staged?.previousModel || threadModels.get(threadId) || "";
    const restoreSource = async () => {
      if (staged && currentModel && typeof manager.updateThreadSettingsForNextTurn === "function") {
        await manager.updateThreadSettingsForNextTurn(threadId, { model: currentModel, ...(staged.previousEffort == null ? {} : { effort: staged.previousEffort }) });
      }
    };
    try {
      const forked = await forkThreadWithClient(client, rawRequest, {
        threadId, currentModel, currentProvider, targetModel: desiredModel, targetProvider, idle: true,
      });
      pendingModelChanges.delete(key);
      await restoreSource();
      const request = { ...operation.request, threadId: forked.threadId, model: desiredModel };
      if (request.effort === undefined && staged?.effort !== undefined) request.effort = staged.effort;
      const result = await original.call(manager, forked.threadId, { ...operation, request }, ...args);
      navigateToThread(forked.threadId, String(client.hostId || "local"));
      diagnostic("provider-turn-started", { sourceThreadId: threadId, targetThreadId: forked.threadId, targetProvider });
      return result;
    } catch (error) {
      pendingModelChanges.delete(key);
      restoreSelection(currentModel, currentProvider);
      try { await restoreSource(); } catch (restoreError) {
        diagnostic("provider-source-restore-failed", { threadId, message: String(restoreError?.message || restoreError) });
      }
      throw error;
    } finally {
      pendingProviderTurns.delete(key);
    }
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
      if (normalizedMethod === "thread/settings/update" && await stageModelChange(this, rawRequest, params || {})) return {};
      const nextParams = await prepareRequest(this, rawRequest, normalizedMethod, params || {});
      if (["thread/start", "thread/resume", "thread/fork", "turn/start"].includes(normalizedMethod)) {
        diagnostic("app-server-request-routed", {
          method: normalizedMethod,
          threadId: String(nextParams?.threadId || nextParams?.thread_id || ""),
          model: String(nextParams?.model || ""),
          modelProvider: String(nextParams?.modelProvider || nextParams?.model_provider || ""),
          transport: "enqueueRequest",
        });
      }
      const result = await originalEnqueue.call(this, method, nextParams, options, dispatch, trace);
      if (normalizedMethod === "turn/start" && state.pendingOfficialModel && turnModel(nextParams) === state.pendingOfficialModel) {
        state.pendingOfficialModel = "";
        state.selectedProvider = "";
      }
      rememberThreadResult(normalizedMethod, nextParams, result);
      if (normalizedMethod === "list-models" || normalizedMethod === "model/list") return patchModelResult(result);
      return result;
    };
    activeRequestClient = client;
    clientsByHost.set(String(client.hostId || "local"), client);
    state.requestClients += 1;
    diagnostic("app-server-client-installed", { count: state.requestClients });
    return true;
  }

  function installConversationManager(manager) {
    if (!manager || !isRequestClient(manager.requestClient) || typeof manager.clearPrewarmedThreads !== "function" || typeof manager.forkConversationFromLatest !== "function") return false;
    installRequestClient(manager.requestClient);
    if (installedManagers.has(manager)) return false;
    installedManagers.add(manager);
    activeConversationManager = manager;
    managersByHost.set(String(manager.hostId || manager.requestClient.hostId || "local"), manager);
    if (typeof manager.executeTurnStart === "function") {
      const original = manager.executeTurnStart;
      manager.executeTurnStart = function (threadId, operation, ...args) {
        return executeManagedTurn(this, original, threadId, operation, args);
      };
    }
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

  function discoverRuntime() {
    const root = reactRootFiber();
    if (!root) return false;
    const queue = [root];
    const seen = new Set();
    while (queue.length && seen.size < 100000) {
      const fiber = queue.pop();
      if (!fiber || seen.has(fiber)) continue;
      seen.add(fiber);
      inspectRuntimeValue(fiber.memoizedProps?.value);
      const hooks = new Set();
      for (let hook = fiber.memoizedState; hook && !hooks.has(hook) && hooks.size < 80; hook = hook.next) {
        hooks.add(hook);
        inspectRuntimeValue(hook.memoizedState);
        inspectRuntimeValue(hook.memoizedState?.current);
        if (Array.isArray(hook.memoizedState)) inspectRuntimeValue(hook.memoizedState[0]);
      }
      if (fiber.child) queue.push(fiber.child);
      if (fiber.sibling) queue.push(fiber.sibling);
    }
    activeRequestClient = clientsByHost.get("local") || activeRequestClient;
    activeConversationManager = managersByHost.get("local") || activeConversationManager;
    return !!activeRequestClient;
  }

  function inspectRuntimeValue(value) {
    if (!value || typeof value !== "object") return;
    installRequestClient(value);
    installConversationManager(value);
    const cache = value.node?.queryClient || value.queryClient;
    if (typeof value.get !== "function" || !cache?.getQueryCache || !cache?.setQueryData) return;
    if (!appServerHost) { appServerHost = value; queryClient = cache; }
    if (installedHosts.has(value)) return;
    installedHosts.add(value);
    const originalGet = value.get;
    value.get = function (...args) {
      const resolved = originalGet.apply(this, args);
      installRequestClient(resolved);
      installConversationManager(resolved);
      return resolved;
    };
  }

  async function resolveNativeFork() {
    if (nativeFork) return true;
    const urls = [...new Set([
      ...[...document.scripts].map((node) => node.src),
      ...[...document.querySelectorAll("link[href]")].map((node) => node.href),
      ...performance.getEntriesByType("resource").map((entry) => entry.name),
    ])];
    const url = urls.find((candidate) => candidate.includes("/assets/app-initial-"));
    if (!url) return false;
    const module = await import(url);
    // Match the native helper's contract, never its version-specific export alias.
    const candidates = Object.values(module).filter((value) => {
      if (typeof value !== "function") return false;
      try {
        const source = functionToString.call(value);
        return source.includes(".forkConversationFromLatest(") && source.includes(".forkConversationFromTurn(") && source.includes("readResumeInputs") && source.includes("sourceConversationId");
      } catch {
        return false;
      }
    });
    if (candidates.length !== 1) { diagnostic("native-fork-helper-not-found", { candidates: candidates.length }); return false; }
    nativeFork = candidates[0];
    state.forkReady = true;
    return true;
  }

  function health() {
    return { ready: state.loaded && state.modelProbe && clientsByHost.has("local") && managersByHost.has("local"), requestClients: state.requestClients, nativeModelQueries: state.nativeModelQueries, modelProbe: state.modelProbe, forkReady: state.forkReady };
  }

  function installAppServer() {
    if (installing) return installing;
    installing = (async () => {
      if (!discoverRuntime()) return false;
      try {
        await loadCatalog();
        if (!state.modelProbe) {
          const models = await activeRequestClient.sendRequest("model/list", { includeHidden: true, cursor: null, limit: 100 }, { priority: "background", timeoutMs: 8000 });
          if (!Array.isArray(models?.data)) throw new Error("model/list 返回格式不兼容");
          rememberOfficialModels(models.data);
          state.modelProbe = true;
          diagnostic("model-probe-succeeded", { count: models.data.length });
        }
        await resolveNativeFork();
        refreshNativeModelQueries();
      } catch (error) { diagnostic("app-server-prime-failed", { message: String(error?.message || error) }); }
      return health().ready;
    })().finally(() => { installing = null; });
    return installing;
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

  async function legacyThreads() {
    if (!activeRequestClient || String(activeRequestClient.hostId || "local") !== "local") throw new Error("请先打开本机任务，等待模型接口就绪");
    const raw = clientOriginals.get(activeRequestClient);
    const threads = [];
    let cursor = null;
    const seen = new Set();
    do {
      const page = await raw.call(activeRequestClient, "thread/list", { cursor, limit: 100, archived: false, modelProviders: [PROVIDER, POOL_PROVIDER], sourceKinds: ["vscode", "cli"], useStateDbOnly: true });
      threads.push(...(page.data || []));
      cursor = page.nextCursor;
      if (cursor && seen.has(cursor)) throw new Error("原生任务列表重复分页，请稍后再试");
      if (cursor) seen.add(cursor);
    } while (cursor && threads.length < 1000);
    return threads;
  }

  async function migrateLegacyThread(threadId, targetModel) {
    await loadCatalog(true);
    if (providerForModel(targetModel) !== "openai") throw new Error("原生手机路由尚未启用，请先启动新版 codex-plus");
    const client = activeRequestClient;
    if (!client || String(client.hostId || "local") !== "local") throw new Error("本机任务接口不可用");
    const raw = clientOriginals.get(client);
    const read = await raw.call(client, "thread/read", { threadId, includeTurns: false });
    const currentProvider = String(read?.thread?.modelProvider || "");
    if (![PROVIDER, POOL_PROVIDER].includes(currentProvider)) throw new Error("该任务已使用手机兼容的原生路由");
    const result = await forkThreadWithClient(client, raw, { threadId, currentModel: read.thread.model || "", currentProvider, targetModel, targetProvider: "openai", idle: isIdleThread(read.thread) });
    navigateToThread(result.threadId, "local");
    return result;
  }

  function install() {
    if (health().ready) return Promise.resolve(true);
    if (!state.clickListenerInstalled) {
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
      state.clickListenerInstalled = true;
    }
    return installAppServer().then((installed) => {
      if (!installed && document.getElementById("root") && !installTimer) {
        let attempts = 0;
        installTimer = setInterval(() => {
          attempts += 1;
          void installAppServer().then((ok) => { if (ok || attempts >= 40) { clearInterval(installTimer); installTimer = null; } });
        }, 250);
      }
      return installed;
    });
  }

  window.__codexPlusModelRouting = {
    version: VERSION,
    install,
    health,
    loadCatalog,
    patchModelResult,
    patchRoutingMessage,
    routeParams,
    selectedModel,
    setSelectedModel,
    experimentalSwitchThread,
    legacyThreads,
    migrateLegacyThread,
    installRequestClientForTest: installRequestClient,
    installConversationManagerForTest: installConversationManager,
    refreshNativeModelQueries,
    setTransportForTest: (send) => { originalSendMessageFromView = send; },
    setNativeForkForTest: (fork, host = {}) => { nativeFork = fork; appServerHost = host; },
    state,
    tokenUsage: (threadId, hostId = "local") => managersByHost.get(hostId)?.getConversation?.(threadId)?.latestTokenUsageInfo || null,
  };
  install();
})();
