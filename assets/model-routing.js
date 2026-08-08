(() => {
  "use strict";

  const VERSION = 2;
  const PROVIDER = "codex-plus-api";
  const SELECTED_KEY = "codex-plus:selected-model";
  const state = { catalog: [], byRoute: new Map(), loaded: false, selected: "", selectedProvider: "", diagnostics: [] };
  let originalSendMessageFromView = null;

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

  async function loadCatalog(force = false) {
    if (state.loaded && !force) return state.catalog;
    const result = await invoke("/api-providers/catalog", {});
    state.catalog = Array.isArray(result?.models) ? result.models : [];
    state.byRoute = new Map(state.catalog.map((model) => [String(model.routeId || ""), model]));
    state.loaded = true;
    diagnostic("catalog-loaded", { count: state.catalog.length });
    return state.catalog;
  }

  function selectedModel() {
    try { return localStorage.getItem(SELECTED_KEY) || state.selected; } catch { return state.selected; }
  }

  function setSelectedModel(model) {
    state.selected = String(model || "");
    state.selectedProvider = state.selected ? PROVIDER : "openai";
    try {
      if (model) localStorage.setItem(SELECTED_KEY, model);
      else localStorage.removeItem(SELECTED_KEY);
    } catch {}
  }

  function descriptor(model) {
    const routeId = String(model.routeId || "");
    return {
      model: routeId,
      id: routeId,
      slug: routeId,
      name: model.displayName || routeId,
      displayName: model.displayName || routeId,
      description: `${model.providerName || "API"} · ${model.modelId || routeId}`,
      hidden: false,
      isDefault: false,
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: ["low", "medium", "high", "xhigh"].map((reasoningEffort) => ({ reasoningEffort, description: `${reasoningEffort} effort` })),
    };
  }

  function patchDescriptorArray(array, allowEmpty = false) {
    if (!Array.isArray(array) || !array.every((item) => item && typeof item === "object")) return false;
    const looksLikeModels = (allowEmpty && array.length === 0) || array.some((item) => typeof item.model === "string" || (typeof item.slug === "string" && Array.isArray(item.supportedReasoningEfforts)));
    if (!looksLikeModels) return false;
    const ids = new Set(array.flatMap((item) => [item.model, item.id, item.slug]).filter(Boolean).map(String));
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
    const candidates = [{ value: value.models, allowEmpty: true }, { value: value.data }, { value: value.result }, { value: value.result?.data }, { value: value.result?.models, allowEmpty: true }, { value: value.message?.result?.data }, { value: value.message?.result?.models, allowEmpty: true }];
    for (const candidate of candidates) {
      if (!patchDescriptorArray(candidate.value, candidate.allowEmpty)) patchStringArray(candidate.value);
    }
    return value;
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
    if (message.type === "send-cli-request-for-host") {
      if (message.method === "send-cli-request-for-host" && message.params?.params) return { params: message.params.params, wrap: (params) => ({ ...message, params: { ...message.params, params } }) };
      return { params: message.params || {}, wrap: (params) => ({ ...message, params }) };
    }
    if ((message.type === "mcp-request" || message.type === "worker-request") && message.request) return { params: message.request.params || {}, wrap: (params) => ({ ...message, request: { ...message.request, params } }) };
    return { params: message, wrap: (params) => params };
  }

  function patchRoutingMessage(message) {
    const method = methodOf(message);
    const target = paramsOf(message);
    if (!target) return message;
    if (method === "thread/list") {
      return target.wrap({ ...target.params, modelProviders: [] });
    }
    const selected = selectedModel();
    if (method === "thread/start") {
      if (state.byRoute.has(selected)) return target.wrap({ ...target.params, model: selected, modelProvider: PROVIDER });
      const requested = String(target.params?.model || "");
      if (state.byRoute.has(requested)) return target.wrap({ ...target.params, model: requested, modelProvider: PROVIDER });
      return target.wrap({ ...target.params, modelProvider: "openai" });
    }
    if (method === "turn/start" && state.byRoute.has(selected)) {
      const currentProvider = String(target.params?.modelProvider || target.params?.model_provider || "");
      if (!currentProvider || currentProvider === PROVIDER) return target.wrap({ ...target.params, model: selected });
      diagnostic("cross-provider-turn-blocked", { currentProvider, targetProvider: PROVIDER });
      throw new Error("当前任务需要先完成 provider 切换，消息已阻止发送");
    }
    if (method === "turn/start" && state.selectedProvider === "openai") {
      const currentProvider = String(target.params?.modelProvider || target.params?.model_provider || "");
      if (currentProvider === PROVIDER) {
        diagnostic("cross-provider-turn-blocked", { currentProvider, targetProvider: "openai" });
        throw new Error("当前任务需要先完成 provider 切换，消息已阻止发送");
      }
    }
    return message;
  }

  async function experimentalSwitchThread({ threadId, currentModel, currentProvider, targetModel, targetProvider, idle }) {
    if (!idle) throw new Error("任务仍在运行，不能切换 provider");
    if (!threadId) throw new Error("缺少任务 ID");
    if (currentProvider === targetProvider) { setSelectedModel(targetProvider === PROVIDER ? targetModel : ""); return { status: "ok", inPlace: true }; }
    const bridge = window.electronBridge;
    const send = originalSendMessageFromView || bridge?.sendMessageFromView?.bind?.(bridge);
    if (typeof send !== "function") throw new Error("Codex app-server bridge 不可用");
    await send({ type: "send-cli-request-for-host", method: "thread/shutdown", params: { threadId } });
    try {
      const resumed = await send({ type: "send-cli-request-for-host", method: "thread/resume", params: { threadId, model: targetModel, modelProvider: targetProvider } });
      const verified = String(resumed?.thread?.modelProvider || resumed?.modelProvider || resumed?.model_provider || "");
      if (verified && verified !== targetProvider) throw new Error(`provider 验证失败：${verified}`);
      setSelectedModel(targetProvider === PROVIDER ? targetModel : "");
      return { status: "ok", provider: targetProvider };
    } catch (error) {
      try { await send({ type: "send-cli-request-for-host", method: "thread/resume", params: { threadId, model: currentModel, modelProvider: currentProvider } }); } catch {}
      throw new Error(`provider 切换失败，已尝试恢复原任务：${error?.message || error}`);
    }
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
    const bridge = window.electronBridge;
    if (bridge && typeof bridge.sendMessageFromView === "function" && !originalSendMessageFromView) {
      originalSendMessageFromView = bridge.sendMessageFromView.bind(bridge);
      const patched = (message) => originalSendMessageFromView(patchRoutingMessage(message));
      try {
        bridge.sendMessageFromView = patched;
        if (bridge.sendMessageFromView !== patched) throw new Error("bridge method is read-only");
      } catch (error) {
        diagnostic("immutable-electron-bridge", { message: String(error?.message || error) });
      }
    }
    if (!window.__codexPlusDispatchEventPatch) {
      const originalDispatchEvent = window.dispatchEvent;
      window.dispatchEvent = function (event) {
        try {
          if (event?.type === "codex-message-from-view" && event.detail && typeof event.detail === "object") {
            const patched = patchRoutingMessage(event.detail);
            if (patched !== event.detail) {
              Object.keys(event.detail).forEach((key) => delete event.detail[key]);
              Object.assign(event.detail, patched);
            }
          }
        } catch (error) {
          diagnostic("dispatch-routing-failed", { message: String(error?.message || error) });
          throw error;
        }
        return originalDispatchEvent.call(this, event);
      };
      window.__codexPlusDispatchEventPatch = true;
    }
    document.addEventListener("click", (event) => {
      const option = event.target?.closest?.('[role="option"],[role="menuitemradio"],[data-value]');
      if (!option) return;
      const value = String(option.getAttribute("data-value") || option.textContent || "").trim();
      if (state.byRoute.has(value)) setSelectedModel(value);
      else if (/^(gpt-|codex-|o[1-9](?:-|$))/i.test(value)) setSelectedModel("");
    }, true);
    void loadCatalog().catch((error) => diagnostic("catalog-failed", { message: String(error?.message || error) }));
  }

  window.__codexPlusModelRouting = { version: VERSION, install, loadCatalog, patchModelResult, patchRoutingMessage, selectedModel, setSelectedModel, experimentalSwitchThread, setTransportForTest: (send) => { originalSendMessageFromView = send; }, state };
  install();
})();
