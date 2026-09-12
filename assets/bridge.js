(() => {
  "use strict";
  const bindingName = "__CODEX_PLUS_BINDING_NAME__";
  const VERSION = 2;
  const DEFAULT_TIMEOUT_MS = 30000;

  // launcher 重新连接时会重新注入本脚本。上一轮连接里挂起的请求已经不可能再收到回包，
  // 必须在注入时立刻失败，否则页面会永远停在“正在读取本地账户…”。
  const previous = window.__codexPlusPending;
  if (previous && typeof previous.clear === "function") {
    for (const entry of Array.from(previous.values())) {
      try { entry.reject(new Error("codex-plus 桥已重新连接，请重试")); } catch (error) { /* 已结束的请求忽略 */ }
    }
    previous.clear();
  }

  const pending = new Map();
  let sequence = 0;
  window.__codexPlusBridgeVersion = VERSION;
  window.__codexPlusPending = pending;

  window.codexPlusInvoke = (path, payload = {}, options = {}) => new Promise((resolve, reject) => {
    const id = `${Date.now()}-${++sequence}-${Math.random().toString(16).slice(2)}`;
    const requested = Number(options?.timeoutMs);
    const limitMs = Number.isFinite(requested) && requested > 0 ? requested : DEFAULT_TIMEOUT_MS;
    // launcher 侧心跳失活检测最长需要约 45 秒，页面必须自己兜底失败，
    // 不能让 Promise 悬空导致账户弹窗卡在加载状态。
    const timer = setTimeout(() => {
      if (!pending.delete(id)) return;
      reject(new Error(`codex-plus 请求超时（${limitMs}ms）：${path}`));
    }, limitMs);
    pending.set(id, {
      resolve: (value) => { clearTimeout(timer); resolve(value); },
      reject: (error) => { clearTimeout(timer); reject(error); },
    });
    try {
      window[bindingName](JSON.stringify({ id, path, payload }));
    } catch (error) {
      pending.delete(id);
      clearTimeout(timer);
      reject(error);
    }
  });

  window.__codexPlusBridgeResolve = (id, value) => {
    const entry = pending.get(String(id));
    if (!entry) return false;
    pending.delete(String(id));
    entry.resolve(value);
    return true;
  };
})()
