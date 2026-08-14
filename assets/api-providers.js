(() => {
  "use strict";
  const String = window.String;
  const VERSION = 6;
  const ITEM_ATTR = "data-codex-plus-api-item";
  const ACCOUNT_ATTR = "data-codex-plus-account-item";
  const ROOT_ID = "codex-plus-api-modal";
  const STYLE_ID = "codex-plus-api-style";
  const state = { observer: null, scanQueued: false, providers: [], editing: null, models: [], loading: false, message: "", error: false };

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
      .cp-api-form { display:grid; gap:12px; }
      .cp-api-grid { display:grid; grid-template-columns:1fr 1fr; gap:10px; }
      .cp-api-field { display:grid; gap:6px; color:var(--cp-text); font-size:12px; }
      .cp-api-input,.cp-api-select { box-sizing:border-box; width:100%; min-height:34px; border:1px solid var(--cp-border); border-radius:8px; padding:7px 9px; color:var(--cp-text); background:#181819; }
      .cp-api-input:focus,.cp-api-select:focus { border-color:var(--cp-accent); outline:0; box-shadow:0 0 0 2px rgba(51,156,255,.16); }
      .cp-api-select { color-scheme:dark; }
      .cp-api-select option { color:var(--cp-text); background:var(--cp-bg); }
      .cp-api-models { max-height:310px; overflow:auto; border:1px solid var(--cp-border); border-radius:10px; background:var(--cp-surface); }
      .cp-api-model { display:grid; grid-template-columns:auto minmax(120px,1fr) minmax(160px,1fr); align-items:center; gap:8px; border:0; border-bottom:1px solid var(--cp-divider); padding:8px 10px; }
      .cp-api-model:last-child { border-bottom:0; }
      .cp-api-model-id { overflow:hidden; text-overflow:ellipsis; color:var(--cp-muted); font:11px ui-monospace,monospace; }
      .cp-api-status { margin-bottom:10px; border:1px solid rgba(51,156,255,.36); border-radius:8px; padding:8px 10px; color:#8cc9ff; background:var(--cp-surface); font-size:12px; }
      .cp-api-status[data-error="true"] { border-color:rgba(248,113,113,.4); color:#fca5a5; }
      .cp-api-empty { margin-top:12px; padding:60px 10px; border:1px solid var(--cp-border); border-radius:12px; color:var(--cp-muted); background:var(--cp-surface); text-align:center; font-size:13px; }
      .cp-api-close:focus-visible,.cp-api-button:focus-visible { outline:2px solid var(--cp-accent); outline-offset:2px; }
      html.light .cp-api-dialog,html[data-theme="light"] .cp-api-dialog { --cp-bg:#fff; --cp-surface:#f7f7f8; --cp-surface-hover:#ececef; --cp-border:#dedee1; --cp-divider:#e7e7e9; --cp-text:#202123; --cp-muted:#6e6e75; --cp-button:#fff; color-scheme:light; box-shadow:0 24px 64px rgba(0,0,0,.2); }
      html.light .cp-api-input,html.light .cp-api-select,html[data-theme="light"] .cp-api-input,html[data-theme="light"] .cp-api-select { background:#fff; }
      html.light .cp-api-select,html[data-theme="light"] .cp-api-select { color-scheme:light; }
      @media(max-width:600px) { .cp-api-overlay{padding:8px}.cp-api-dialog{max-height:calc(100vh - 16px)}.cp-api-grid{grid-template-columns:1fr}.cp-api-model{grid-template-columns:auto 1fr}.cp-api-model-id{grid-column:2}.cp-api-row{grid-template-columns:1fr} }
    `;
    document.head.appendChild(style);
  }

  function text(node) { return String(node?.textContent || "").replace(/\s+/g, " ").trim(); }
  function settings(node) { return /^(设置|Settings(?:\s|$))/i.test(text(node)); }
  function logout(node) { return /^(退出登录|登出|Sign out(?:\s|$)|Log out(?:\s|$))/i.test(text(node)); }
  function esc(value) { return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;"); }
  async function invoke(path, payload = {}) { const result = await window.codexPlusInvoke(path, payload); if (["failed","error"].includes(String(result?.status || "").toLowerCase())) throw new Error(result?.message || "操作失败"); return result; }

  function createItem(template) {
    const item = template.cloneNode(false); item.removeAttribute("id"); item.removeAttribute("aria-haspopup"); item.removeAttribute("data-state");
    item.setAttribute(ITEM_ATTR, "true"); item.setAttribute("role", "menuitem"); item.setAttribute("aria-label", "API 接入"); item.tabIndex = -1; item.classList.add("codex-plus-api-menu-item");
    item.innerHTML = `<div class="cp-api-menu-row">${cableIcon()}<div>API 接入</div></div>`;
    item.addEventListener("click", (event) => { event.preventDefault(); event.stopPropagation(); openModal(); }, true);
    return item;
  }

  function scan() {
    for (const item of [...document.querySelectorAll('[role="menuitem"]')].filter(settings)) {
      const parent = item.parentElement;
      if (!parent || ![...parent.children].some(logout) || parent.querySelector(`:scope > [${ITEM_ATTR}]`)) continue;
      const api = createItem(item); const account = parent.querySelector(`:scope > [${ACCOUNT_ATTR}]`);
      if (account) parent.insertBefore(api, account); else item.insertAdjacentElement("afterend", api);
    }
  }

  function mutationMayContainMenu(records) {
    if (!records) return true;
    return records.some((record) => {
      const target = record.target;
      if (target?.nodeType === 1 && (target.matches?.('[role="menuitem"]') || target.closest?.('[role="menuitem"]'))) return true;
      return Array.from(record.addedNodes || []).some((node) =>
        (node.nodeType === 1 || node.nodeType === 11)
        && (node.matches?.('[role="menuitem"]') || node.querySelector?.('[role="menuitem"]'))
      );
    });
  }

  function queueScan(records) {
    if (!mutationMayContainMenu(records) || state.scanQueued) return;
    state.scanQueued = true;
    queueMicrotask(() => {
      state.scanQueued = false;
      scan();
    });
  }

  function status() { return state.message ? `<div class="cp-api-status" data-error="${state.error}">${esc(state.message)}</div>` : ""; }
  function body() { return document.querySelector(`#${ROOT_ID} [data-api-body]`); }
  function renderList() {
    const root = body(); if (!root) return;
    root.innerHTML = `${status()}<div class="cp-api-toolbar"><span>${state.loading ? "正在读取…" : `已配置 ${state.providers.length} 个 API`}</span><button class="cp-api-button" data-api-new data-primary="true">添加 API</button></div>${state.providers.length ? `<div class="cp-api-list">${state.providers.map((p) => `<div class="cp-api-row"><div><div class="cp-api-name">${esc(p.name)}${p.enabled ? "" : " · 已停用"}</div><div class="cp-api-meta">${esc(p.baseUrl)} · ${esc(p.protocol)} · ${p.models.filter((m) => m.visible).length} 个模型</div></div><div><button class="cp-api-button" data-api-edit="${esc(p.id)}">编辑</button> <button class="cp-api-button" data-danger="true" data-api-delete="${esc(p.id)}">删除</button></div></div>`).join("")}</div>` : '<div class="cp-api-empty">尚未接入 API。支持 OpenAI 兼容的 Responses 与 Chat Completions。</div>'}`;
    root.querySelector("[data-api-new]")?.addEventListener("click", () => edit(null));
    root.querySelectorAll("[data-api-edit]").forEach((button) => button.addEventListener("click", () => edit(state.providers.find((p) => p.id === button.dataset.apiEdit))));
    root.querySelectorAll("[data-api-delete]").forEach((button) => button.addEventListener("click", () => void removeProvider(button.dataset.apiDelete)));
  }

  function edit(provider) {
    state.editing = provider || { id: null, name: "", baseUrl: "", protocol: "chatCompletions", enabled: true, hasApiKey: false, models: [] };
    state.models = (provider?.models || []).map((m) => ({ ...m })); state.message = ""; renderForm();
  }

  function renderForm(draft = null) {
    const root = body(), saved = state.editing; if (!root || !saved) return;
    const p = draft ? { ...saved, ...draft } : saved;
    root.innerHTML = `${status()}<form class="cp-api-form" data-api-form><div class="cp-api-grid"><label class="cp-api-field">名称<input class="cp-api-input" name="name" value="${esc(p.name)}" required></label><label class="cp-api-field">协议<select class="cp-api-select" name="protocol"><option value="responses" ${p.protocol === "responses" ? "selected" : ""}>Responses</option><option value="chatCompletions" ${p.protocol === "chatCompletions" ? "selected" : ""}>Chat Completions</option></select></label></div><label class="cp-api-field">API URL<input class="cp-api-input" name="baseUrl" value="${esc(p.baseUrl)}" placeholder="https://example.com/v1" required></label><label class="cp-api-field">API Key<input class="cp-api-input" name="apiKey" type="password" autocomplete="off" value="${esc(draft?.apiKey || "")}" placeholder="${p.hasApiKey ? "已保存；留空则保持不变" : "sk-…"}"></label><label class="cp-api-field"><span><input name="enabled" type="checkbox" ${p.enabled ? "checked" : ""}> 启用此 API</span></label><div class="cp-api-actions"><button type="button" class="cp-api-button" data-api-back>返回</button><button type="button" class="cp-api-button" data-api-discover>读取模型</button></div><div class="cp-api-models">${state.models.map((m, i) => `<div class="cp-api-model"><input type="checkbox" data-model-visible="${i}" ${m.visible ? "checked" : ""}><span class="cp-api-model-id" title="${esc(m.modelId)}">${esc(m.modelId)}</span><input class="cp-api-input" data-model-name="${i}" value="${esc(m.displayName || m.modelId)}" aria-label="模型显示名称"></div>`).join("")}</div><div class="cp-api-actions"><span></span><button class="cp-api-button" data-primary="true" type="submit">保存</button></div></form>`;
    const form = root.querySelector("[data-api-form]");
    root.querySelector("[data-api-back]").addEventListener("click", () => { state.editing = null; state.message = ""; renderList(); });
    root.querySelector("[data-api-discover]").addEventListener("click", () => void discover(form));
    form.addEventListener("submit", (event) => { event.preventDefault(); void save(form); });
  }

  function syncModels(root) { state.models.forEach((model, i) => { model.visible = !!root.querySelector(`[data-model-visible="${i}"]`)?.checked; model.displayName = root.querySelector(`[data-model-name="${i}"]`)?.value || model.modelId; }); }
  function values(form) { const data = new FormData(form); return { id: state.editing?.id, name: String(data.get("name") || ""), baseUrl: String(data.get("baseUrl") || ""), apiKey: String(data.get("apiKey") || ""), protocol: String(data.get("protocol") || "chatCompletions"), enabled: data.get("enabled") === "on" }; }
  async function discover(form) { syncModels(form); const draft = values(form); try { const result = await invoke("/api-providers/discover", { providerId: draft.id, baseUrl: draft.baseUrl, apiKey: draft.apiKey }); state.models = result.models || []; state.message = `读取到 ${state.models.length} 个模型。`; state.error = false; } catch (e) { state.message = e.message; state.error = true; } renderForm(draft); }
  async function save(form) { syncModels(form); const draft = values(form); try { const result = await invoke("/api-providers/save", { ...draft, models: state.models }); state.providers = result.providers || []; state.editing = null; state.message = "API 配置已保存。"; state.error = false; await window.__codexPlusModelRouting?.loadCatalog?.(true); renderList(); } catch (e) { state.message = e.message; state.error = true; renderForm(draft); } }
  async function removeProvider(id) { if (!confirm("删除这个 API 配置？")) return; try { const result = await invoke("/api-providers/delete", { providerId: id }); state.providers = result.providers || []; state.message = "API 配置已删除。"; state.error = false; window.__codexPlusModelRouting?.loadCatalog?.(true); } catch (e) { state.message = e.message; state.error = true; } renderList(); }
  async function load() { state.loading = true; renderList(); try { const result = await invoke("/api-providers/list", {}); state.providers = result.providers || []; } catch (e) { state.message = e.message; state.error = true; } state.loading = false; renderList(); }

  function close() { document.getElementById(ROOT_ID)?.remove(); }
  function openModal() {
    close(); installStyle(); state.editing = null; state.message = ""; state.error = false;
    const overlay = document.createElement("div"); overlay.id = ROOT_ID; overlay.className = "cp-api-overlay"; overlay.innerHTML = `<section class="cp-api-dialog" role="dialog" aria-modal="true" aria-labelledby="cp-api-title"><header class="cp-api-header"><div><h2 class="cp-api-title" id="cp-api-title">API 接入</h2><p class="cp-api-subtitle">多个 OpenAI 兼容 API 可同时使用；密钥不会回显。</p></div><button class="cp-api-close" aria-label="关闭">${closeIcon()}</button></header><div class="cp-api-body" data-api-body></div></section>`;
    overlay.addEventListener("click", (event) => { if (event.target === overlay || event.target.closest(".cp-api-close")) close(); }); document.body.appendChild(overlay); void load();
  }
  function install() { installStyle(); queueScan(); if (!state.observer) { state.observer = new MutationObserver(queueScan); state.observer.observe(document.documentElement, { childList: true, subtree: true }); } }
  function destroy() { state.observer?.disconnect(); state.observer = null; state.scanQueued = false; document.querySelectorAll(`[${ITEM_ATTR}]`).forEach((node) => node.remove()); close(); document.getElementById(STYLE_ID)?.remove(); }
  window.__codexPlusApi = { version: VERSION, install, destroy, open: openModal, state };
  install();
})();
