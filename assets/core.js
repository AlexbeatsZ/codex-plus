(() => {
  "use strict";
  // Shared by every codex-plus page script. Injected right after bridge.js.
  // The app's main world shadows bare `String`, so capture the native one.
  const String = window.String;
  const VERSION = 1;
  if (window.__codexPlusCore?.version === VERSION) return;
  window.__codexPlusCore?.destroy?.();

  const MENU_ITEM = '[role="menuitem"]';
  const subscribers = new Map();
  let observer = null;

  function text(node) {
    return String(node?.textContent || "").replace(/\s+/g, " ").trim();
  }

  function isSettings(node) {
    return /^(设置|Settings(?:\s|$))/i.test(text(node));
  }

  function isLogout(node) {
    return /^(退出登录|登出|Sign out(?:\s|$)|Log out(?:\s|$))/i.test(text(node));
  }

  // The profile menu is the one whose direct container holds both the native
  // "Settings" and "Sign out" items; the Edit menu also has a "Settings" item.
  function profileMenus(root = document) {
    const menus = [];
    for (const settings of Array.from(root.querySelectorAll(MENU_ITEM)).filter(isSettings)) {
      const parent = settings.parentElement;
      const logout = parent && Array.from(parent.children).find(isLogout);
      if (logout) menus.push({ parent, settings, logout });
    }
    return menus;
  }

  function mutationMayContainMenu(records) {
    if (!records) return true;
    return records.some((record) => {
      const target = record.target;
      if (target?.nodeType === 1 && (target.matches?.(MENU_ITEM) || target.closest?.(MENU_ITEM))) return true;
      return Array.from(record.addedNodes || []).some((node) =>
        (node.nodeType === 1 || node.nodeType === 11)
        && (node.matches?.(MENU_ITEM) || node.querySelector?.(MENU_ITEM))
      );
    });
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
    if (typeof window.codexPlusInvoke !== "function") throw new Error("codex-plus bridge 尚未就绪");
    const result = await window.codexPlusInvoke(path, payload);
    if (["failed", "error"].includes(String(result?.status || "").toLowerCase())) {
      throw new Error(result?.message || "操作失败");
    }
    return result;
  }

  // Bounded in-page diagnostics that health checks can return.
  function pushDiagnostic(list, limit, event, detail = {}) {
    list.push({ event, at: Date.now(), ...detail });
    while (list.length > limit) list.shift();
  }

  // One document observer for all menu-injecting scripts. Each subscriber
  // filters the records itself; re-subscribing with the same key replaces it.
  function subscribe(key, callback) {
    subscribers.set(key, callback);
    if (!observer) {
      observer = new MutationObserver((records) => {
        for (const listener of Array.from(subscribers.values())) {
          try { listener(records); } catch (error) { /* one script must not stop the others */ }
        }
      });
      observer.observe(document.documentElement, {
        childList: true,
        characterData: true,
        attributes: true,
        attributeFilter: ["aria-label"],
        subtree: true,
      });
    }
    return () => subscribers.delete(key);
  }

  function observing(key) {
    return !!observer && subscribers.has(key);
  }

  function destroy() {
    observer?.disconnect();
    observer = null;
    subscribers.clear();
  }

  window.__codexPlusCore = {
    version: VERSION,
    text,
    isSettings,
    isLogout,
    profileMenus,
    mutationMayContainMenu,
    escapeHtml,
    invoke,
    pushDiagnostic,
    subscribe,
    observing,
    destroy,
  };
})();
