(() => {
  "use strict";

  const VERSION = 3;
  const ROOT_ID = "codex-plus-account-modal";
  const STYLE_ID = "codex-plus-account-style";
  const ITEM_ATTR = "data-codex-plus-account-item";

  if (window.__codexPlusAccounts?.version === VERSION) {
    window.__codexPlusAccounts.install();
    return;
  }
  window.__codexPlusAccounts?.destroy?.();

  const state = {
    observer: null,
    scanQueued: false,
    modal: null,
    opener: null,
    view: "accounts",
    accounts: [],
    usage: new Map(),
    loading: false,
    switching: "",
    message: "",
    messageType: "",
    draft: "",
    sourceName: "",
    importing: false,
  };

  function svgIcon() {
    return `<svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M22 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path></svg>`;
  }

  function installStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      .codex-plus-account-menu-item .cp-menu-row { display:flex!important; width:100%!important; min-width:0; flex-direction:row!important; align-items:center!important; justify-content:flex-start!important; gap:6px!important; white-space:nowrap!important; }
      .codex-plus-account-menu-item .cp-menu-row svg { flex:0 0 auto; width:20px; height:20px; opacity:.75; }
      .codex-plus-account-menu-item .cp-menu-label { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .cp-account-overlay { position:fixed; inset:0; z-index:2147483000; display:grid; place-items:center; padding:20px; background:rgba(0,0,0,.58); backdrop-filter:blur(3px); }
      .cp-account-dialog { width:min(680px,calc(100vw - 28px)); max-height:min(720px,calc(100vh - 28px)); display:flex; flex-direction:column; overflow:hidden; border:1px solid rgba(255,255,255,.13); border-radius:14px; color:#f4f4f5; background:#18181b; box-shadow:0 24px 80px rgba(0,0,0,.45); font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif; }
      .cp-account-header { display:flex; align-items:flex-start; justify-content:space-between; gap:16px; padding:18px 20px 14px; }
      .cp-account-title { margin:0; font-size:18px; line-height:1.3; font-weight:650; }
      .cp-account-subtitle { margin:4px 0 0; color:#a1a1aa; font-size:12px; }
      .cp-account-close { width:30px; height:30px; border:0; border-radius:8px; color:#a1a1aa; background:transparent; cursor:pointer; font-size:22px; line-height:1; }
      .cp-account-close:hover { color:#fff; background:rgba(255,255,255,.08); }
      .cp-account-body { min-height:260px; padding:16px 20px 20px; overflow:auto; }
      .cp-account-status { margin-bottom:12px; border:1px solid rgba(255,255,255,.12); border-radius:9px; padding:9px 11px; color:#d4d4d8; font-size:12px; }
      .cp-account-status[data-type="error"] { border-color:rgba(248,113,113,.4); color:#fca5a5; }
      .cp-account-status[data-type="success"] { border-color:rgba(52,211,153,.4); color:#6ee7b7; }
      .cp-account-empty { display:grid; place-items:center; min-height:190px; color:#a1a1aa; font-size:13px; text-align:center; }
      .cp-account-list { display:grid; gap:9px; }
      .cp-account-list-actions { display:flex; justify-content:flex-end; margin-top:14px; padding-top:14px; border-top:1px solid rgba(255,255,255,.1); }
      .cp-account-row { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:14px; align-items:center; border:1px solid rgba(255,255,255,.11); border-radius:11px; padding:13px 14px; background:rgba(255,255,255,.025); }
      .cp-account-row[data-active="true"] { border-color:rgba(16,163,127,.55); background:rgba(16,163,127,.08); }
      .cp-account-main { min-width:0; }
      .cp-account-name-line { display:flex; flex-wrap:wrap; align-items:center; gap:7px; min-width:0; }
      .cp-account-name { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:14px; font-weight:650; }
      .cp-account-badge { border-radius:999px; padding:2px 7px; color:#6ee7b7; background:rgba(16,163,127,.18); font-size:11px; font-weight:600; }
      .cp-account-meta { display:flex; flex-wrap:wrap; gap:5px 10px; margin-top:4px; color:#a1a1aa; font-size:12px; }
      .cp-account-usage { display:grid; gap:7px; margin-top:10px; }
      .cp-usage-window { display:grid; grid-template-columns:auto minmax(90px,1fr) auto; align-items:center; gap:8px; color:#d4d4d8; font-size:11px; }
      .cp-usage-track { height:5px; overflow:hidden; border-radius:999px; background:rgba(255,255,255,.1); }
      .cp-usage-fill { height:100%; border-radius:inherit; background:#10a37f; }
      .cp-usage-reset { color:#a1a1aa; white-space:nowrap; }
      .cp-usage-loading { color:#a1a1aa; font-size:12px; }
      .cp-account-button { min-width:72px; border:1px solid rgba(255,255,255,.18); border-radius:8px; padding:7px 11px; color:#f4f4f5; background:rgba(255,255,255,.06); cursor:pointer; font-size:12px; font-weight:600; }
      .cp-account-button:hover:not(:disabled) { background:rgba(255,255,255,.11); }
      .cp-account-button[data-primary="true"] { border-color:#10a37f; color:#fff; background:#10a37f; }
      .cp-account-button:disabled { cursor:not-allowed; opacity:.48; }
      .cp-import { display:grid; gap:12px; }
      .cp-import-heading { display:grid; gap:3px; }
      .cp-import-title { margin:0; font-size:15px; font-weight:650; }
      .cp-import-description { margin:0; color:#a1a1aa; font-size:12px; }
      .cp-import-label { display:grid; gap:7px; color:#d4d4d8; font-size:12px; }
      .cp-import-textarea { width:100%; min-height:290px; resize:vertical; box-sizing:border-box; border:1px solid rgba(255,255,255,.14); border-radius:10px; padding:12px; color:#f4f4f5; background:rgba(0,0,0,.22); font:12px/1.55 ui-monospace,SFMono-Regular,Consolas,monospace; }
      .cp-import-textarea:focus { border-color:#10a37f; outline:0; box-shadow:0 0 0 2px rgba(16,163,127,.18); }
      .cp-import-actions { display:flex; justify-content:space-between; gap:10px; }
      .cp-import-submit-actions { display:flex; gap:10px; }
      .cp-file-input { display:none!important; }
      .cp-account-close:focus-visible,.cp-account-button:focus-visible { outline:2px solid #10a37f; outline-offset:2px; }
      html.light .cp-account-dialog,html[data-theme="light"] .cp-account-dialog { border-color:#e4e4e7; color:#18181b; background:#fff; box-shadow:0 24px 80px rgba(0,0,0,.22); }
      html.light .cp-account-subtitle,html.light .cp-account-meta,html.light .cp-usage-reset,html.light .cp-usage-loading,html.light .cp-import-description,html[data-theme="light"] .cp-account-subtitle,html[data-theme="light"] .cp-account-meta,html[data-theme="light"] .cp-usage-reset,html[data-theme="light"] .cp-usage-loading,html[data-theme="light"] .cp-import-description { color:#6b7280; }
      html.light .cp-account-row,html[data-theme="light"] .cp-account-row { border-color:#e4e4e7; background:#fafafa; }
      html.light .cp-account-row[data-active="true"],html[data-theme="light"] .cp-account-row[data-active="true"] { border-color:rgba(16,163,127,.52); background:rgba(16,163,127,.07); }
      html.light .cp-account-button,html[data-theme="light"] .cp-account-button { border-color:#d4d4d8; color:#27272a; background:#fff; }
      html.light .cp-account-button[data-primary="true"],html[data-theme="light"] .cp-account-button[data-primary="true"] { border-color:#10a37f; color:#fff; background:#10a37f; }
      html.light .cp-import-textarea,html[data-theme="light"] .cp-import-textarea { border-color:#d4d4d8; color:#18181b; background:#fafafa; }
      @media (max-width:560px) { .cp-account-overlay{padding:8px}.cp-account-dialog{max-height:calc(100vh - 16px)}.cp-account-row{grid-template-columns:1fr}.cp-account-button{width:100%}.cp-account-list-actions,.cp-import-actions,.cp-import-submit-actions{flex-direction:column}.cp-usage-window{grid-template-columns:auto 1fr}.cp-usage-reset{grid-column:1/-1}.cp-import-textarea{min-height:230px} }
    `;
    document.head.appendChild(style);
  }

  function normalizedText(node) {
    return String(node?.textContent || "").replace(/\s+/g, " ").trim();
  }

  function isSettings(node) {
    return /^(设置|Settings(?:\s|$))/i.test(normalizedText(node));
  }

  function isLogout(node) {
    return /^(退出登录|登出|Sign out(?:\s|$)|Log out(?:\s|$))/i.test(normalizedText(node));
  }

  function createMenuItem(settingsItem) {
    const item = settingsItem.cloneNode(false);
    item.removeAttribute("id");
    item.removeAttribute("aria-haspopup");
    item.removeAttribute("aria-expanded");
    item.removeAttribute("data-state");
    item.setAttribute(ITEM_ATTR, "true");
    item.setAttribute("aria-label", "切换账户");
    item.setAttribute("role", "menuitem");
    item.tabIndex = -1;
    item.classList.add("codex-plus-account-menu-item");
    item.innerHTML = `<div class="cp-menu-row">${svgIcon()}<div class="cp-menu-label">切换账户</div></div>`;
    item.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation?.();
      openModal(item);
    }, true);
    return item;
  }

  function scanMenus() {
    const items = Array.from(document.querySelectorAll('[role="menuitem"]'));
    for (const settingsItem of items.filter(isSettings)) {
      const parent = settingsItem.parentElement;
      if (!parent || parent.querySelector(`:scope > [${ITEM_ATTR}]`)) continue;
      const siblings = Array.from(parent.children);
      const logout = siblings.find(isLogout);
      const item = createMenuItem(settingsItem);
      if (logout) parent.insertBefore(item, logout);
      else settingsItem.insertAdjacentElement("afterend", item);
    }
  }

  function queueScan() {
    if (state.scanQueued) return;
    state.scanQueued = true;
    queueMicrotask(() => {
      state.scanQueued = false;
      scanMenus();
    });
  }

  function install() {
    installStyle();
    if (!state.observer || !state.observer.takeRecords) {
      state.observer = new MutationObserver(queueScan);
      state.observer.observe(document.documentElement, { childList: true, subtree: true });
    }
    queueScan();
    return health();
  }

  function health() {
    return {
      ready: document.getElementById(STYLE_ID) != null,
      observerReady: !!state.observer,
      modalOpen: !!document.getElementById(ROOT_ID),
      version: VERSION,
    };
  }

  function closeModal() {
    const modal = document.getElementById(ROOT_ID);
    modal?.remove();
    state.modal = null;
    const opener = state.opener;
    state.opener = null;
    opener?.focus?.();
  }

  function setMessage(message, type = "") {
    state.message = String(message || "");
    state.messageType = type;
  }

  function messageMarkup() {
    if (!state.message) return "";
    return `<div class="cp-account-status" data-type="${escapeHtml(state.messageType)}" role="status">${escapeHtml(state.message)}</div>`;
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  async function invoke(path, payload = {}) {
    if (typeof window.codexPlusInvoke !== "function") {
      throw new Error("codex-plus bridge 尚未就绪");
    }
    const result = await window.codexPlusInvoke(path, payload);
    if (["failed", "error"].includes(String(result?.status || "").toLowerCase())) {
      throw new Error(result?.message || "操作失败");
    }
    return result;
  }

  function renderBody() {
    if (state.view === "import") renderImport();
    else renderAccounts();
  }

  function renderAccounts() {
    const body = state.modal?.querySelector("[data-cp-body]");
    if (!body) return;
    if (state.loading) {
      body.innerHTML = `${messageMarkup()}<div class="cp-account-empty">正在读取本地账户…</div>`;
      return;
    }
    const list = state.accounts.length
      ? `<div class="cp-account-list">${state.accounts.map(accountMarkup).join("")}</div>`
      : '<div class="cp-account-empty">暂无账户。可添加一个 auth.json 账户。</div>';
    body.innerHTML = `${messageMarkup()}${list}<div class="cp-account-list-actions"><button type="button" class="cp-account-button" data-primary="true" data-cp-add>添加账户</button></div>`;
    body.querySelectorAll("[data-cp-switch]").forEach((button) => {
      button.addEventListener("click", () => void switchAccount(button.dataset.cpSwitch, button));
    });
    body.querySelector("[data-cp-add]")?.addEventListener("click", () => switchView("import"));
  }

  function accountMarkup(account) {
    const id = String(account?.accountId || "");
    const active = account?.active === true;
    const displayName = account?.name || account?.email || "ChatGPT 账户";
    const secondary = account?.name && account?.email && account.name !== account.email ? account.email : "";
    const usageState = state.usage.get(id);
    return `<div class="cp-account-row" data-account-id="${escapeHtml(id)}" data-active="${active}">
      <div class="cp-account-main">
        <div class="cp-account-name-line"><span class="cp-account-name">${escapeHtml(displayName)}</span>${active ? '<span class="cp-account-badge">当前</span>' : ""}</div>
        <div class="cp-account-meta">${secondary ? `<span>${escapeHtml(secondary)}</span>` : ""}${account?.plan ? `<span>${escapeHtml(account.plan)}</span>` : ""}</div>
        <div class="cp-account-usage">${usageMarkup(usageState)}</div>
      </div>
      <button type="button" class="cp-account-button" data-primary="${!active}" data-cp-switch="${escapeHtml(id)}" ${active || state.switching ? "disabled" : ""}>${state.switching === id ? "切换中…" : active ? "当前账户" : "切换"}</button>
    </div>`;
  }

  function usageMarkup(entry) {
    if (!entry || entry.status === "loading") return '<div class="cp-usage-loading">额度读取中…</div>';
    if (entry.status === "error") return `<div class="cp-usage-loading">${escapeHtml(entry.message || "额度暂不可用")}</div>`;
    const usage = entry.usage || {};
    const rateLimit = usage.rate_limit || usage.rateLimit || {};
    const windows = [rateLimit.primary_window || rateLimit.primaryWindow, rateLimit.secondary_window || rateLimit.secondaryWindow].filter(Boolean);
    if (!windows.length) return '<div class="cp-usage-loading">额度信息暂不可用</div>';
    return windows.map((windowValue) => {
      const rawPercent = Number(windowValue.used_percent ?? windowValue.usedPercent);
      const used = Number.isFinite(rawPercent) ? Math.max(0, Math.min(100, rawPercent)) : 0;
      const remaining = Math.max(0, 100 - used);
      const seconds = Number(windowValue.limit_window_seconds ?? windowValue.limitWindowSeconds);
      const label = seconds && seconds <= 6 * 3600 ? "5 小时额度" : seconds && seconds >= 6 * 24 * 3600 ? "周额度" : "额度窗口";
      const resetAt = Number(windowValue.reset_at ?? windowValue.resetAt);
      const reset = Number.isFinite(resetAt) && resetAt > 0 ? new Date(resetAt * 1000).toLocaleString([], { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "";
      return `<div class="cp-usage-window"><span>${escapeHtml(label)} · 剩余 ${remaining.toFixed(0)}%</span><span class="cp-usage-track"><span class="cp-usage-fill" style="width:${remaining}%"></span></span><span class="cp-usage-reset">${reset ? `重置 ${escapeHtml(reset)}` : ""}</span></div>`;
    }).join("");
  }

  async function loadAccounts() {
    state.loading = true;
    state.accounts = [];
    state.usage.clear();
    renderAccounts();
    try {
      const result = await invoke("/accounts/list", {});
      state.accounts = Array.isArray(result?.accounts) ? result.accounts : [];
      for (const account of state.accounts) {
        const id = String(account?.accountId || "");
        if (id) state.usage.set(id, { status: "loading" });
      }
    } catch (error) {
      setMessage(error?.message || String(error), "error");
    } finally {
      state.loading = false;
      renderAccounts();
    }
    for (const account of state.accounts) {
      const id = String(account?.accountId || "");
      if (id) void loadUsage(id);
    }
  }

  async function loadUsage(accountId) {
    try {
      const result = await invoke("/accounts/usage", { accountId });
      state.usage.set(accountId, { status: "ok", usage: result?.usage || {} });
    } catch (error) {
      state.usage.set(accountId, { status: "error", message: error?.message || "额度暂不可用" });
    }
    if (state.view === "accounts") renderAccounts();
  }

  async function switchAccount(accountId, button) {
    if (!accountId || state.switching) return;
    state.switching = accountId;
    setMessage("");
    button.disabled = true;
    renderAccounts();
    try {
      const result = await invoke("/accounts/switch", { accountId });
      setMessage(result?.message || "正在切换账户并重新启动 Codex…", "success");
    } catch (error) {
      state.switching = "";
      setMessage(error?.message || String(error), "error");
    }
    renderAccounts();
  }

  function renderImport() {
    const body = state.modal?.querySelector("[data-cp-body]");
    if (!body) return;
    body.innerHTML = `${messageMarkup()}<div class="cp-import">
      <div class="cp-import-heading"><h3 class="cp-import-title">添加账户</h3><p class="cp-import-description">粘贴或选取完整的 auth.json，确认导入后才会保存。</p></div>
      <label class="cp-import-label"><span>auth.json 内容${state.sourceName ? ` · ${escapeHtml(state.sourceName)}` : ""}</span><textarea class="cp-import-textarea" data-cp-auth autocomplete="off" spellcheck="false" placeholder="粘贴完整的 auth.json 内容">${escapeHtml(state.draft)}</textarea></label>
      <input type="file" class="cp-file-input" data-cp-file>
      <div class="cp-import-actions"><button type="button" class="cp-account-button" data-cp-back ${state.importing ? "disabled" : ""}>返回</button><div class="cp-import-submit-actions"><button type="button" class="cp-account-button" data-cp-choose ${state.importing ? "disabled" : ""}>选取文件</button><button type="button" class="cp-account-button" data-primary="true" data-cp-import ${state.importing ? "disabled" : ""}>${state.importing ? "导入中…" : "导入"}</button></div></div>
    </div>`;
    const textarea = body.querySelector("[data-cp-auth]");
    textarea.addEventListener("input", () => { state.draft = textarea.value; });
    const input = body.querySelector("[data-cp-file]");
    body.querySelector("[data-cp-back]").addEventListener("click", () => switchView("accounts"));
    body.querySelector("[data-cp-choose]").addEventListener("click", () => input.click());
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      input.value = "";
      if (file) void readFile(file);
    });
    body.querySelector("[data-cp-import]").addEventListener("click", () => void importAuth());
  }

  async function readFile(file) {
    try {
      state.draft = await file.text();
      state.sourceName = file.name || "auth.json";
      setMessage(`已读取 ${state.sourceName}，点击“导入”后才会保存。`, "success");
    } catch (error) {
      setMessage(error?.message || "无法读取文件", "error");
    }
    renderImport();
    state.modal?.querySelector("[data-cp-auth]")?.focus();
  }

  async function importAuth() {
    const textarea = state.modal?.querySelector("[data-cp-auth]");
    if (textarea) state.draft = textarea.value;
    try {
      const value = JSON.parse(state.draft);
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    } catch {
      setMessage("请输入有效的 auth.json JSON 对象。", "error");
      renderImport();
      state.modal?.querySelector("[data-cp-auth]")?.focus();
      return;
    }
    state.importing = true;
    setMessage("");
    renderImport();
    try {
      await invoke("/accounts/import", { authContents: state.draft });
      state.draft = "";
      state.sourceName = "";
      state.importing = false;
      state.view = "accounts";
      setMessage("账户导入成功。", "success");
      await loadAccounts();
    } catch (error) {
      state.importing = false;
      setMessage(error?.message || String(error), "error");
      renderImport();
    }
  }

  function switchView(view) {
    state.view = view === "import" ? "import" : "accounts";
    setMessage("");
    renderBody();
    if (state.view === "import") state.modal?.querySelector("[data-cp-auth]")?.focus();
  }

  function focusable(root) {
    return Array.from(root.querySelectorAll('button:not(:disabled),textarea:not(:disabled),input:not(:disabled),[tabindex]:not([tabindex="-1"])')).filter((node) => node.getClientRects().length > 0 || typeof node.focus === "function");
  }

  function openModal(opener = null) {
    closeModal();
    installStyle();
    state.opener = opener instanceof HTMLElement ? opener : document.activeElement;
    state.view = "accounts";
    state.accounts = [];
    state.usage.clear();
    state.loading = false;
    state.switching = "";
    state.message = "";
    state.messageType = "";
    state.importing = false;
    const overlay = document.createElement("div");
    overlay.id = ROOT_ID;
    overlay.className = "cp-account-overlay";
    overlay.innerHTML = `<section class="cp-account-dialog" role="dialog" aria-modal="true" aria-labelledby="cp-account-title">
      <header class="cp-account-header"><div><h2 class="cp-account-title" id="cp-account-title">账户管理</h2><p class="cp-account-subtitle">切换 ChatGPT 账户并查看额度状态</p></div><button type="button" class="cp-account-close" aria-label="关闭">×</button></header>
      <div class="cp-account-body" data-cp-body aria-live="polite"></div>
    </section>`;
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay || event.target.closest(".cp-account-close")) {
        closeModal();
        return;
      }
    });
    overlay.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeModal();
        return;
      }
      if (event.key !== "Tab") return;
      const nodes = focusable(overlay);
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    });
    document.body.appendChild(overlay);
    state.modal = overlay;
    renderBody();
    void loadAccounts();
  }

  function destroy() {
    state.observer?.disconnect?.();
    state.observer = null;
    document.querySelectorAll(`[${ITEM_ATTR}]`).forEach((node) => node.remove());
    document.getElementById(ROOT_ID)?.remove();
    document.getElementById(STYLE_ID)?.remove();
  }

  window.__codexPlusAccounts = {
    version: VERSION,
    install,
    health,
    destroy,
    open: openModal,
    state,
  };
  install();
})();
