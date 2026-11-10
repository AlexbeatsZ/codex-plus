import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { atom, createStore } from "jotai/vanilla";
import { JSDOM } from "jsdom";

const script = await readFile(new URL("../assets/quota-routing.js", import.meta.url), "utf8");

export function nativeFixture(dom, factories = {}) {
  const store = createStore();
  const root = { store, familyBindings: new Map() };
  const composer = { __scopeBrand: "ComposerScope", id: Symbol("composer") };
  const globalScope = { id: Symbol("root") };
  function signal(value) {
    const state = atom(value);
    return { scope: globalScope, resolve: () => state, state };
  }
  function family(initial, mode = "readable-family") {
    const values = new Map();
    const result = { scope: globalScope, kind: mode,
      resolve(_root, _chain, key) {
        const id = JSON.stringify(key);
        if (!values.has(id)) values.set(id, signal(typeof initial === "function" ? initial(key) : initial));
        return values.get(id);
      },
      read(root, chain, key, read) { return read(this.resolve(root, chain, key).resolve(root, chain)); },
      set(key, value) { store.set(this.resolve(root, null, key).state, value); },
    };
    return result;
  }
  const quota = signal(true);
  const draftIdentities = new WeakMap();
  const draftIdentity = { scope: composer, resolve(_root, chain) {
    const node = chain.get(composer.id);
    if (!draftIdentities.has(node)) draftIdentities.set(node, atom(node.value.resolvedDraftIdentity ?? node.value.clientThreadId));
    return draftIdentities.get(node);
  } };
  const pending = family(null), conversation = family(null);
  const location = family({ hostId: "local", cwd: "/project" });
  const config = family({ data: { model: "official" } });
  const reserve = { TF: family({ active: true, eligible: true, hardBlocked: true }), qM: family(true), F9: family(true) };
  const modules = {
    Sd8U: { PR: composer, fC: draftIdentity }, tl5a: { aG: conversation }, an0a: { XH: location },
    Eklu: { EX: pending }, YWOa: { J8: config }, a6kU: { U: quota }, eLmE: reserve,
    ouEa: { eU: atom }, GNwQ: { GB(_token, chain, node, read) {
      return { value: node.value, get(descriptor, key) {
        return descriptor.kind ? descriptor.read(root, chain, key, read) : read(descriptor.resolve(root, chain));
      } };
    } },
  };
  const require = id => modules[id];
  require.m = {
    a6kU: factories.a6kU || function () { return "authenticatedAccountId accountStructure rate_limit windowMinutes"; },
    eLmE: factories.eLmE || function () { return "hardBlocked eligible rate_limit_upsell"; },
  };
  const catalog = new Map([["cp-api", {}], ["cp-pool", {}]]);
  dom.window.__codexPlusModelRouting = { state: { byRoute: catalog }, refreshNativeModelQueries() {} };
  const controller = dom.window.__codexPlusQuotaRouting;
  const installed = controller.installRuntimeForTest(require);
  function context(id, model, extra = {}) {
    const node = { token: composer, value: { kind: "local", conversationId: id, clientThreadId: id, ...extra } };
    const chain = new Map([[composer.id, node]]);
    if (id) conversation.set(id, { settings: { model } });
    return { node, chain, read: descriptor => store.get(descriptor.resolve(root, chain)),
      readFamily: (descriptor, key = "local") => descriptor.read(root, chain, key, item => store.get(item)),
      setModel: model => conversation.set(id, { settings: { model } }),
    };
  }
  return { store, root, composer, quota, pending, conversation, location, config, reserve, controller, catalog, context, installed, require };
}

async function fixture() {
  const dom = new JSDOM("<!doctype html><body></body>", { runScripts: "dangerously" });
  dom.window.eval(script);
  const native = nativeFixture(dom);
  return { ...native, dom, close() { native.controller.destroy(); dom.window.close(); } };
}

for (const model of ["cp-api", "cp-pool"]) test("exhausted login does not disable the selected managed channel " + model, async () => {
  const f = await fixture();
  try {
    assert.equal(f.installed, true);
    const api = f.context("api-thread", model), official = f.context("official-thread", "official");
    assert.equal(api.read(f.quota), false);
    assert.equal(official.read(f.quota), true);
    assert.equal(f.store.get(f.quota.resolve(f.root, new Map())), true);
    assert.equal(f.store.get(f.quota.state), true);
  } finally { f.close(); }
});

test("native subscriptions react immediately when one conversation changes models", async () => {
  const f = await fixture();
  try {
    const a = f.context("a", "cp-api"), b = f.context("b", "cp-pool");
    const projected = f.quota.resolve(f.root, a.chain);
    const values = [];
    const unsubscribe = f.store.sub(projected, () => values.push(f.store.get(projected)));
    assert.equal(f.store.get(projected), false);
    a.setModel("official");
    assert.equal(f.store.get(projected), true);
    assert.equal(b.read(f.quota), false);
    a.setModel("cp-pool");
    assert.equal(f.store.get(projected), false);
    assert.deepEqual(values, [true, false]);
    unsubscribe();
  } finally { f.close(); }
});

test("pending native selection takes precedence over the previous turn and never reads a global picker", async () => {
  const f = await fixture();
  try {
    const a = f.context("a", "official"), b = f.context("b", "official");
    f.pending.set(["conversation", "a"], { model: "cp-api" });
    assert.equal(a.read(f.quota), false);
    assert.equal(b.read(f.quota), true);
    f.pending.set(["conversation", "a"], { model: "official" });
    assert.equal(a.read(f.quota), true);
  } finally { f.close(); }
});

test("each new draft uses its own private native model state and tracks later edits", async () => {
  const f = await fixture();
  try {
    const a = f.context(null, null, { kind: "new", homeDraftKey: "unrelated-home-key", resolvedDraftIdentity: "draft-a" });
    const b = f.context(null, null, { clientThreadId: "draft-b" });
    const draftA = atom({ isManuallyChanged: true, modelSettings: { model: "cp-api" }, serviceTier: null });
    const draftB = atom({ isManuallyChanged: true, modelSettings: { model: "official" }, serviceTier: null });
    f.root.familyBindings.set({ kind: "signal-family" }, new Map([
      ["draft-a", { value: { atom: draftA, store: f.store, get: () => f.store.get(draftA) } }],
      ["draft-b", { value: { atom: draftB, store: f.store, get: () => f.store.get(draftB) } }],
    ]));
    const projected = f.quota.resolve(f.root, a.chain);
    const unsub = f.store.sub(projected, () => {});
    assert.equal(f.store.get(projected), false);
    assert.equal(b.read(f.quota), true);
    f.store.set(draftA, value => ({ ...value, modelSettings: { model: "official" } }));
    assert.equal(f.store.get(projected), true);
    unsub();
  } finally { f.close(); }
});

test("unselected drafts inherit the native config model and explicit official selection stops fallback", async () => {
  const f = await fixture();
  try {
    const a = f.context(null, null);
    f.config.set({ hostId: "local", cwd: "/project" }, { data: { model: "cp-api" } });
    assert.equal(a.read(f.quota), false);
    f.pending.set(["default", "local", "/project"], { model: "official" });
    assert.equal(a.read(f.quota), true);
  } finally { f.close(); }
});

test("Reserve state is projected only in the managed composer's context", async () => {
  const f = await fixture();
  try {
    const api = f.context("api", "cp-api"), official = f.context("official", "official");
    assert.deepEqual({ ...api.readFamily(f.reserve.TF) }, { active: false, eligible: false, hardBlocked: false });
    for (const family of [f.reserve.qM, f.reserve.F9]) {
      assert.equal(api.readFamily(family), false);
      assert.equal(official.readFamily(family), true);
      assert.equal(f.store.get(family.resolve(f.root, new Map(), "local").resolve(f.root, new Map())), true);
    }
  } finally { f.close(); }
});

test("catalog changes revoke exemptions and unrelated policy state remains intact", async () => {
  const f = await fixture();
  try {
    const api = f.context("api", "cp-api"), projected = f.quota.resolve(f.root, api.chain);
    const unsub = f.store.sub(projected, () => {});
    assert.equal(f.store.get(projected), false);
    const policy = atom(true);
    f.catalog.delete("cp-api");
    f.controller.refreshCatalog();
    assert.equal(f.store.get(projected), true);
    assert.equal(f.store.get(policy), true);
    f.catalog.set("cp-api", {});
    f.controller.refreshCatalog();
    assert.equal(f.store.get(projected), false);
    f.controller.destroy();
    assert.equal(f.store.get(projected), true);
    unsub();
  } finally { f.close(); }
});

test("unknown, remote and nonlocal composer contexts retain native limits", async () => {
  const f = await fixture();
  try {
    assert.equal(f.context("a", "cp-deleted").read(f.quota), true);
    const remote = f.context("remote", "cp-api");
    f.location.set("remote", { hostId: "remote", cwd: "/project" });
    assert.equal(remote.read(f.quota), true);
    assert.equal(f.context(null, null, { kind: "chatgpt" }).read(f.quota), true);
  } finally { f.close(); }
});

test("unsupported native module contracts remain untouched", async () => {
  const dom = new JSDOM("<!doctype html><body></body>", { runScripts: "dangerously" });
  try {
    dom.window.eval(script);
    const f = nativeFixture(dom, { a6kU() {} });
    assert.equal(f.installed, false);
    assert.equal(f.context("a", "cp-api").read(f.quota), true);
    f.controller.destroy();
  } finally { dom.window.close(); }
});

test("catalog discovery works before legacy request-client or manager discovery", async () => {
  const dom = new JSDOM('<!doctype html><body><div id="root"></div></body>', { runScripts: "dangerously" });
  try {
    dom.window.document.getElementById("root").__reactContainer$fixture = {};
    let loads = 0;
    dom.window.__codexPlusModelRouting = { loadCatalog: async () => { loads++; } };
    dom.window.eval(script);
    await dom.window.__codexPlusQuotaRouting.install();
    assert.equal(loads, 1);
    dom.window.__codexPlusQuotaRouting.destroy();
  } finally { dom.window.close(); }
});
