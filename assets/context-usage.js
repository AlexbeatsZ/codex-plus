(() => {
  "use strict";
  window.__codexPlusContextUsage?.destroy?.();

  const ATTR = "data-codex-plus-context-usage";
  const LABEL = /^(?:Context window|背景信息窗口|上下文窗口|上下文視窗|背景資訊視窗)\s*[:：]?$/i;
  const panels = new Set();
  let destroyed = false;
  let queued = false;
  let timer = null;

  function isTokenUsage(value) {
    return value && typeof value === "object" && value.total && value.last
      && typeof value.total === "object" && typeof value.last === "object"
      && ("inputTokens" in value.total || "outputTokens" in value.total);
  }

  function nativeUsage(fiber) {
    const seen = new Set();
    for (let hook = fiber.memoizedState; hook && !seen.has(hook) && seen.size < 80; hook = hook.next) {
      seen.add(hook);
      if (!isTokenUsage(hook.memoizedState) && !isTokenUsage(hook.queue?.value)) continue;
      // useSyncExternalStore's shared queue reads the current subscription even
      // when the DOM's fiber pointer refers to the previous React alternate.
      try {
        const value = typeof hook.queue?.getSnapshot === "function"
          ? hook.queue.getSnapshot() : hook.memoizedState;
        return { found: true, info: isTokenUsage(value) ? value : null };
      } catch { return { found: true, info: null }; }
    }
    return { found: false, info: null };
  }

  function context(element) {
    const key = Object.getOwnPropertyNames(element).find((name) => name.startsWith("__reactFiber$"));
    let hostId = null;
    let threadId = null;
    let native = { found: false, info: null };
    for (let fiber = element[key], depth = 0; fiber && depth < 100; fiber = fiber.return, depth++) {
      const props = fiber.memoizedProps;
      if (!native.found) native = nativeUsage(fiber);
      if (!props || typeof props !== "object") continue;
      const host = props.hostId || props.permissionsHostId;
      if (!hostId && typeof host === "string" && host) hostId = host;
      const id = props.conversationId || props.threadId;
      if (typeof id === "string" && id) { threadId = id; break; }
    }
    threadId ||= location.pathname.match(/\/threads?\/([a-f0-9-]{36})(?:\/|$)/i)?.[1];
    const ref = threadId ? { threadId, hostId: hostId || "local" } : null;
    return {
      ref,
      info: ref ? (native.found ? native.info
        : window.__codexPlusModelRouting?.tokenUsage?.(ref.threadId, ref.hostId)) : null,
    };
  }

  function count(value) {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }

  function render(panel) {
    if (!panel.isConnected) { panels.delete(panel); return; }
    const { ref, info } = context(panel);
    let block = panel.querySelector(`[${ATTR}]`);
    if (!block) {
      block = document.createElement("div");
      block.setAttribute(ATTR, "");
      block.style.cssText = "margin-top:6px;padding-top:6px;border-top:1px solid currentColor;text-align:left;font:inherit;font-variant-numeric:tabular-nums;line-height:1.5";
      panel.append(block);
    }
    const zh = /zh/i.test(document.documentElement.lang || navigator.language) || /背景|上下文/.test(panel.firstElementChild?.textContent || "");
    const format = (n) => n == null ? "—" : n.toLocaleString(zh ? "zh-CN" : "en-US");
    const input = count(info?.total?.inputTokens);
    const cached = count(info?.total?.cachedInputTokens);
    const output = count(info?.total?.outputTokens);
    const reasoning = count(info?.total?.reasoningOutputTokens);
    const hit = input > 0 && cached != null && cached <= input ? `${(cached / input * 100).toFixed(1)}%` : "—";
    const lines = zh
      ? [["会话累计", ""], ["输入", format(input)], ["缓存输入", format(cached)], ["缓存命中", hit], ["输出", format(output)], ...(reasoning == null ? [] : [["其中推理", format(reasoning)]])]
      : [["Conversation total", ""], ["Input", format(input)], ["Cached input", format(cached)], ["Cache hit", hit], ["Output", format(output)], ...(reasoning == null ? [] : [["Reasoning", format(reasoning)]])];
    const signature = JSON.stringify([ref, lines]);
    if (block.dataset.signature === signature) return;
    block.dataset.signature = signature;
    block.replaceChildren(...lines.map(([label, value], index) => {
      const row = document.createElement("div");
      row.style.cssText = "display:flex;justify-content:space-between;gap:16px;white-space:nowrap";
      const name = document.createElement("span"); name.textContent = label;
      const number = document.createElement("span"); number.textContent = value;
      if (index === 0) { row.style.opacity = ".6"; row.style.marginBottom = "2px"; }
      row.append(name, number);
      return row;
    }));
    panel.style.minWidth = "220px";
  }

  function scan() {
    if (destroyed) return;
    queued = false;
    for (const tooltip of document.querySelectorAll('[role="tooltip"], [data-radix-popper-content-wrapper]')) {
      for (const label of tooltip.querySelectorAll("span")) {
        if (!LABEL.test(label.textContent.trim())) continue;
        const panel = label.parentElement;
        if (panel && panel.children.length >= 2) panels.add(panel);
      }
    }
    for (const panel of panels) render(panel);
    if (panels.size && !timer) timer = setInterval(() => {
      for (const panel of panels) render(panel);
      if (!panels.size) { clearInterval(timer); timer = null; }
    }, 750);
  }

  const observer = new MutationObserver((changes) => {
    if (queued || !changes.some((change) => [...change.addedNodes].some((node) => node.nodeType === 1 && !node.closest?.(`[${ATTR}]`)))) return;
    queued = true;
    queueMicrotask(scan);
  });
  observer.observe(document.body, { childList: true, subtree: true });
  window.__codexPlusContextUsage = {
    destroy() {
      destroyed = true;
      observer.disconnect();
      if (timer) clearInterval(timer);
      for (const block of document.querySelectorAll(`[${ATTR}]`)) block.remove();
      panels.clear();
    },
  };
  scan();
})();
