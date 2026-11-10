(() => {
  "use strict";
  const VERSION = 1;
  if (window.__codexPlusQuotaRouting?.version === VERSION) return;

  const patches = [];
  const stores = new Map();
  const runtimes = new WeakSet();
  const diagnostics = [];
  let stopped = false;
  let installing = null;
  let timer = null;
  let installed = false;

  function diagnostic(event, detail = {}) {
    diagnostics.push({ event, ...detail });
    if (diagnostics.length > 30) diagnostics.shift();
  }

  function managed(model) {
    return !stopped && typeof model === "string" && window.__codexPlusModelRouting?.state?.byRoute?.has(model) === true;
  }

  function draftModel(root, id, read) {
    if (!id || !root.familyBindings) return null;
    // The native draft family is intentionally private. Locate only its bound
    // member for THIS draft, by its complete state contract, never a global pick.
    for (const [family, members] of root.familyBindings) {
      if (family.kind !== "signal-family") continue;
      const signal = members.get(id)?.value;
      if (!signal?.atom || signal.store !== root.store || typeof signal.get !== "function") continue;
      const value = signal.get();
      if (!value || typeof value !== "object" || !("isManuallyChanged" in value)
          || !("modelSettings" in value) || !("serviceTier" in value)) continue;
      return read(signal.atom)?.modelSettings?.model ?? null;
    }
    return null;
  }

  function selection(native, root, chain, node, read) {
    const scope = native.context(node.token, chain, node, read);
    const value = scope.value;
    if (!value || !["local", "new"].includes(value.kind)) return null;
    if (value.kind === "new" && value.remoteExecutionHostId) return null;
    const id = value.kind === "local" ? value.conversationId : null;
    const location = scope.get(native.location, id);
    if (!location || location.hostId !== "local") return null;
    const key = id ? ["conversation", id] : ["default", location.hostId, location.cwd ?? null];
    const pending = scope.get(native.pending, key)?.model;
    if (pending) return pending;
    if (!id) {
      const draft = draftModel(root, scope.get(native.draftIdentity), read);
      if (draft) return draft;
    }
    const conversation = id ? scope.get(native.conversation, id)?.settings?.model : null;
    if (conversation) return conversation;
    return scope.get(native.config, { hostId: location.hostId, cwd: location.cwd ?? null })?.data?.model ?? null;
  }

  function patchDescriptor(descriptor, native, project) {
    if (!descriptor || typeof descriptor.resolve !== "function" || descriptor.__codexPlusQuotaProjection) return;
    const original = descriptor.resolve;
    const atoms = new WeakMap();
    const resolve = function (root, chain, ...args) {
      const originalAtom = original.call(this, root, chain, ...args);
      const node = chain?.get?.(native.composer.id);
      if (!node || typeof root?.store?.set !== "function") return originalAtom;
      let byOriginal = atoms.get(node);
      if (!byOriginal) { byOriginal = new WeakMap(); atoms.set(node, byOriginal); }
      let atom = byOriginal.get(originalAtom);
      if (!atom) {
        let revision = stores.get(root.store);
        if (!revision) { revision = native.atom(0); stores.set(root.store, revision); }
        atom = native.atom((read) => {
          read(revision);
          // The original is still a dependency: quota refreshes, policy changes,
          // and switching back to an official model retain native semantics.
          const current = read(originalAtom);
          try {
            return managed(selection(native, root, chain, node, read)) ? project(current) : current;
          } catch { return current; }
        });
        byOriginal.set(originalAtom, atom);
      }
      return atom;
    };
    descriptor.resolve = resolve;
    descriptor.__codexPlusQuotaProjection = true;
    patches.push(() => {
      if (descriptor.resolve === resolve) descriptor.resolve = original;
      delete descriptor.__codexPlusQuotaProjection;
    });
  }

  function patchFamily(family, native, project) {
    if (!family || typeof family.resolve !== "function" || typeof family.read !== "function") return;
    const originalResolve = family.resolve;
    const originalRead = family.read;
    const prepare = (root, chain, key) => {
      const descriptor = originalResolve.call(family, root, chain, key);
      patchDescriptor(descriptor, native, project);
      return descriptor;
    };
    const resolve = function (root, chain, key) { return prepare(root, chain, key); };
    const read = function (root, chain, key, ...args) {
      prepare(root, chain, key);
      return originalRead.call(this, root, chain, key, ...args);
    };
    family.resolve = resolve;
    family.read = read;
    patches.push(() => {
      if (family.resolve === resolve) family.resolve = originalResolve;
      if (family.read === read) family.read = originalRead;
    });
  }

  function installRuntime(require) {
    if (typeof require !== "function" || !require.m || runtimes.has(require)) return false;
    // An explicit adapter for the native scoped-state contract. Check source and
    // exported capabilities before touching descriptors; unknown builds stay native.
    const source = String(require.m.a6kU || "");
    if (!["authenticatedAccountId", "accountStructure", "rate_limit", "windowMinutes"].every(part => source.includes(part))) return false;
    const reserveSource = String(require.m.eLmE || "");
    if (!["hardBlocked", "eligible", "rate_limit_upsell"].every(part => reserveSource.includes(part))) return false;
    const composerState = require("Sd8U");
    const composer = composerState.PR;
    const state = require("tl5a");
    const native = {
      atom: require("ouEa").eU,
      context: require("GNwQ").GB,
      composer,
      draftIdentity: composerState.fC,
      conversation: state.aG,
      location: require("an0a").XH,
      pending: require("Eklu").EX,
      config: require("YWOa").J8,
    };
    if (composer?.__scopeBrand !== "ComposerScope" || typeof native.atom !== "function"
        || typeof native.context !== "function"
        || ![native.draftIdentity, native.conversation, native.location, native.pending, native.config].every(value => value?.scope && typeof value.resolve === "function")) return false;
    const quota = require("a6kU").U;
    const reserve = require("eLmE");
    if (typeof quota?.resolve !== "function" || ![reserve.TF, reserve.qM, reserve.F9]
      .every(value => typeof value?.resolve === "function" && typeof value.read === "function")) return false;
    patchDescriptor(quota, native, () => false);
    patchFamily(reserve.TF, native, current => ({ ...current, active: false, eligible: false, hardBlocked: false }));
    patchFamily(reserve.qM, native, () => false);
    patchFamily(reserve.F9, native, () => false);
    runtimes.add(require);
    installed = true;
    diagnostic("native-quota-projection-installed");
    // Existing hooks need to resolve the new per-composer atoms once. Reuse the
    // model cache notification; don't edit usage data or manufacture a UI event.
    window.__codexPlusModelRouting?.refreshNativeModelQueries?.();
    return true;
  }

  async function install() {
    if (stopped || installed) return installed;
    if (installing) return installing;
    installing = (async () => {
      const root = document.getElementById("root");
      if (!root || !Object.getOwnPropertyNames(root).some(key => key.startsWith("__reactContainer$"))) return false;
      // Native-gateway clients can work even when the legacy manager discovery
      // is unavailable. Catalog loading must not depend on that discovery.
      await window.__codexPlusModelRouting?.loadCatalog?.();
      const urls = [...new Set([
        ...[...document.scripts].map(node => node.src),
        ...(performance.getEntriesByType?.("resource") || []).map(entry => entry.name),
      ])].filter(url => /\/assets\/[^/]+\.js(?:\?|$)/.test(url) && !url.includes("/async/"));
      for (const url of urls) {
        try {
          const module = await import(url);
          if (installRuntime(module.__webpack_require__)) return true;
        } catch {}
      }
      return false;
    })().catch(error => {
      diagnostic("native-quota-projection-waiting", { message: String(error?.message || error) });
      return false;
    }).finally(() => { installing = null; });
    return installing;
  }

  function refreshCatalog() {
    for (const [store, revision] of stores) store.set(revision, value => value + 1);
  }

  window.__codexPlusQuotaRouting = {
    version: VERSION,
    install,
    refreshCatalog,
    health: () => ({ installed, projections: patches.length, diagnostics: [...diagnostics] }),
    installRuntimeForTest: installRuntime,
    destroy() {
      stopped = true;
      if (timer) clearInterval(timer);
      for (const undo of patches.reverse()) undo();
      refreshCatalog();
      stores.clear();
      installed = false;
    },
  };
  void install();
  let attempts = 0;
  timer = setInterval(() => {
    if (installed || stopped || ++attempts >= 60) { clearInterval(timer); timer = null; }
    else void install();
  }, 1000);
})();
