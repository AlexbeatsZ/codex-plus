(() => {
  "use strict";
  window.__codexPlusContextUsage?.destroy?.();

  const ATTR = "data-codex-plus-context-usage";
  const LABEL = /^(?:Context window|背景信息窗口|上下文窗口|上下文視窗|背景資訊視窗)\s*[:：]?$/i;
  const panels = new Set();
  let queued = false;
  let timer = null;

  function identity(element) {
    const key = Object.getOwnPropertyNames(element).find((name) => name.startsWith("__reactFiber$"));
    let hostId = "local";
    for (let fiber = element[key], depth = 0; fiber && depth < 100; fiber = fiber.return, depth++) {
      const props = fiber.memoizedProps;
      if (!props || typeof props !== "object") continue;
      hostId = props.hostId || props.permissionsHostId || hostId;
      const threadId = props.conversationId || props.threadId;
      if (typeof threadId === "string" && threadId) return { threadId, hostId };
    }
    const match = location.pathname.match(/\/threads?\/([a-f0-9-]{36})(?:\/|$)/i);
    return match ? { threadId: match[1], hostId } : null;
  }

  function count(value) {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }

  function render(panel) {
    if (!panel.isConnected) { panels.delete(panel); return; }
    const ref = identity(panel);
    const info = ref && window.__codexPlusModelRouting?.tokenUsage?.(ref.threadId, ref.hostId);
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
      observer.disconnect();
      if (timer) clearInterval(timer);
      for (const block of document.querySelectorAll(`[${ATTR}]`)) block.remove();
      panels.clear();
    },
  };
  scan();
})();
