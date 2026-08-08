(() => {
  "use strict";
  const String = window.String;
  const VERSION = 3;
  const ITEM_ATTR = "data-codex-plus-api-item";
  const ACCOUNT_ATTR = "data-codex-plus-account-item";
  const ROOT_ID = "codex-plus-api-modal";
  const STYLE_ID = "codex-plus-api-style";
  const state = { observer: null, providers: [], editing: null, models: [], loading: false, message: "", error: false };

  if (window.__codexPlusApi?.version === VERSION) { window.__codexPlusApi.install(); return; }
  window.__codexPlusApi?.destroy?.();

  function cableIcon() {
    return `<svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 19h1a4 4 0 0 0 0-8h-1"></path><path d="M7 5H6a4 4 0 0 0 0 8h1"></path><line x1="8" x2="16" y1="12" y2="12"></line></svg>`;
  }

  function installStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style"); style.id = STYLE_ID;
    style.textContent = `
      .codex-plus-api-menu-item .cp-api-menu-row{display:flex!important;width:100%!important;min-width:0;flex-direction:row!important;align-items:center!important;gap:6px!important;white-space:nowrap!important}.codex-plus-api-menu-item svg{flex:0 0 auto;opacity:.75}.cp-api-overlay{position:fixed;inset:0;z-index:2147483001;display:grid;place-items:center;padding:20px;background:rgba(0,0,0,.58);backdrop-filter:blur(3px)}.cp-api-dialog{width:min(760px,calc(100vw - 28px));max-height:min(760px,calc(100vh - 28px));display:flex;flex-direction:column;overflow:hidden;border:1px solid rgba(255,255,255,.13);border-radius:14px;color:#f4f4f5;background:#18181b;box-shadow:0 24px 80px rgba(0,0,0,.45);font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}.cp-api-header{display:flex;align-items:flex-start;justify-content:space-between;padding:18px 20px 14px}.cp-api-title{margin:0;font-size:18px}.cp-api-subtitle{margin:4px 0 0;color:#a1a1aa;font-size:12px}.cp-api-close{border:0;border-radius:8px;padding:3px 9px;color:#aaa;background:transparent;font-size:22px;cursor:pointer}.cp-api-body{padding:16px 20px 20px;overflow:auto}.cp-api-toolbar,.cp-api-actions{display:flex;justify-content:space-between;gap:10px}.cp-api-list{display:grid;gap:9px;margin-top:12px}.cp-api-row{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:12px;border:1px solid rgba(255,255,255,.11);border-radius:10px;padding:12px;background:rgba(255,255,255,.025)}.cp-api-name{font-size:14px;font-weight:650}.cp-api-meta{margin-top:4px;color:#a1a1aa;font-size:12px;overflow:hidden;text-overflow:ellipsis}.cp-api-button{border:1px solid rgba(255,255,255,.18);border-radius:8px;padding:7px 11px;color:inherit;background:rgba(255,255,255,.06);cursor:pointer;font-size:12px}.cp-api-button[data-primary="true"]{border-color:#10a37f;background:#10a37f;color:#fff}.cp-api-button[data-danger="true"]{color:#fca5a5}.cp-api-button:disabled{opacity:.5;cursor:not-allowed}.cp-api-form{display:grid;gap:12px}.cp-api-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}.cp-api-field{display:grid;gap:6px;color:#d4d4d8;font-size:12px}.cp-api-input,.cp-api-select{box-sizing:border-box;width:100%;border:1px solid rgba(255,255,255,.14);border-radius:8px;padding:9px 10px;color:inherit;background:rgba(0,0,0,.22)}.cp-api-select{color-scheme:dark}.cp-api-select option{color:#f4f4f5;background:#18181b}.cp-api-models{display:grid;gap:7px;max-height:310px;overflow:auto}.cp-api-model{display:grid;grid-template-columns:auto minmax(120px,1fr) minmax(160px,1fr);align-items:center;gap:8px;border:1px solid rgba(255,255,255,.09);border-radius:8px;padding:8px}.cp-api-model-id{overflow:hidden;text-overflow:ellipsis;color:#a1a1aa;font:11px ui-monospace,monospace}.cp-api-status{margin-bottom:12px;border:1px solid rgba(52,211,153,.35);border-radius:8px;padding:9px 11px;color:#6ee7b7;font-size:12px}.cp-api-status[data-error="true"]{border-color:rgba(248,113,113,.4);color:#fca5a5}.cp-api-empty{padding:60px 10px;text-align:center;color:#a1a1aa;font-size:13px}html.light .cp-api-dialog,html[data-theme="light"] .cp-api-dialog{color:#18181b;background:#fff;border-color:#e4e4e7}html.light .cp-api-row,html.light .cp-api-model,html[data-theme="light"] .cp-api-row,html[data-theme="light"] .cp-api-model{border-color:#e4e4e7;background:#fafafa}html.light .cp-api-input,html.light .cp-api-select,html[data-theme="light"] .cp-api-input,html[data-theme="light"] .cp-api-select{border-color:#d4d4d8;background:#fff}html.light .cp-api-select,html[data-theme="light"] .cp-api-select{color-scheme:light}html.light .cp-api-select option,html[data-theme="light"] .cp-api-select option{color:#18181b;background:#fff}@media(max-width:600px){.cp-api-grid{grid-template-columns:1fr}.cp-api-model{grid-template-columns:auto 1fr}.cp-api-model-id{grid-column:2}.cp-api-row{grid-template-columns:1fr}}
    `;
    document.head.appendChild(style);
  }

  function text(node) { return String(node?.textContent || "").replace(/\s+/g, " ").trim(); }
  function settings(node) { return /^(设置|Settings(?:\s|$))/i.test(text(node)); }
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
      const parent = item.parentElement; if (!parent || parent.querySelector(`:scope > [${ITEM_ATTR}]`)) continue;
      const api = createItem(item); const account = parent.querySelector(`:scope > [${ACCOUNT_ATTR}]`);
      if (account) parent.insertBefore(api, account); else item.insertAdjacentElement("afterend", api);
    }
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
    const overlay = document.createElement("div"); overlay.id = ROOT_ID; overlay.className = "cp-api-overlay"; overlay.innerHTML = `<section class="cp-api-dialog" role="dialog" aria-modal="true" aria-labelledby="cp-api-title"><header class="cp-api-header"><div><h2 class="cp-api-title" id="cp-api-title">API 接入</h2><p class="cp-api-subtitle">多个 OpenAI 兼容 API 可同时使用；密钥不会回显。</p></div><button class="cp-api-close" aria-label="关闭">×</button></header><div class="cp-api-body" data-api-body></div></section>`;
    overlay.addEventListener("click", (event) => { if (event.target === overlay || event.target.closest(".cp-api-close")) close(); }); document.body.appendChild(overlay); void load();
  }
  function install() { installStyle(); scan(); if (!state.observer) { state.observer = new MutationObserver(scan); state.observer.observe(document.documentElement, { childList: true, subtree: true }); } }
  function destroy() { state.observer?.disconnect(); state.observer = null; document.querySelectorAll(`[${ITEM_ATTR}]`).forEach((node) => node.remove()); close(); document.getElementById(STYLE_ID)?.remove(); }
  window.__codexPlusApi = { version: VERSION, install, destroy, open: openModal, state };
  install();
})();
