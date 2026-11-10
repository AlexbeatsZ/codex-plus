// Run the installed client's actual quota, Reserve, and scoped-state factories
// with synthetic identities and quota. No desktop process or network is used.
import assert from "node:assert/strict";
import fs from "node:fs";
import { JSDOM } from "jsdom";

const asar = process.argv[2] || "/Applications/ChatGPT.app/Contents/Resources/app.asar";
const fd = fs.openSync(asar, "r"), prefix = Buffer.alloc(16);
fs.readSync(fd, prefix, 0, 16, 0);
const headerBuffer = Buffer.alloc(prefix.readUInt32LE(12));
fs.readSync(fd, headerBuffer, 0, headerBuffer.length, 16);
const header = JSON.parse(headerBuffer.toString());
const factories = {};
function walk(node, path = "") {
  for (const [name, entry] of Object.entries(node.files || {})) {
    const file = path + "/" + name;
    if (entry.files) { walk(entry, file); continue; }
    if (!file.startsWith("/webview/assets/") || !name.endsWith(".js") || entry.unpacked) continue;
    const buffer = Buffer.alloc(Number(entry.size));
    fs.readSync(fd, buffer, 0, buffer.length, 8 + prefix.readUInt32LE(4) + Number(entry.offset));
    const source = buffer.toString();
    if (!source.includes("export const __webpack_modules__")) continue;
    try {
      // Only construct the chunk's module-factory table; execute no entry point.
      const modules = Function(source.replace(/export const /g, "const ") + "\nreturn __webpack_modules__;")();
      for (const [id, factory] of Object.entries(modules)) factories[id] ??= factory;
    } catch { /* runtime/entry chunks with static imports are not state modules */ }
  }
}
walk(header);
fs.closeSync(fd);
const cache = {}, overrides = {};
function require(id) {
  if (Object.hasOwn(overrides, id)) return overrides[id];
  if (cache[id]) return cache[id].exports;
  assert.equal(typeof factories[id], "function", "Missing native module " + id);
  const module = { exports: {} };
  cache[id] = module;
  factories[id](module, module.exports, require);
  return module.exports;
}
require.d = (out, getters = {}, values = {}) => {
  for (const [key, value] of Object.entries(getters)) if (!Object.hasOwn(out, key)) Object.defineProperty(out, key, { enumerable: true, get: value });
  for (const [key, value] of Object.entries(values)) if (!Object.hasOwn(out, key)) Object.defineProperty(out, key, { enumerable: true, value });
};
require.nmd = value => value;
require.o = (object, key) => Object.hasOwn(object, key);
require.n = value => { const get = value?.__esModule ? () => value.default : () => value; require.d(get, { a: get }); return get; };
require.r = value => Object.defineProperty(value, "__esModule", { value: true });
require.j = 348410;
require.m = factories;
const state = require("zTeN"), atoms = require("ouEa"), internals = require("GNwQ");
const scopeToken = state.z8("QuotaFixture");
const composer = state.z8("ComposerScope", { parent: scopeToken });
const store = atoms.y$();
function node(token, value, parent = null) {
  return {
    token, value, parent, store, key: "fixture", cachedBindings: new WeakMap(), signalBindings: new WeakMap(),
    contextVersionAtom: atoms.eU(0), debugEntries: new Set(), familyBindings: new Map(),
    familyKeysByOwner: new Map(), disposalLifecycles: new Set(), retainedScopeEntries: new Map(),
    imperativeReadAtoms: new WeakSet(), imperativeReadDepth: 0,
    autoDisposeScheduler: { schedule() {}, cancel() {} },
  };
}
const root = node(scopeToken, {});
const chain = new Map([[scopeToken.id, root]]);
const rootScope = internals.GB(scopeToken, chain, root);
const signal = value => state.vP(scopeToken, value);
const family = value => state.bD(scopeToken, () => value);
const auth = signal({ authMethod: "chatgpt", authLoading: false, accountLoading: false, authenticatedAccountId: "fixture", accountId: "fixture", userId: "user", plan: "plus", accountStructure: "personal" });
const usage = signal({ data: { account_id: "fixture", user_id: "user", plan_type: "plus", rate_limit: { allowed: false, limit_reached: true, primary_window: { used_percent: 100, limit_window_seconds: 18000, reset_at: 2000000000 } } } });
const conversation = family(null), pending = family(null), location = family({ hostId: "local", cwd: "/fixture" });
const config = family({ data: { model: "official" } });
Object.assign(overrides, {
  OWtl: { u: scopeToken }, Sd8U: { PR: composer, fC: state.un(composer, ({ scope }) => scope.value.clientThreadId) }, tl5a: { aG: conversation },
  an0a: { XH: location }, Eklu: { EX: pending }, YWOa: { J8: config },
  SPnB: { PO: auth }, gPv1: { Ix: usage }, FQih: { qz: "gpt-reserve" },
  x7EU: { Hw: value => value?.credits?.has_credits === true, vH: () => false },
  UR81: { Hw: () => false }, CfsC: { B: family("0.167.0") },
  jpsY: { d_: signal(true), D3: signal(true), dJ: () => true },
  oi9X: { u: family(null) }, gDxK: { Id: family(null), DZ: family([]) },
  YzhQ: { Ss: value => [{ remainingPercent: value.rate_limit.allowed ? 100 : 0, windowMinutes: 300, resetsAt: 2000000000 }] },
});
const quota = require("a6kU").U, reserve = require("eLmE");
assert.equal(rootScope.get(quota), true, "Actual native quota fixture must be exhausted");
assert.equal(rootScope.get(reserve.F9, "local"), true, "Actual native Reserve fixture must be blocked");

const dom = new JSDOM("<!doctype html><body></body>", { runScripts: "dangerously" });
try {
  const catalog = new Map([["cp-api", {}], ["cp-pool", {}]]);
  dom.window.__codexPlusModelRouting = { state: { byRoute: catalog }, refreshNativeModelQueries() {} };
  dom.window.eval(fs.readFileSync(new URL("../assets/quota-routing.js", import.meta.url), "utf8"));
  const projection = dom.window.__codexPlusQuotaRouting;
  assert.equal(projection.installRuntimeForTest(require), true);
  function context(id, model) {
    const child = node(composer, { kind: "local", conversationId: id, clientThreadId: id }, root);
    const contextChain = new Map([...chain, [composer.id, child]]);
    rootScope.set(conversation, id, { settings: { model } });
    return { child, contextChain, scope: internals.GB(composer, contextChain, child) };
  }
  const api = context("api", "cp-api"), official = context("official", "official");
  assert.equal(api.scope.get(quota), false);
  assert.equal(official.scope.get(quota), true);
  assert.equal(rootScope.get(quota), true, "Real usage/control-plane state must remain exhausted");
  assert.equal(api.scope.get(reserve.F9, "local"), false);
  assert.equal(api.scope.get(reserve.qM, "local"), false);
  assert.equal(api.scope.get(reserve.TF, "local").hardBlocked, false);
  assert.equal(official.scope.get(reserve.F9, "local"), true);
  const projectedAtom = quota.resolve(root, api.contextChain);
  const unsubscribe = store.sub(projectedAtom, () => {});
  rootScope.set(conversation, "api", { settings: { model: "official" } });
  assert.equal(store.get(projectedAtom), true);
  rootScope.set(pending, ["conversation", "api"], { model: "cp-pool" });
  assert.equal(store.get(projectedAtom), false);
  rootScope.set(pending, ["conversation", "api"], null);
  assert.equal(store.get(projectedAtom), true);
  const draft = context(null, null);
  draft.child.value.clientThreadId = "draft";
  const draftSettings = state.bD(scopeToken, () => ({ isManuallyChanged: true, modelSettings: { model: "cp-api" }, serviceTier: null }));
  rootScope.get(draftSettings, "draft");
  assert.equal(draft.scope.get(quota), false, "Actual private native draft binding must be read reactively");
  rootScope.set(draftSettings, "draft", { isManuallyChanged: true, modelSettings: { model: "official" }, serviceTier: null });
  assert.equal(draft.scope.get(quota), true);
  rootScope.set(usage, { data: {
    account_id: "fixture", user_id: "user", plan_type: "plus",
    rate_limit: { allowed: false, limit_reached: true },
    additional_rate_limits: [{ limit_name: "gpt-reserve", rate_limit: { allowed: true } }],
    rate_limit_upsell: { banner_type: "luna_reserve" },
  } });
  assert.equal(rootScope.get(reserve.qM, "local"), true);
  assert.equal(official.scope.get(reserve.qM, "local"), true);
  assert.equal(api.scope.get(reserve.qM, "local"), true);
  rootScope.set(conversation, "api", { settings: { model: "cp-api" } });
  assert.equal(api.scope.get(reserve.qM, "local"), false);
  assert.equal(rootScope.get(reserve.qM, "local"), true);
  unsubscribe();
  projection.destroy();
  console.log(JSON.stringify({ status: "passed", asar, checks: 21, factories: Object.keys(factories).length, nativeQuotaAndReserve: true, nativeScopedStore: true, networkRequests: 0 }));
} finally { dom.window.__codexPlusQuotaRouting?.destroy(); dom.window.close(); }
