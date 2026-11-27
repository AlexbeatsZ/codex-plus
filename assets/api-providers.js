(() => {
  "use strict";
  const String = window.String;
  const core = window.__codexPlusCore;
  const VERSION = 19;
  const OBSERVER_KEY = "api";
  const ITEM_ATTR = "data-codex-plus-api-item";
  const ACCOUNT_ATTR = "data-codex-plus-account-item";
  const ROOT_ID = "codex-plus-api-modal";
  const STYLE_ID = "codex-plus-api-style";
  const state = {
    unsubscribe: null,
    scanQueued: false,
    view: "list",
    providers: [],
    editing: null,
    models: [],
    loading: false,
    message: "",
    error: false,
    subscription: null,
    subscriptionAccounts: [],
    subscriptionStates: [],
    subscriptionBusy: false,
    accountUsage: new Map(),
    expandedPolicies: new Set(),
    usageGeneration: 0,
    // 最近一次成功保存到后端的配置，用于刷新时保留尚未保存的编辑。
    subscriptionSaved: null,
    saveState: { kind: "idle", text: "" },
  };

  if (window.__codexPlusApi?.version === VERSION) { window.__codexPlusApi.install(); return; }
  window.__codexPlusApi?.destroy?.();

  function cableIcon() {
    return `<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 19h1a4 4 0 0 0 0-8h-1"></path><path d="M7 5H6a4 4 0 0 0 0 8h1"></path><line x1="8" x2="16" y1="12" y2="12"></line></svg>`;
  }

  function closeIcon() {
    return `<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18"></path><path d="m6 6 12 12"></path></svg>`;
  }

  function installStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style"); style.id = STYLE_ID;
    style.textContent = `
      .codex-plus-api-menu-item .cp-api-menu-row { display:flex!important; width:100%!important; min-width:0; flex-direction:row!important; align-items:center!important; gap:8px!important; white-space:nowrap!important; }
      .codex-plus-api-menu-item .cp-api-menu-row svg { flex:0 0 auto; width:16px; height:16px; opacity:.72; }
      .cp-api-overlay { position:fixed; inset:0; z-index:2147483001; display:grid; place-items:center; padding:20px; background:rgba(0,0,0,.56); }
      .cp-api-dialog { --cp-bg:#1f1f20; --cp-surface:#242425; --cp-surface-hover:#2a2a2c; --cp-border:#38383a; --cp-divider:#303032; --cp-text:#f0f0f1; --cp-muted:#9c9ca3; --cp-button:#29292b; --cp-accent:#339cff; --cp-accent-hover:#2d8fe8; width:min(760px,calc(100vw - 28px)); max-height:min(760px,calc(100vh - 28px)); display:flex; flex-direction:column; overflow:hidden; border:1px solid var(--cp-border); border-radius:12px; color:var(--cp-text); background:var(--cp-bg); box-shadow:0 24px 64px rgba(0,0,0,.48); color-scheme:dark; font-family:inherit; }
      .cp-api-header { display:flex; align-items:flex-start; justify-content:space-between; gap:16px; padding:20px 20px 12px; }
      .cp-api-title { margin:0; font-size:17px; line-height:24px; font-weight:600; letter-spacing:-.01em; }
      .cp-api-subtitle { margin:2px 0 0; color:var(--cp-muted); font-size:12px; line-height:18px; }
      .cp-api-close { display:grid; flex:0 0 auto; place-items:center; width:28px; height:28px; border:0; border-radius:7px; padding:0; color:var(--cp-muted); background:transparent; cursor:pointer; }
      .cp-api-close:hover { color:var(--cp-text); background:var(--cp-surface-hover); }
      .cp-api-close svg { width:16px; height:16px; }
      .cp-api-body { padding:12px 20px 20px; overflow:auto; }
      .cp-api-toolbar,.cp-api-actions { display:flex; align-items:center; justify-content:space-between; gap:10px; color:var(--cp-muted); font-size:12px; }
      .cp-api-list { overflow:hidden; margin-top:12px; border:1px solid var(--cp-border); border-radius:12px; background:var(--cp-surface); }
      .cp-api-row { display:grid; grid-template-columns:minmax(0,1fr) auto; align-items:center; gap:12px; border:0; border-bottom:1px solid var(--cp-divider); padding:13px 14px; background:transparent; }
      .cp-api-row:last-child { border-bottom:0; }
      .cp-api-name { font-size:14px; font-weight:600; }
      .cp-api-meta { margin-top:3px; color:var(--cp-muted); font-size:12px; overflow:hidden; text-overflow:ellipsis; }
      .cp-api-button { min-height:30px; border:1px solid var(--cp-border); border-radius:8px; padding:0 11px; color:var(--cp-text); background:var(--cp-button); cursor:pointer; font-size:12px; font-weight:500; }
      .cp-api-button:hover:not(:disabled) { background:var(--cp-surface-hover); }
      .cp-api-button[data-primary="true"] { border-color:var(--cp-accent); background:var(--cp-accent); color:#fff; }
      .cp-api-button[data-primary="true"]:hover:not(:disabled) { border-color:var(--cp-accent-hover); background:var(--cp-accent-hover); }
      .cp-api-button[data-danger="true"] { color:#ff8b8b; }
      .cp-api-button:disabled { opacity:.5; cursor:not-allowed; }
      .cp-api-dialog input[type="checkbox"] { appearance:auto; display:inline-block; box-sizing:border-box; flex:0 0 auto; width:16px; height:16px; margin:0 6px 0 0; padding:0; vertical-align:middle; accent-color:var(--cp-accent); cursor:pointer; }
      .cp-api-dialog input[type="checkbox"]:focus-visible { outline:2px solid var(--cp-accent); outline-offset:2px; }
      .cp-api-dialog input[type="checkbox"]:disabled { opacity:.5; cursor:default; }
      .cp-sub-next { padding:12px 14px; border:1px solid var(--cp-border); border-left:3px solid var(--cp-accent); border-radius:8px; font-size:12px; line-height:1.7; background:var(--cp-surface); }
      .cp-sub-next strong { display:block; font-size:15px; font-weight:600; overflow-wrap:anywhere; }
      .cp-sub-count { color:var(--cp-muted); font-weight:400; margin-left:5px; }
      .cp-sub-group .cp-api-list { margin-top:8px; }
      .cp-sub-group > .cp-api-actions { font-size:12px; }
      .cp-api-button:focus-visible { outline:2px solid var(--cp-accent); outline-offset:2px; }
      .cp-sub-row { display:flex; flex-wrap:wrap; gap:8px; align-items:center; padding:11px 12px; border-bottom:1px solid var(--cp-divider); }
      .cp-sub-row:last-child { border-bottom:0; }
      .cp-sub-row[data-temp="true"] { background:rgba(51,156,255,.045); box-shadow:inset 2px 0 0 var(--cp-accent); }
      .cp-sub-row label { flex:1; min-width:0; font-size:12px; overflow-wrap:anywhere; }
      .cp-sub-row-head { display:flex; align-items:center; gap:6px; flex-wrap:wrap; }
      .cp-sub-badge { display:inline-flex; align-items:center; border-radius:999px; padding:1px 7px; font-size:10px; line-height:17px; font-weight:600; color:var(--cp-muted); background:rgba(255,255,255,.07); }
      .cp-sub-badge[data-kind="pool"] { color:#8cc9ff; background:rgba(51,156,255,.14); }
      .cp-sub-badge[data-kind="temp"] { color:#7dd3fc; background:rgba(56,189,248,.16); }
      .cp-sub-badge[data-kind="done"] { color:#fcd34d; background:rgba(245,158,11,.15); }
      .cp-sub-note { color:var(--cp-muted); font-size:12px; line-height:1.6; margin:0; }
      .cp-sub-row small { display:block; color:var(--cp-muted); margin-top:4px; }
      .cp-sub-health { display:block; margin-top:4px; font-size:11px; line-height:1.5; color:var(--cp-muted); }
      .cp-sub-health[data-kind="temporary"] { color:#8cc9ff; }
      .cp-sub-health[data-kind="temporary_completed"] { color:#fcd34d; }
      .cp-sub-health[data-kind="error"] { color:#fca5a5; }
      .cp-sub-row .cp-api-button { min-width:32px; padding:0 8px; }
      .cp-sub-row-actions { display:flex; align-items:center; gap:6px; flex:0 0 auto; }
      .cp-sub-usage { flex:0 0 100%; display:grid; gap:5px; padding-left:22px; box-sizing:border-box; }
      .cp-sub-usage-item { display:grid; grid-template-columns:auto minmax(80px,1fr) auto; align-items:center; gap:8px; color:var(--cp-text); font-size:11px; font-variant-numeric:tabular-nums; }
      .cp-sub-usage-track { height:4px; overflow:hidden; border-radius:999px; background:var(--cp-divider); }
      .cp-sub-usage-fill { display:block; height:100%; border-radius:inherit; background:var(--cp-accent); }
      .cp-sub-usage-fill[data-low="true"] { background:#f59e0b; }
      .cp-sub-usage-fill[data-empty="true"] { background:#ef4444; }
      .cp-sub-usage-reset { color:var(--cp-muted); white-space:nowrap; }
      .cp-sub-usage-status { display:flex; align-items:center; flex-wrap:wrap; gap:8px; color:var(--cp-muted); font-size:11px; }
      .cp-sub-temp { flex:0 0 100%; display:flex; flex-wrap:wrap; align-items:center; gap:8px 16px; margin-left:22px; padding:8px 10px; border-radius:8px; border:1px solid rgba(51,156,255,.28); background:rgba(51,156,255,.06); box-sizing:border-box; max-width:calc(100% - 22px); }
      .cp-sub-temp-row { flex:0 0 100%; display:flex; flex-wrap:wrap; align-items:center; gap:8px 16px; }
      .cp-sub-temp-presets { display:flex; flex-wrap:wrap; align-items:center; gap:6px; }
      .cp-sub-temp-preset { min-height:26px!important; padding:0 10px!important; border-radius:999px; font-size:11px; }
      .cp-sub-temp-preset[data-active="true"] { border-color:var(--cp-accent); background:rgba(51,156,255,.22); color:#fff; }
      .cp-sub-row .cp-sub-temp label { display:flex; flex:0 1 auto; align-items:center; gap:6px; color:var(--cp-text); font-size:12px; }
      .cp-sub-temp input { width:78px; min-height:28px; padding:4px 7px; }
      .cp-sub-temp-hint { flex:0 0 100%; color:#8cc9ff; font-size:11px; line-height:1.45; }
      .cp-sub-temp-hint:empty { display:none; }
      .cp-sub-policy { flex:0 0 100%; margin-left:22px; max-width:calc(100% - 22px); box-sizing:border-box; }
      .cp-sub-policy summary { color:var(--cp-muted); font-size:11px; line-height:24px; cursor:pointer; }
      .cp-sub-policy summary:focus-visible { outline:2px solid var(--cp-accent); outline-offset:2px; }
      .cp-sub-policy .cp-sub-temp { margin:5px 0 0; max-width:100%; }
      .cp-sub-policy .cp-sub-reserve { padding:5px 0 0; }
      .cp-sub-row-head { flex-wrap:nowrap; }
      @media(max-width:520px) { .cp-sub-row > label { flex-basis:100%; } .cp-sub-row-actions { margin-left:22px; } }
      .cp-sub-reserve { display:flex; flex:0 0 100%; flex-wrap:wrap; gap:8px 16px; padding-left:22px; box-sizing:border-box; }
      .cp-sub-row .cp-sub-reserve label { display:flex; flex:0 1 auto; align-items:center; gap:6px; color:var(--cp-muted); }
      .cp-sub-reserve input { width:78px; min-height:30px; padding:4px 7px; }
      .cp-api-sub-overview { border-top:1px solid var(--cp-divider); padding:10px 14px 12px; background:rgba(255,255,255,.015); }
      .cp-api-sub-overview-head { display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:8px; margin-bottom:8px; color:var(--cp-muted); font-size:11px; }
      .cp-api-sub-overview-title { font-size:12px; font-weight:600; color:var(--cp-text); }
      .cp-api-sub-overview-list { display:grid; gap:8px; }
      .cp-api-sub-card { border:1px solid var(--cp-divider); border-radius:9px; padding:8px 10px; background:var(--cp-bg); display:grid; gap:5px; }
      .cp-api-sub-card-head { display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:6px; font-size:12px; }
      .cp-api-sub-card-name { font-weight:600; color:var(--cp-text); }
      .cp-api-sub-card .cp-sub-usage { padding-left:0; }
      .cp-api-form { display:grid; gap:12px; }
      .cp-api-grid { display:grid; grid-template-columns:1fr 1fr; gap:10px; }
      .cp-api-field { display:grid; gap:6px; color:var(--cp-text); font-size:12px; }
      .cp-api-input,.cp-api-select { box-sizing:border-box; width:100%; min-height:34px; border:1px solid var(--cp-border); border-radius:8px; padding:7px 9px; color:var(--cp-text); background:#181819; }
      .cp-api-input:focus,.cp-api-select:focus { border-color:var(--cp-accent); outline:0; box-shadow:0 0 0 2px rgba(51,156,255,.16); }
      .cp-api-select { color-scheme:dark; }
      .cp-api-select option { color:var(--cp-text); background:var(--cp-bg); }
      .cp-api-models { max-height:310px; overflow:auto; border:1px solid var(--cp-border); border-radius:10px; background:var(--cp-surface); }
      .cp-api-model { display:grid; grid-template-columns:auto minmax(110px,1fr) minmax(110px,1fr) minmax(100px,.7fr) minmax(120px,.8fr); align-items:center; gap:8px; border:0; border-bottom:1px solid var(--cp-divider); padding:8px 10px; }
      .cp-api-model:last-child { border-bottom:0; }
      .cp-api-model-id { overflow:hidden; text-overflow:ellipsis; color:var(--cp-muted); font:11px ui-monospace,monospace; }
      .cp-api-save-state { display:inline-flex; align-items:center; gap:6px; margin-top:4px; color:var(--cp-muted); font-size:12px; line-height:18px; }
      .cp-api-save-state:empty { display:none; }
      .cp-api-save-state[data-kind="saved"]::before { content:"✓"; color:#4ade80; }
      .cp-api-save-state[data-kind="error"] { color:#fca5a5; }
      html.light .cp-api-save-state[data-kind="error"],html[data-theme="light"] .cp-api-save-state[data-kind="error"] { color:#b91c1c; }
      .cp-api-status { margin-bottom:10px; border:1px solid rgba(51,156,255,.36); border-radius:8px; padding:8px 10px; color:#8cc9ff; background:var(--cp-surface); font-size:12px; }
      .cp-api-status[data-error="true"] { border-color:rgba(248,113,113,.4); color:#fca5a5; }
      .cp-api-empty { margin-top:12px; padding:60px 10px; border:1px solid var(--cp-border); border-radius:12px; color:var(--cp-muted); background:var(--cp-surface); text-align:center; font-size:13px; }
      .cp-api-close:focus-visible,.cp-api-button:focus-visible { outline:2px solid var(--cp-accent); outline-offset:2px; }
      html.light .cp-api-dialog,html[data-theme="light"] .cp-api-dialog { --cp-bg:#fff; --cp-surface:#f7f7f8; --cp-surface-hover:#ececef; --cp-border:#dedee1; --cp-divider:#e7e7e9; --cp-text:#202123; --cp-muted:#6e6e75; --cp-button:#fff; color-scheme:light; box-shadow:0 24px 64px rgba(0,0,0,.2); }
      html.light .cp-api-input,html.light .cp-api-select,html[data-theme="light"] .cp-api-input,html[data-theme="light"] .cp-api-select { background:#fff; }
      html.light .cp-api-select,html[data-theme="light"] .cp-api-select { color-scheme:light; }
      html.light .cp-sub-badge,html[data-theme="light"] .cp-sub-badge { background:rgba(0,0,0,.06); }
      html.light .cp-sub-badge[data-kind="pool"],html[data-theme="light"] .cp-sub-badge[data-kind="pool"] { color:#1d4ed8; background:rgba(59,130,246,.12); }
      html.light .cp-sub-badge[data-kind="temp"],html[data-theme="light"] .cp-sub-badge[data-kind="temp"] { color:#0369a1; background:rgba(14,165,233,.14); }
      html.light .cp-sub-badge[data-kind="done"],html[data-theme="light"] .cp-sub-badge[data-kind="done"] { color:#b45309; background:rgba(245,158,11,.14); }
      html.light .cp-sub-health[data-kind="temporary"],html[data-theme="light"] .cp-sub-health[data-kind="temporary"],html.light .cp-sub-temp-hint,html[data-theme="light"] .cp-sub-temp-hint { color:#1d4ed8; }
      html.light .cp-sub-temp-preset[data-active="true"],html[data-theme="light"] .cp-sub-temp-preset[data-active="true"] { border-color:var(--cp-accent); background:rgba(51,156,255,.15); color:#1d4ed8; }
      html.light .cp-sub-health[data-kind="temporary_completed"],html[data-theme="light"] .cp-sub-health[data-kind="temporary_completed"] { color:#b45309; }
      html.light .cp-sub-health[data-kind="error"],html[data-theme="light"] .cp-sub-health[data-kind="error"] { color:#b91c1c; }
      html.light .cp-api-sub-overview,html[data-theme="light"] .cp-api-sub-overview { background:rgba(0,0,0,.015); }
      @media(max-width:600px) { .cp-api-overlay{padding:8px}.cp-api-dialog{max-height:calc(100vh - 16px)}.cp-api-grid{grid-template-columns:1fr}.cp-api-model{grid-template-columns:auto 1fr}.cp-api-model-id{grid-column:2}.cp-api-row{grid-template-columns:1fr}.cp-sub-usage-item{grid-template-columns:auto 1fr}.cp-sub-usage-reset{grid-column:1/-1} }
    `;
    document.head.appendChild(style);
  }

  const text = core.text;
  const esc = core.escapeHtml;
  const invoke = core.invoke;
  const mutationMayContainMenu = core.mutationMayContainMenu;

  function createItem(template) {
    const item = template.cloneNode(false); item.removeAttribute("id"); item.removeAttribute("aria-haspopup"); item.removeAttribute("data-state");
    item.setAttribute(ITEM_ATTR, "true"); item.setAttribute("role", "menuitem"); item.setAttribute("aria-label", "API 接入"); item.tabIndex = -1; item.classList.add("codex-plus-api-menu-item");
    item.innerHTML = `<div class="cp-api-menu-row">${cableIcon()}<div>API 接入</div></div>`;
    item.addEventListener("click", (event) => { event.preventDefault(); event.stopPropagation(); openModal(); }, true);
    return item;
  }

  function scan() {
    for (const { parent, settings: item } of core.profileMenus()) {
      if (parent.querySelector(`:scope > [${ITEM_ATTR}]`)) continue;
      const api = createItem(item); const account = parent.querySelector(`:scope > [${ACCOUNT_ATTR}]`);
      if (account) parent.insertBefore(api, account); else item.insertAdjacentElement("afterend", api);
    }
  }

  function queueScan(records) {
    if (!mutationMayContainMenu(records) || state.scanQueued) return;
    state.scanQueued = true;
    queueMicrotask(() => {
      state.scanQueued = false;
      scan();
    });
  }

  // 自动保存：每次改动后排队保存，输入框防抖，保存串行执行且保存中的新改动会在完成后再存一次。
  function createAutosave(run) {
    let timer = null, running = null, again = false;
    function execute() {
      if (timer) { clearTimeout(timer); timer = null; }
      if (running) { again = true; return running; }
      running = (async () => {
        try { do { again = false; await run(); } while (again); }
        finally { running = null; }
      })();
      return running;
    }
    return {
      schedule(delay = 0) {
        if (timer) clearTimeout(timer);
        setSaveState("pending", "有改动，即将自动保存…");
        timer = setTimeout(() => void execute(), delay);
      },
      flush() { return timer ? execute() : running || Promise.resolve(); },
      cancel() { if (timer) clearTimeout(timer); timer = null; },
    };
  }

  const TYPING_DELAY = 700;
  const clone = (value) => JSON.parse(JSON.stringify(value ?? null));
  const subscriptionAutosave = createAutosave(saveSubscriptionNow);
  const providerAutosave = createAutosave(saveProviderNow);

  function setSaveState(kind, textValue = "") {
    const labels = { saving: "正在保存…", saved: "已自动保存" };
    state.saveState = { kind, text: textValue || labels[kind] || "" };
    const node = document.querySelector(`#${ROOT_ID} [data-api-save-state]`);
    if (node) { node.dataset.kind = kind; node.textContent = state.saveState.text; }
  }

  function status() { return state.message ? `<div class="cp-api-status" data-error="${state.error}">${esc(state.message)}</div>` : ""; }
  function body() { return document.querySelector(`#${ROOT_ID} [data-api-body]`); }

  function usageWindows(usage) {
    const limits = usage?.rate_limit || usage?.rateLimit || {};
    return [limits.primary_window || limits.primaryWindow, limits.secondary_window || limits.secondaryWindow].filter(Boolean);
  }

  function remainingPercent(windowValue) {
    const value = windowValue?.used_percent ?? windowValue?.usedPercent;
    if (value == null || value === "" || !Number.isFinite(Number(value))) return null;
    return 100 - Math.max(0, Math.min(100, Number(value)));
  }

  function windowKind(windowValue) {
    const seconds = Number(windowValue?.limit_window_seconds ?? windowValue?.limitWindowSeconds);
    if (!Number.isFinite(seconds) || seconds <= 0) return null;
    return seconds <= 86400 ? "short" : "long";
  }

  function windowLabel(windowValue) {
    const seconds = Number(windowValue?.limit_window_seconds ?? windowValue?.limitWindowSeconds);
    if (seconds && seconds <= 6 * 3600) return "5 小时额度";
    if (seconds && seconds >= 6 * 24 * 3600) return "周额度";
    return "额度窗口";
  }

  function currentRemaining(recordId, kind) {
    const entry = state.accountUsage.get(String(recordId));
    if (!entry?.usage) return null;
    for (const windowValue of usageWindows(entry.usage)) {
      if (windowKind(windowValue) === kind) return remainingPercent(windowValue);
    }
    return null;
  }

  function currentResetAt(recordId, kind) {
    const entry = state.accountUsage.get(String(recordId));
    if (!entry?.usage) return null;
    for (const windowValue of usageWindows(entry.usage)) {
      if (windowKind(windowValue) === kind) {
        const resetAt = Number(windowValue.reset_at ?? windowValue.resetAt);
        return Number.isFinite(resetAt) && resetAt > 0 ? resetAt : null;
      }
    }
    return null;
  }

  function hasTemporaryCondition(temp) {
    return temp?.weeklyRemainingPercent != null
      || temp?.shortTermPercent != null
      || temp?.longTermPercent != null
      || temp?.durationMinutes != null
      || temp?.untilReset === "short"
      || temp?.untilReset === "long";
  }

  function isTemporary(config, id) {
    return !!config?.accountOrder?.includes(id)
      && Object.prototype.hasOwnProperty.call(config?.accountTemporary || {}, id);
  }

  function normalizeSubscriptionConfig(config, accounts = []) {
    const validIds = new Set((accounts || []).map((account) => String(account.recordId)));
    const filterMap = (map) => Object.fromEntries(Object.entries(map || {}).filter(([id]) => validIds.has(id)));
    return {
      enabled: config?.enabled === true,
      autoActivate: config?.autoActivate === true,
      accountOrder: Array.isArray(config?.accountOrder) ? config.accountOrder.slice() : [],
      accountPriority: Array.isArray(config?.accountPriority) ? config.accountPriority.slice() : (config?.accountOrder || []).filter(id => config?.accountTemporary?.[id]),
      forcePriority: config?.forcePriority === true,
      models: (config?.models || []).map((model) => ({ ...model })),
      proxyUrl: String(config?.proxyUrl || ""),
      accountReserves: filterMap(config?.accountReserves),
      accountTemporary: filterMap(config?.accountTemporary),
    };
  }

  function anyUsageLoading() {
    for (const entry of state.accountUsage.values()) {
      if (entry?.status === "loading") return true;
    }
    return false;
  }

  function accountUsageMarkup(recordId) {
    const entry = state.accountUsage.get(String(recordId));
    const loading = entry?.status === "loading";
    const windows = entry?.usage ? usageWindows(entry.usage) : [];
    const bars = windows.map((windowValue) => {
      const remaining = remainingPercent(windowValue);
      if (remaining == null) return '<div class="cp-sub-usage-status"><span>额度剩余未知</span></div>';
      const resetAt = Number(windowValue.reset_at ?? windowValue.resetAt);
      const reset = core.formatUtc8Reset(resetAt);
      const fillAttrs = remaining <= 0 ? 'data-empty="true"' : remaining <= 20 ? 'data-low="true"' : "";
      return `<div class="cp-sub-usage-item"><span>${esc(windowLabel(windowValue))} · 剩余 ${remaining.toFixed(0)}%</span><span class="cp-sub-usage-track"><span class="cp-sub-usage-fill" ${fillAttrs} style="width:${remaining}%"></span></span><span class="cp-sub-usage-reset">${reset ? `重置 ${esc(reset)}` : ""}</span></div>`;
    }).join("");
    let footer = "";
    if (loading) {
      footer = `<div class="cp-sub-usage-status"><span>${windows.length ? "正在刷新额度…" : "额度读取中…"}</span></div>`;
    } else if (entry?.status === "error") {
      const updated = entry.updatedAt ? `上次更新 ${core.formatUtc8DateTime(entry.updatedAt)}` : "";
      const textValue = [entry.message || "额度暂不可用", updated].filter(Boolean).join(" · ");
      footer = `<div class="cp-sub-usage-status"><span>${esc(textValue)}</span><button type="button" class="cp-api-button" data-sub-usage-retry="${esc(recordId)}">重试</button></div>`;
    } else if (!windows.length) {
      footer = `<div class="cp-sub-usage-status"><span>${entry ? "额度信息暂不可用" : "额度待读取"}</span><button type="button" class="cp-api-button" data-sub-usage-retry="${esc(recordId)}">读取</button></div>`;
    }
    return `${bars}${footer}${accountExtrasMarkup(entry?.usage)}`;
  }

  function accountExtrasMarkup(usage) {
    if (!usage) return "";
    const parts = [];
    const credits = usage.credits;
    if (credits?.unlimited === true) parts.push("余额 不限");
    else if (credits && Number.isFinite(Number(credits.balance))) parts.push(`余额 ${Number(credits.balance).toLocaleString("zh-CN", { maximumFractionDigits: 2 })} credits`);
    const resets = Number(usage.rate_limit_reset_credits?.available_count);
    if (Number.isFinite(resets)) parts.push(`重置卡 ${resets} 张`);
    return parts.length ? `<div class="cp-sub-usage-status" data-sub-usage-extras><span>${esc(parts.join(" · "))}</span></div>` : "";
  }

  function temporaryHintText(id, temp) {
    const parts = [];
    if (temp?.weeklyRemainingPercent != null) parts.push(`周剩余 ≤ ${temp.weeklyRemainingPercent}% 时恢复自动分配`);
    const shortLimit = temp?.shortTermPercent;
    const longLimit = temp?.longTermPercent;
    if (shortLimit != null && Number.isFinite(Number(shortLimit))) {
      const rem = currentRemaining(id, "short");
      parts.push(rem != null
        ? `5h 剩余 ≤ ${Math.max(0, rem - Number(shortLimit)).toFixed(0)}% 自动退出`
        : `5h 使用 ${shortLimit}% 后自动退出`);
    }
    if (longLimit != null && Number.isFinite(Number(longLimit))) {
      const rem = currentRemaining(id, "long");
      parts.push(rem != null
        ? `周剩余 ≤ ${Math.max(0, rem - Number(longLimit)).toFixed(0)}% 自动退出`
        : `周使用 ${longLimit}% 后自动退出`);
    }
    if (temp?.durationMinutes != null && Number.isFinite(Number(temp.durationMinutes))) {
      parts.push(`限时 ${Number(temp.durationMinutes)} min 自动退出`);
    }
    if (temp?.untilReset === "short") {
      const resetAt = currentResetAt(id, "short");
      parts.push(resetAt
        ? `直到下次 5h 额度刷新（${core.formatUtc8Reset(resetAt)}）自动退出`
        : "直到下次 5h 额度刷新自动退出");
    } else if (temp?.untilReset === "long") {
      const resetAt = currentResetAt(id, "long");
      parts.push(resetAt
        ? `直到下次周额度刷新（${core.formatUtc8Reset(resetAt)}）自动退出`
        : "直到下次周额度刷新自动退出");
    }
    return parts.join(" · ");
  }

  function accountHealthItems(id) {
    return state.subscriptionStates
      .filter((s) => s.recordId === id)
      .map((s) => {
        if (s.status === "temporary") return { kind: "temporary", text: s.reason };
        if (s.status === "temporary_completed") return { kind: "temporary_completed", text: s.reason };
        if (s.blocked) return { kind: "error", text: s.reason };
        if (s.reserve) return { kind: s.status === "reserved" ? "temporary_completed" : "muted", text: s.reason };
        const retryAt = Number(s.retryAt);
        const retryText = Number.isFinite(retryAt) && retryAt > 0 ? core.formatUtc8DateTime(retryAt * 1000) : "稍后";
        return { kind: "error", text: `${s.model === "*" ? "账户" : s.model}：${s.reason}，${retryText} 后重试` };
      });
  }

  function renderSubOverviewMarkup() {
    const config = state.subscription;
    if (!state.subscriptionLoaded) {
      return '<div class="cp-api-sub-overview" data-api-sub-overview><div class="cp-api-sub-overview-head"><span class="cp-api-sub-overview-title">账户用量额度</span><span>正在读取账户额度…</span></div></div>';
    }
    const accounts = new Map(state.subscriptionAccounts.map((a) => [String(a.recordId), a]));
    const order = config?.accountOrder || [];
    const ids = [...order, ...accounts.keys()].filter((id, i, all) => all.indexOf(id) === i && accounts.has(id));
    const loading = anyUsageLoading();
    const cards = ids.map((id) => {
      const account = accounts.get(id);
      const index = order.indexOf(id);
      const temp = isTemporary(config, id);
      const health = accountHealthItems(id);
      const completed = health.some((item) => item.kind === "temporary_completed");
      const badge = temp
        ? `<span class="cp-sub-badge" data-kind="temp">临时 #${index + 1}</span>`
        : index >= 0
          ? `<span class="cp-sub-badge" data-kind="pool">池内 #${index + 1}</span>`
          : completed
            ? '<span class="cp-sub-badge" data-kind="done">已自动移出</span>'
            : '<span class="cp-sub-badge">未加入池</span>';
      const healthHtml = health.map((item) => `<span class="cp-sub-health" data-kind="${esc(item.kind)}">${esc(item.text)}</span>`).join("");
      return `<div class="cp-api-sub-card"><div class="cp-api-sub-card-head"><span class="cp-api-sub-card-name">${esc(account?.email || account?.name || "ChatGPT 账户")}${account?.plan ? ` · ${esc(account.plan)}` : ""}</span>${badge}</div><div class="cp-sub-usage" data-sub-usage-account="${esc(id)}">${accountUsageMarkup(id)}</div>${healthHtml}</div>`;
    }).join("");
    return `<div class="cp-api-sub-overview" data-api-sub-overview><div class="cp-api-sub-overview-head"><span class="cp-api-sub-overview-title">订阅账户用量额度</span><button type="button" class="cp-api-button" data-api-usage-refresh ${loading || !ids.length ? "disabled" : ""}>${loading ? "刷新中…" : "刷新额度"}</button></div>${cards ? `<div class="cp-api-sub-overview-list">${cards}</div>` : '<div class="cp-sub-note">暂无已导入账户。</div>'}</div>`;
  }

  function bindUsageActions(container) {
    if (!container) return;
    container.querySelectorAll("[data-sub-usage-retry]").forEach((button) => {
      button.addEventListener("click", () => void loadSingleUsage(button.dataset.subUsageRetry));
    });
    container.querySelector("[data-api-usage-refresh]")?.addEventListener("click", () => {
      void refreshUsageForAccounts(state.subscriptionAccounts, { force: true });
    });
    container.querySelector("[data-sub-refresh-usage]")?.addEventListener("click", () => {
      void refreshUsageForAccounts(state.subscriptionAccounts, { force: true });
    });
  }

  function syncUsageDom(recordId) {
    const root = body();
    if (!root) return;
    const id = String(recordId);
    root.querySelectorAll("[data-sub-usage-account]").forEach((slot) => {
      if (slot.dataset.subUsageAccount !== id) return;
      slot.innerHTML = accountUsageMarkup(id);
      bindUsageActions(slot);
    });
    root.querySelectorAll("[data-sub-temp-hint]").forEach((hint) => {
      if (hint.dataset.subTempHint !== id) return;
      hint.textContent = temporaryHintText(id, state.subscription?.accountTemporary?.[id]);
    });
    syncRoutingDom();
    const loading = anyUsageLoading();
    root.querySelectorAll("[data-sub-refresh-usage], [data-api-usage-refresh]").forEach((button) => {
      button.disabled = loading || !state.subscriptionAccounts.length;
      button.textContent = loading ? "刷新中…" : "刷新额度";
    });
  }

  async function loadSingleUsage(recordId, generation = state.usageGeneration) {
    const id = String(recordId || "");
    if (!id) return;
    const previous = state.accountUsage.get(id);
    const request = {};
    state.accountUsage.set(id, { ...previous, status: "loading", request });
    syncUsageDom(id);
    const current = () => generation === state.usageGeneration
      && document.getElementById(ROOT_ID)
      && state.accountUsage.get(id)?.request === request;
    try {
      const result = await invoke("/accounts/usage", { recordId: id });
      if (!current()) return;
      if (!result?.usage || typeof result.usage !== "object") {
        state.accountUsage.set(id, { ...previous, status: "error", message: "额度暂不可用" });
      } else {
        state.accountUsage.set(id, { status: "ok", usage: result.usage, updatedAt: Date.now() });
      }
    } catch (error) {
      if (!current()) return;
      state.accountUsage.set(id, { ...previous, status: "error", message: error?.message || "额度暂不可用" });
    }
    syncUsageDom(id);
  }

  async function refreshUsageForAccounts(accounts, { force = false } = {}) {
    const list = Array.isArray(accounts) ? accounts : [];
    const now = Date.now();
    const queue = list.map((account) => String(account?.recordId || "")).filter((id) => {
      if (!id) return false;
      if (force) return true;
      const entry = state.accountUsage.get(id);
      return !entry || entry.status !== "ok" || !entry.updatedAt || now - entry.updatedAt >= 30000;
    });
    if (!queue.length) return;
    const generation = ++state.usageGeneration;
    for (const id of queue) {
      state.accountUsage.set(id, { ...state.accountUsage.get(id), status: "loading" });
      syncUsageDom(id);
    }
    async function worker() {
      while (queue.length && generation === state.usageGeneration && document.getElementById(ROOT_ID)) {
        await loadSingleUsage(queue.shift(), generation);
      }
    }
    const workers = Math.min(3, queue.length);
    await Promise.all(Array.from({ length: workers }, () => worker()));
    if (generation !== state.usageGeneration || !document.getElementById(ROOT_ID)) return;
    // Usage reads can complete priority goals. Reconcile only an unchanged editor.
    const isEditing = () => document.activeElement && body()?.contains(document.activeElement) && document.activeElement.matches("input:not([type=checkbox]), select");
    if (state.view === "subscription" && state.subscriptionLoaded && !isEditing()
      && JSON.stringify(subscriptionPayload(state.subscription).payload) === JSON.stringify(subscriptionPayload(state.subscriptionSaved || state.subscription).payload)) {
      const before = JSON.stringify(state.subscription);
      try {
        const result = await invoke("/api-providers/subscription/get");
        if (generation !== state.usageGeneration || state.view !== "subscription" || before !== JSON.stringify(state.subscription) || isEditing()) return;
        state.subscription = normalizeSubscriptionConfig(result.config, state.subscriptionAccounts);
        state.subscriptionSaved = clone(state.subscription);
        state.subscriptionStates = subscriptionStates(result);
      } catch { /* Keep current values and retry on the next refresh. */ }
    }
    const active = document.activeElement;
    const editing = active && body()?.contains(active) && active.matches("input:not([type=checkbox]), select");
    if (state.view === "subscription" && !editing) renderSubscription();
  }

  function renderList() {
    const root = body(); if (!root) return;
    state.view = "list";
    setSaveState("idle");
    root.innerHTML = `${status()}<div class="cp-api-toolbar"><span>${state.loading ? "正在读取…" : `已配置 ${state.providers.length} 个 API`}</span><button class="cp-api-button" data-api-new data-primary="true">添加 API</button></div>${state.providers.length ? `<div class="cp-api-list">${state.providers.map((p) => `<div class="cp-api-row"><div><div class="cp-api-name">${esc(p.name)}${p.enabled ? "" : " · 已停用"}</div><div class="cp-api-meta">${p.kind === "subscription" ? "ChatGPT 订阅额度池" : `${esc(p.baseUrl)} · ${esc(p.protocol)}`} · ${p.models.filter((m) => m.visible).length} 个模型</div></div><div><button class="cp-api-button" data-api-edit="${esc(p.id)}">${p.kind === "subscription" ? "配置" : "编辑"}</button>${p.kind === "subscription" ? "" : ` <button class="cp-api-button" data-danger="true" data-api-delete="${esc(p.id)}">删除</button>`}</div></div>${p.kind === "subscription" ? renderSubOverviewMarkup() : ""}`).join("")}</div>` : '<div class="cp-api-empty">尚未接入 API。</div>'}`;
    root.querySelector("[data-api-new]")?.addEventListener("click", () => edit(null));
    root.insertAdjacentHTML("beforeend", '<div class="cp-api-actions" style="margin-top:14px"><span></span><button class="cp-api-button" data-api-mobile>迁移旧任务</button></div>');
    root.querySelector("[data-api-mobile]").addEventListener("click", () => void mobileMigration());
    root.querySelectorAll("[data-api-edit]").forEach((button) => button.addEventListener("click", () => edit(state.providers.find((p) => p.id === button.dataset.apiEdit))));
    root.querySelectorAll("[data-api-delete]").forEach((button) => button.addEventListener("click", () => void removeProvider(button.dataset.apiDelete)));
    bindUsageActions(root);
  }

  async function mobileMigration() {
    const root = body(); if (!root) return;
    state.view = "mobile";
    root.innerHTML = '<div class="cp-api-status">正在读取旧任务…</div>';
    try {
      const routing = window.__codexPlusModelRouting;
      await routing.loadCatalog(true);
      const threads = await routing.legacyThreads();
      if (!body() || body() !== root) return;
      root.innerHTML = `<div class="cp-api-form"><p class="cp-sub-note">为选中的旧任务创建一个保留完整历史的新分支，供手机访问。原任务保留；运行中的任务须先结束。</p><label class="cp-api-field">旧任务<select class="cp-api-input" data-mobile-thread>${threads.map(t => `<option value="${esc(t.id)}">${esc(t.name || t.title || t.preview || t.id)}</option>`).join("")}</select></label><label class="cp-api-field">新分支使用的模型<select class="cp-api-input" data-mobile-model>${routing.state.catalog.filter(m => m.nativeProviderId === "openai").map(m => `<option value="${esc(m.routeId)}">${esc(m.providerName)} · ${esc(m.displayName)}</option>`).join("")}</select></label><div class="cp-api-status" data-mobile-status>${threads.length ? "" : "没有需要迁移的旧任务"}</div><div class="cp-api-actions"><button class="cp-api-button" data-mobile-back>返回</button><button class="cp-api-button" data-primary="true" data-mobile-create ${threads.length ? "" : "disabled"}>创建手机可见分支</button></div></div>`;
      root.querySelector("[data-mobile-back]").onclick = () => { state.view = "list"; renderList(); };
      root.querySelector("[data-mobile-create]").onclick = async () => {
        const button = root.querySelector("[data-mobile-create]"); button.disabled = true;
        try {
          await routing.migrateLegacyThread(root.querySelector("[data-mobile-thread]").value, root.querySelector("[data-mobile-model]").value);
          close();
        } catch (error) { root.querySelector("[data-mobile-status]").textContent = error.message; }
        finally { button.disabled = false; }
      };
    } catch (error) { state.message = error.message; state.error = true; renderList(); }
  }

  function edit(provider) {
    if (provider?.kind === "subscription") { void openSubscription(); return; }
    state.view = "form";
    state.editing = provider || { id: null, name: "", baseUrl: "", protocol: "chatCompletions", enabled: true, hasApiKey: false, models: [] };
    state.models = (provider?.models || []).map((m) => ({ ...m })); state.message = ""; setSaveState("idle", provider ? "" : "填写名称、API URL 和 API Key 后自动保存"); renderForm();
  }

  function modelEditor(external = false) { return `<div class="cp-api-models">${state.models.map((m, i) => `<div class="cp-api-model"><input type="checkbox" data-model-visible="${i}" ${m.visible ? "checked" : ""}><span class="cp-api-model-id" title="${esc(m.modelId)}">${esc(m.modelId)}</span><input class="cp-api-input" data-model-name="${i}" value="${esc(m.displayName || m.modelId)}" aria-label="模型显示名称">${!external ? "" : `<input class="cp-api-input" type="number" min="1024" max="10000000" step="1" data-model-window="${i}" value="${m.contextWindow ?? ""}" placeholder="${m.matched ? "自动（官方模型）" : "必填：窗口 token"}" aria-label="上下文窗口 token"><select class="cp-api-select" data-model-tool="${i}" aria-label="工具策略"><option value="" ${m.toolMode ? "" : "selected"}>工具策略（必选）</option><option value="deferred" ${m.toolMode === "deferred" ? "selected" : ""}>延迟加载</option><option value="direct" ${m.toolMode === "direct" ? "selected" : ""}>全部内联</option></select>`}</div>`).join("")}</div>`; }

  function renderForm(draft = null) {
    const root = body(), saved = state.editing; if (!root || !saved) return;
    state.view = "form";
    const p = draft ? { ...saved, ...draft } : saved;
    root.innerHTML = `${status()}<form class="cp-api-form" data-api-form><div class="cp-api-grid"><label class="cp-api-field">名称<input class="cp-api-input" name="name" value="${esc(p.name)}" required></label><label class="cp-api-field">协议<select class="cp-api-select" name="protocol"><option value="responses" ${p.protocol === "responses" ? "selected" : ""}>Responses</option><option value="chatCompletions" ${p.protocol === "chatCompletions" ? "selected" : ""}>Chat Completions</option></select></label></div><label class="cp-api-field">API URL<input class="cp-api-input" name="baseUrl" value="${esc(p.baseUrl)}" placeholder="https://example.com/v1" required></label><label class="cp-api-field">API Key<input class="cp-api-input" name="apiKey" type="password" autocomplete="off" value="${esc(draft?.apiKey || "")}" placeholder="${p.hasApiKey ? "已保存；留空则保持不变" : "sk-…"}"></label><label class="cp-api-field"><span><input name="enabled" type="checkbox" ${p.enabled ? "checked" : ""}> 启用此 API</span></label><div class="cp-api-actions"><button type="button" class="cp-api-button" data-api-back>返回</button><button type="button" class="cp-api-button" data-api-discover>读取模型</button></div>${modelEditor(true)}<p class="cp-sub-note">改动会自动保存。</p></form>`;
    const form = root.querySelector("[data-api-form]");
    root.querySelector("[data-api-back]").addEventListener("click", () => void leaveForm());
    root.querySelector("[data-api-discover]").addEventListener("click", () => void discover(form));
    form.addEventListener("submit", (event) => { event.preventDefault(); providerAutosave.schedule(0); void providerAutosave.flush(); });
    const onEdit = (event) => {
      const target = event.target;
      if (!(target instanceof window.HTMLElement) || target.closest("[data-api-back],[data-api-discover]")) return;
      const typing = event.type === "input" && target.tagName === "INPUT" && target.type !== "checkbox";
      providerAutosave.schedule(typing ? TYPING_DELAY : 0);
    };
    form.addEventListener("input", onEdit);
    form.addEventListener("change", onEdit);
  }

  async function openSubscription() {
    state.view = "subscription";
    setSaveState("idle");
    state.subscriptionLoaded = false;
    state.subscriptionBusy = true;
    state.message = "";
    state.subscription = { enabled: false, autoActivate: false, accountOrder: [], models: [], proxyUrl: "", accountReserves: {}, accountTemporary: {} };
    state.subscriptionAccounts = [];
    state.models = [];
    renderSubscription();
    try {
      const result = await invoke("/api-providers/subscription/get");
      if (state.view !== "subscription" || !document.getElementById(ROOT_ID)) return;
      state.subscriptionAccounts = result.accounts || [];
      state.subscription = normalizeSubscriptionConfig(result.config, state.subscriptionAccounts);
      state.subscriptionSaved = clone(state.subscription);
      state.models = (result.config?.models || []).map(m => ({ ...m }));
      state.subscriptionStates = subscriptionStates(result);
      state.subscriptionLoaded = true;
      void refreshUsageForAccounts(state.subscriptionAccounts);
    } catch (error) { state.message = error.message; state.error = true; }
    finally { state.subscriptionBusy = false; if (state.view === "subscription") renderSubscription(); }
  }

  function subscriptionStates(result) {
    return [...(result.accountStates || []), ...(result.blockedAccounts || []), ...(result.quotaStates || []).map(s => ({ ...s, reserve: true }))];
  }

  function reserveEditor(id, reserve, disabled) {
    const summary = [["shortTermPercent", "5h"], ["longTermPercent", "周"]].filter(([key]) => reserve?.[key] != null).map(([key, name]) => `${name} ${reserve[key]}%`).join(" · ");
    return `<details class="cp-sub-policy" data-sub-policy="reserve:${esc(id)}" ${state.expandedPolicies.has(`reserve:${id}`) ? "open" : ""}><summary>保留额度 · ${esc(summary || "不限制")}</summary><div class="cp-sub-reserve">${[["shortTermPercent", "短期保留"], ["longTermPercent", "长期保留（如每周）"]].map(([key, label]) => `<label>${label}<input class="cp-api-input" type="number" min="0" max="100" step="1" placeholder="不限制" aria-label="${label}百分比" data-sub-reserve="${key}" data-sub-reserve-account="${esc(id)}" value="${esc(reserve?.[key] ?? "")}" ${disabled ? "disabled" : ""}>%</label>`).join("")}</div></details>`;
  }

  function temporaryEditor(id, temp, disabled) {
    const legacy = [["shortTermPercent", "原 5h 使用目标"], ["longTermPercent", "原周使用目标"]].filter(([key]) => temp?.[key] != null)
      .map(([key, label]) => `<label>${label}<input class="cp-api-input" type="number" min="1" max="100" step="1" aria-label="${label}百分比" data-sub-temp="${key}" data-sub-temp-account="${esc(id)}" value="${esc(temp[key])}" ${disabled ? "disabled" : ""}>%</label>`).join("");
    const percentInputs = `<label>周剩余达到<input class="cp-api-input" type="number" min="0" max="100" step="1" placeholder="不限" aria-label="周剩余额度退出阈值" data-sub-temp="weeklyRemainingPercent" data-sub-temp-account="${esc(id)}" value="${esc(temp?.weeklyRemainingPercent ?? "")}" ${disabled ? "disabled" : ""}>% 后恢复自动</label>${legacy}`;
    const durationInput = `<label>有效时间<input class="cp-api-input" type="number" min="1" max="43200" step="1" placeholder="留空不限" aria-label="临时使用时间（分钟）" data-sub-temp="durationMinutes" data-sub-temp-account="${esc(id)}" value="${esc(temp?.durationMinutes ?? "")}" ${disabled ? "disabled" : ""}>min</label>`;
    const presetButtons = [["long", "周额度重置后恢复自动"], ...(temp?.untilReset === "short" ? [["short", "原 5h 重置条件"]] : [])]
      .map(([preset, label]) => `<button type="button" class="cp-api-button cp-sub-temp-preset" data-sub-temp-preset="${preset}" data-sub-temp-account="${esc(id)}" data-active="${temp?.untilReset === preset}" aria-pressed="${temp?.untilReset === preset}" ${disabled ? "disabled" : ""}>${label}</button>`)
      .join("");
    return `<details class="cp-sub-policy" data-sub-policy="exit:${esc(id)}" ${state.expandedPolicies.has(`exit:${id}`) ? "open" : ""}><summary data-sub-exit-summary="${esc(id)}">退出条件 · ${esc(temporaryHintText(id, temp) || "手动移除前保持优先")}</summary><div class="cp-sub-temp"><div class="cp-sub-temp-row">${percentInputs}</div><div class="cp-sub-temp-row">${durationInput}<div class="cp-sub-temp-presets">${presetButtons}</div></div><div class="cp-sub-temp-hint" data-sub-temp-hint="${esc(id)}">${esc(temporaryHintText(id, temp) || "未设条件：保持优先，直到手动移除；5h 耗尽仅暂停使用。")}</div></div></details>`;
  }

  function routingInfo(id) {
    const entry = state.accountUsage.get(String(id));
    const quota = entry?.usage;
    const windows = quota ? usageWindows(quota) : [];
    const week = windows.find(w => Number(w.limit_window_seconds ?? w.limitWindowSeconds) === 604800)
      || windows.find(w => windowKind(w) === "long");
    const reset = Number(week?.reset_at ?? week?.resetAt);
    const seconds = reset - Date.now() / 1000;
    const remaining = week ? remainingPercent(week) : null;
    const score = remaining != null && seconds > 0 ? remaining * 86400 / seconds : null;
    const rate = quota?.rate_limit ?? quota?.rateLimit;
    const reserve = state.subscription?.accountReserves?.[id];
    const health = state.subscriptionStates.filter(item => item.recordId === id);
    const blocked = health.some(item => item.blocked || Number(item.retryAt) > Date.now() / 1000);
    const known = entry?.status === "ok" && windows.length > 0 && windows.every(w => {
      const resetAt = Number(w.reset_at ?? w.resetAt);
      return remainingPercent(w) != null && resetAt > Date.now() / 1000;
    });
    const exhausted = rate?.allowed === false || rate?.limit_reached === true
      || windows.some(w => remainingPercent(w) === 0);
    const reserved = windows.some(w => {
      const threshold = windowKind(w) === "short" ? reserve?.shortTermPercent : reserve?.longTermPercent;
      return threshold != null && remainingPercent(w) != null && remainingPercent(w) <= threshold;
    });
    const ready = !blocked && known && !exhausted && !reserved;
    const reason = blocked ? "暂不可用" : !known ? "额度待确认" : exhausted ? "额度耗尽，恢复后继续参与" : reserved ? "已达保留额度" : "可用";
    return { ready, score, text: `${reason}${score != null ? ` · 周评分 ${score.toFixed(1)}%/天` : " · 周评分待确认"}` };
  }

  function syncRoutingDom() {
    const root = body(), config = state.subscription;
    if (!root || state.view !== "subscription" || !config) return;
    root.querySelectorAll("[data-sub-routing]").forEach(slot => {
      slot.textContent = routingInfo(slot.dataset.subRouting).text;
    });
    const slot = root.querySelector("[data-sub-next]");
    if (!slot) return;
    const priority = config.accountPriority || [];
    const automatic = config.accountOrder.filter(id => !priority.includes(id)).sort((a, b) => (routingInfo(b).score ?? -1) - (routingInfo(a).score ?? -1));
    const next = [...priority, ...automatic].find(id => routingInfo(id).ready);
    const account = state.subscriptionAccounts.find(a => a.recordId === next);
    slot.innerHTML = !config.enabled ? "订阅 API 已停用" : next
      ? `新会话预计使用<strong>${esc(account?.email || account?.name || next)}</strong>来自${priority.includes(next) ? "额外优先池" : "自动分配池"}`
      : "新会话路由目标：等待可用账户与额度确认";
  }

  function renderSubscription() {
    const root = body(), config = state.subscription;
    if (!root || !config) return;
    state.view = "subscription";
    const busy = state.subscriptionBusy;
    const order = config.accountOrder;
    const accounts = new Map(state.subscriptionAccounts.map(a => [String(a.recordId), a]));
    const priority = config.accountPriority || [];
    const autoIds = order.filter(id => !priority.includes(id)).sort((a, b) => (routingInfo(b).score ?? -1) - (routingInfo(a).score ?? -1));
    const otherIds = [...accounts.keys()].filter(id => !order.includes(id));
    const usageLoading = anyUsageLoading();
    const row = (id) => {
      const account = accounts.get(id), index = order.indexOf(id), rank = priority.indexOf(id);
      const prioritized = rank >= 0;
      const tempActive = isTemporary(config, id);
      const info = routingInfo(id);
      const healthHtml = accountHealthItems(id).map(item => `<span class="cp-sub-health" data-kind="${esc(item.kind)}">${esc(item.text)}</span>`).join("");
      const label = account?.email || account?.name || "账户已删除，请移出";
      return `<div class="cp-sub-row" data-temp="${prioritized}" data-sub-row="${esc(id)}"><label><div class="cp-sub-row-head"><input type="checkbox" data-sub-account="${esc(id)}" aria-label="允许使用 ${esc(label)} 的额度" ${index >= 0 ? "checked" : ""} ${busy ? "disabled" : ""}><span>${prioritized ? `${rank + 1}. ` : ""}${esc(label)}${account?.plan ? ` · ${esc(account.plan)}` : ""}</span><span class="cp-sub-badge" data-kind="${prioritized ? "temp" : "pool"}">${index < 0 ? "未参与" : prioritized ? "优先" : "自动"}</span></div>${healthHtml}<span class="cp-sub-health" data-sub-routing="${esc(id)}">${esc(info.text)}</span></label><div class="cp-sub-row-actions">${account ? `<button type="button" class="cp-api-button" data-sub-temp-toggle="${esc(id)}" aria-label="${prioritized ? "恢复自动分配" : "加入优先池"} ${esc(label)}" ${busy ? "disabled" : ""}>${prioritized ? "× 恢复自动" : "加入优先池"}</button>` : ""}${prioritized ? `<button type="button" class="cp-api-button" data-sub-up="${esc(id)}" aria-label="上移账户 ${esc(label)}" ${busy || rank <= 0 ? "disabled" : ""}>↑</button><button type="button" class="cp-api-button" data-sub-down="${esc(id)}" aria-label="下移账户 ${esc(label)}" ${busy || rank === priority.length - 1 ? "disabled" : ""}>↓</button>` : ""}</div>${account ? `<div class="cp-sub-usage" data-sub-usage-account="${esc(id)}">${accountUsageMarkup(id)}</div>` : ""}${account && prioritized ? temporaryEditor(id, config.accountTemporary?.[id], busy) : ""}${account ? reserveEditor(id, config.accountReserves?.[id], busy || index < 0) : ""}</div>`;
    };
    const group = (title, ids, hint) => `<section class="cp-sub-group"><div class="cp-api-actions"><strong>${title} <span class="cp-sub-count">${ids.length}</span></strong><span>${hint}</span></div><div class="cp-api-list">${ids.length ? ids.map(row).join("") : '<div class="cp-api-row cp-sub-note">暂无账户</div>'}</div></section>`;
    root.innerHTML = `${status()}<div class="cp-api-form"><div class="cp-api-actions"><strong>账号路由管理</strong><label><input type="checkbox" data-sub-enabled ${config.enabled ? "checked" : ""} ${busy ? "disabled" : ""}> 启用订阅 API</label></div><div class="cp-sub-next" data-sub-next></div><div class="cp-api-actions"><label class="cp-sub-note"><input type="checkbox" data-sub-force-priority ${config.forcePriority ? "checked" : ""} ${busy ? "disabled" : ""}> 强制优先（覆盖已有会话的账户绑定）</label><button type="button" class="cp-api-button" data-sub-refresh-usage ${busy || usageLoading || !state.subscriptionAccounts.length ? "disabled" : ""}>${usageLoading ? "刷新中…" : "刷新额度"}</button></div><p class="cp-sub-note">默认只为新会话选账户，已有会话沿用原账户。5h 额度负责可用性，自动分配按周剩余额度 ÷ 距重置天数排序。</p>${group("额外优先池", priority, "按手动顺序使用")}${group("自动分配池", autoIds, "按周额度评分排序")}${otherIds.length ? group("未参与", otherIds, "勾选后加入自动分配") : ""}<label class="cp-sub-note"><input type="checkbox" data-sub-auto-activate ${config.autoActivate ? "checked" : ""} ${busy ? "disabled" : ""}> 自动激活其他账户的 5h 计时</label><div class="cp-api-actions"><button type="button" class="cp-api-button" data-sub-accounts ${busy ? "disabled" : ""}>管理导入账户</button><span></span></div><div class="cp-api-actions"><span>模型与显示名称</span><button type="button" class="cp-api-button" data-sub-discover ${busy || !order.length ? "disabled" : ""}>${busy ? "处理中…" : "读取模型"}</button></div>${modelEditor()}<div class="cp-api-actions"><button type="button" class="cp-api-button" data-sub-back ${busy ? "disabled" : ""}>返回</button><span class="cp-sub-note">改动会自动保存。</span></div></div>`;
    syncRoutingDom();
    root.querySelectorAll("[data-sub-policy]").forEach(details => details.addEventListener("toggle", () => {
      if (details.open) state.expandedPolicies.add(details.dataset.subPolicy);
      else state.expandedPolicies.delete(details.dataset.subPolicy);
    }));
    const saveSoon = (delay = 0) => subscriptionAutosave.schedule(delay);
    root.querySelector("[data-sub-force-priority]").addEventListener("change", e => { config.forcePriority = e.target.checked; saveSoon(); });
    root.querySelector("[data-sub-auto-activate]").addEventListener("change", e => { config.autoActivate = e.target.checked; saveSoon(); });
    root.querySelector("[data-sub-enabled]").addEventListener("change", e => { config.enabled = e.target.checked; saveSoon(); });
    root.querySelectorAll("[data-sub-reserve]").forEach(input => input.addEventListener("input", () => {
      const reserve = (config.accountReserves[input.dataset.subReserveAccount] ||= {});
      const value = input.value.trim();
      reserve[input.dataset.subReserve] = value === "" ? null : Number(value);
      saveSoon(TYPING_DELAY);
    }));
    root.querySelectorAll("[data-model-visible], [data-model-name]").forEach(input => {
      input.addEventListener("input", () => { syncModels(root); saveSoon(input.type === "checkbox" ? 0 : TYPING_DELAY); });
    });
    const syncTemporaryControls = (id) => {
      const temp = config.accountTemporary[id];
      root.querySelectorAll(`[data-sub-temp-preset][data-sub-temp-account="${id}"]`).forEach((btn) => {
        const active = temp?.untilReset === btn.dataset.subTempPreset;
        btn.dataset.active = String(active);
        btn.setAttribute("aria-pressed", String(active));
      });
      const hint = root.querySelector(`[data-sub-temp-hint="${id}"]`);
      if (hint) hint.textContent = temporaryHintText(id, temp) || "未设条件：保持优先，直到手动移除；5h 耗尽仅暂停使用。";
      const summary = root.querySelector(`[data-sub-exit-summary="${id}"]`);
      if (summary) summary.textContent = `退出条件 · ${temporaryHintText(id, temp) || "手动移除前保持优先"}`;
    };
    root.querySelectorAll("[data-sub-temp]").forEach(input => input.addEventListener("input", () => {
      const id = input.dataset.subTempAccount;
      const temp = (config.accountTemporary[id] ||= {});
      const key = input.dataset.subTemp;
      const value = input.value.trim();
      temp[key] = value === "" ? null : Number(value);
      if (key === "durationMinutes" && value !== "") temp.untilReset = null;
      syncTemporaryControls(id);
      saveSoon(TYPING_DELAY);
    }));
    root.querySelectorAll("[data-sub-temp-preset]").forEach(button => button.addEventListener("click", () => {
      const id = button.dataset.subTempAccount;
      const preset = button.dataset.subTempPreset;
      const temp = (config.accountTemporary[id] ||= { shortTermPercent: null, longTermPercent: null, durationMinutes: null, untilReset: null });
      if (temp.untilReset === preset) {
        temp.untilReset = null;
      } else {
        temp.untilReset = preset;
        temp.durationMinutes = null;
        const durationInput = root.querySelector(`[data-sub-temp="durationMinutes"][data-sub-temp-account="${id}"]`);
        if (durationInput) durationInput.value = "";
      }
      syncTemporaryControls(id);
      saveSoon();
    }));
    root.querySelectorAll("[data-sub-account]").forEach(input => input.addEventListener("change", () => {
      syncModels(root);
      const id = input.dataset.subAccount;
      config.accountOrder = order.filter(item => item !== id);
      if (input.checked) config.accountOrder.push(id);
      else { delete config.accountTemporary[id]; config.accountPriority = config.accountPriority.filter(item => item !== id); }
      renderSubscription();
      saveSoon();
    }));
    root.querySelectorAll("[data-sub-temp-toggle]").forEach(button => button.addEventListener("click", () => {
      syncModels(root);
      const id = button.dataset.subTempToggle;
      if (config.accountPriority.includes(id)) {
        config.accountPriority = config.accountPriority.filter(item => item !== id);
        delete config.accountTemporary[id];
      } else {
        if (!order.includes(id)) config.accountOrder.push(id);
        config.accountPriority.push(id);
      }
      renderSubscription();
      saveSoon();
      root.querySelector(`[data-sub-temp="weeklyRemainingPercent"][data-sub-temp-account="${id}"]`)?.focus();
    }));
    const move = (id, delta) => {
      syncModels(root);
      const priorities = config.accountPriority;
      const index = priorities.indexOf(id);
      if (index < 0 || index + delta < 0 || index + delta >= priorities.length) return;
      [priorities[index], priorities[index + delta]] = [priorities[index + delta], priorities[index]];
      renderSubscription();
      saveSoon();
      root.querySelector(`[${delta < 0 ? "data-sub-up" : "data-sub-down"}="${id}"]`)?.focus();
    };
    root.querySelectorAll("[data-sub-up]").forEach(b => b.addEventListener("click", () => move(b.dataset.subUp, -1)));
    root.querySelectorAll("[data-sub-down]").forEach(b => b.addEventListener("click", () => move(b.dataset.subDown, 1)));
    root.querySelector("[data-sub-back]").addEventListener("click", async () => {
      await subscriptionAutosave.flush();
      if (state.view !== "subscription") return;
      if (state.saveState.kind === "error" && !confirm(`${state.saveState.text}\n\n仍要返回吗？未保存的改动会丢失。`)) return;
      state.subscription = null;
      state.message = "";
      renderList();
      void loadSubscriptionSnapshot();
    });
    root.querySelector("[data-sub-accounts]").addEventListener("click", () => { close(); window.__codexPlusAccounts?.open?.(); });
    root.querySelector("[data-sub-discover]").addEventListener("click", () => void discoverSubscriptionModels());
    bindUsageActions(root);
  }

  async function discoverSubscriptionModels() {
    if (state.subscriptionBusy) return;
    syncModels(body());
    const config = state.subscription;
    state.subscriptionBusy = true; state.message = ""; renderSubscription();
    try {
      const result = await invoke("/api-providers/subscription/discover", { ...config, models: state.models.map(m => ({ modelId: m.modelId, displayName: m.displayName, visible: m.visible })) });
      state.models = result.models || [];
      state.message = `读取到 ${state.models.length} 个模型。`;
      state.error = false;
      subscriptionAutosave.schedule(0);
    } catch (error) { state.message = error.message; state.error = true; }
    finally { state.subscriptionBusy = false; if (state.view === "subscription") renderSubscription(); }
  }

  // Priority is valid without an exit condition. Empty policies are not persisted.
  function subscriptionPayload(config) {
    return { payload: { ...config,
      accountOrder: config.accountOrder.slice(),
      accountPriority: (config.accountPriority || []).filter(id => config.accountOrder.includes(id)),
      accountTemporary: clone(Object.fromEntries(Object.entries(config.accountTemporary || {}).filter(([id, temp]) => config.accountPriority.includes(id) && hasTemporaryCondition(temp)))),
      accountReserves: clone(config.accountReserves || {}),
      models: state.models.map(m => ({ modelId: m.modelId, displayName: m.displayName, visible: m.visible })),
    }, pending: 0 };
  }

  async function saveSubscriptionNow() {
    const config = state.subscription;
    if (!config || !state.subscriptionLoaded) return;
    const root = body();
    if (root && state.view === "subscription") {
      for (const input of root.querySelectorAll("[data-sub-reserve], [data-sub-temp]")) {
        if (!input.checkValidity()) { setSaveState("error", `未保存：${input.getAttribute("aria-label") || "数值"}须为有效的整数范围`); return; }
      }
    }
    const { payload, pending } = subscriptionPayload(config);
    setSaveState("saving");
    try {
      const result = await invoke("/api-providers/subscription/save", payload);
      const unchanged = JSON.stringify(subscriptionPayload(config).payload) === JSON.stringify(payload);
      state.subscriptionSaved = clone(result.config || payload);
      let configChanged = false;
      if (result.config && unchanged) {
        const normalized = normalizeSubscriptionConfig(result.config, state.subscriptionAccounts);
        configChanged = JSON.stringify(normalized) !== JSON.stringify(config);
        Object.assign(config, normalized);
      }
      const previousStates = JSON.stringify(state.subscriptionStates);
      state.subscriptionStates = subscriptionStates(result);
      setSaveState("saved", pending ? "已自动保存；临时加入的账户设置退出条件后才会生效" : "");
      void refreshProvidersAfterSave();
      const active = document.activeElement;
      const editing = active && body()?.contains(active) && active.matches("input:not([type=checkbox]), select");
      if (state.view === "subscription" && (configChanged || previousStates !== JSON.stringify(state.subscriptionStates)) && !editing) renderSubscription();
    } catch (error) { setSaveState("error", `未保存：${error.message}`); }
  }

  async function refreshProvidersAfterSave() {
    try {
      state.providers = (await invoke("/api-providers/list")).providers || state.providers;
      await window.__codexPlusModelRouting?.loadCatalog?.(true);
    } catch {}
  }

  function syncModels(root) { state.models.forEach((model, i) => { model.visible = !!root.querySelector(`[data-model-visible="${i}"]`)?.checked; const windowInput = root.querySelector(`[data-model-window="${i}"]`); if (windowInput) model.contextWindow = windowInput.value ? Number(windowInput.value) : null; const toolInput = root.querySelector(`[data-model-tool="${i}"]`); if (toolInput) model.toolMode = toolInput.value || null; model.displayName = root.querySelector(`[data-model-name="${i}"]`)?.value || model.modelId; }); }
  function values(form) { const data = new FormData(form); return { id: state.editing?.id, name: String(data.get("name") || ""), baseUrl: String(data.get("baseUrl") || ""), apiKey: String(data.get("apiKey") || ""), protocol: String(data.get("protocol") || "chatCompletions"), enabled: data.get("enabled") === "on" }; }
  async function discover(form) { syncModels(form); const draft = values(form); const prior = new Map(state.models.map(m => [m.modelId, m])); try { const result = await invoke("/api-providers/discover", { providerId: draft.id, baseUrl: draft.baseUrl, apiKey: draft.apiKey }); state.models = (result.models || []).map(m => { const p = prior.get(m.modelId); return p ? { ...m, contextWindow: p.contextWindow ?? m.contextWindow, toolMode: p.toolMode ?? m.toolMode } : m; }); state.message = `读取到 ${state.models.length} 个模型。`; state.error = false; renderForm(draft); providerAutosave.schedule(0); return; } catch (e) { state.message = e.message; state.error = true; } renderForm(draft); }
  async function saveProviderNow() {
    const form = document.querySelector(`#${ROOT_ID} [data-api-form]`);
    if (!form || state.view !== "form" || !state.editing) return;
    syncModels(form);
    const draft = values(form);
    if (!draft.id && (!draft.name.trim() || !draft.baseUrl.trim() || !draft.apiKey.trim())) {
      setSaveState("idle", "填写名称、API URL 和 API Key 后自动保存");
      return;
    }
    if (!draft.name.trim() || !draft.baseUrl.trim()) { setSaveState("error", "未保存：名称和 API URL 不能为空"); return; }
    const editing = state.editing;
    const before = new Set(state.providers.map((p) => p.id));
    setSaveState("saving");
    try {
      const result = await invoke("/api-providers/save", { ...draft, models: state.models.map((m) => ({ ...m })) });
      state.providers = result.providers || [];
      if (!editing.id) {
        const created = state.providers.find((p) => !before.has(p.id) && p.kind !== "subscription");
        if (created) editing.id = created.id;
      }
      const saved = state.providers.find((p) => p.id === editing.id);
      if (saved) Object.assign(editing, { name: saved.name, baseUrl: saved.baseUrl, protocol: saved.protocol, enabled: saved.enabled, hasApiKey: saved.hasApiKey });
      setSaveState("saved");
      void window.__codexPlusModelRouting?.loadCatalog?.(true);
    } catch (e) { setSaveState("error", `未保存：${e.message}`); }
  }

  async function leaveForm() {
    await providerAutosave.flush();
    if (state.view !== "form") return;
    if (state.saveState.kind === "error" && !confirm(`${state.saveState.text}\n\n仍要返回吗？未保存的改动会丢失。`)) return;
    state.editing = null; state.message = ""; renderList();
  }
  async function removeProvider(id) { if (!confirm("删除这个 API 配置？")) return; try { const result = await invoke("/api-providers/delete", { providerId: id }); state.providers = result.providers || []; state.message = "API 配置已删除。"; state.error = false; window.__codexPlusModelRouting?.loadCatalog?.(true); } catch (e) { state.message = e.message; state.error = true; } renderList(); }
  async function loadSubscriptionSnapshot() {
    try {
      const result = await invoke("/api-providers/subscription/get", {});
      if (!document.getElementById(ROOT_ID) || state.view !== "list" || !result?.config) return;
      state.subscriptionAccounts = result.accounts || [];
      state.subscription = normalizeSubscriptionConfig(result.config, state.subscriptionAccounts);
      state.subscriptionStates = subscriptionStates(result);
      state.subscriptionLoaded = true;
      renderList();
      void refreshUsageForAccounts(state.subscriptionAccounts);
    } catch {}
  }
  async function load() {
    state.loading = true;
    state.subscriptionLoaded = false;
    renderList();
    try {
      const result = await invoke("/api-providers/list", {});
      state.providers = result.providers || [];
    } catch (e) { state.message = e.message; state.error = true; }
    state.loading = false;
    if (state.view === "list") renderList();
    if (state.view === "list" && state.providers.some(p => p.kind === "subscription")) {
      void loadSubscriptionSnapshot();
    }
  }

  function close() {
    // 关闭前把排队中的改动立刻保存；保存函数在首个 await 之前就读完页面状态。
    void subscriptionAutosave.flush();
    void providerAutosave.flush();
    state.usageGeneration += 1;
    document.getElementById(ROOT_ID)?.remove();
  }
  function openModal() {
    close(); installStyle(); state.view = "list"; state.editing = null; state.message = ""; state.error = false;
    const overlay = document.createElement("div"); overlay.id = ROOT_ID; overlay.className = "cp-api-overlay"; overlay.innerHTML = `<section class="cp-api-dialog" role="dialog" aria-modal="true" aria-labelledby="cp-api-title"><header class="cp-api-header"><div><h2 class="cp-api-title" id="cp-api-title">API 接入</h2><div class="cp-api-save-state" data-api-save-state role="status" aria-live="polite"></div></div><button class="cp-api-close" aria-label="关闭">${closeIcon()}</button></header><div class="cp-api-body" data-api-body></div></section>`;
    overlay.addEventListener("click", (event) => { if (event.target === overlay || event.target.closest(".cp-api-close")) close(); }); document.body.appendChild(overlay); void load();
  }
  function install() { installStyle(); queueScan(); if (!core.observing(OBSERVER_KEY)) state.unsubscribe = core.subscribe(OBSERVER_KEY, queueScan); }
  function destroy() { state.unsubscribe?.(); state.unsubscribe = null; state.scanQueued = false; document.querySelectorAll(`[${ITEM_ATTR}]`).forEach((node) => node.remove()); close(); document.getElementById(STYLE_ID)?.remove(); }
  async function flushSaves() { await subscriptionAutosave.flush(); await providerAutosave.flush(); }
  window.__codexPlusApi = { version: VERSION, install, destroy, open: openModal, state, flushSaves };
  install();
})();
