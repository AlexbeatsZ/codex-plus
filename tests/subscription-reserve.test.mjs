import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { JSDOM } from "jsdom";

const coreScript = await readFile(new URL("../assets/core.js", import.meta.url), "utf8");
const script = await readFile(new URL("../assets/api-providers.js", import.meta.url), "utf8");
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setTimeout(resolve, 0)); };

async function setup(config = {}, quotaStates = [], usages = {}) {
  const saves = [];
  const dom = new JSDOM("<!doctype html><html><head><style>input { appearance:none }</style></head><body></body></html>", { runScripts: "dangerously", url: "app://-/index.html" });
  dom.window.codexPlusInvoke = async (path, payload) => {
    if (path === "/api-providers/list") return { status: "ok", providers: [{ id: "chatgpt-subscription", kind: "subscription", name: "ChatGPT 订阅", enabled: true, models: [] }] };
    if (path === "/api-providers/subscription/get") return {
      status: "ok", config: { enabled: true, accountPriority: ["a", "b"], accountOrder: ["a", "b"], models: [], proxyUrl: "", ...config },
      accounts: [{ recordId: "a", email: "a@example.test" }, { recordId: "b", email: "b@example.test" }], quotaStates,
    };
    if (path === "/accounts/usage") return { status: "ok", usage: usages[payload.recordId] };
    if (path === "/api-providers/subscription/save") { saves.push(structuredClone(payload)); return { status: "ok", config: payload }; }
    return { status: "ok", models: [] };
  };
  dom.window.eval(coreScript);
  dom.window.eval(script);
  dom.window.__codexPlusApi.open(); await flush();
  dom.window.document.querySelector('[data-api-edit="chatgpt-subscription"]').click(); await flush();
  const input = (id, key) => dom.window.document.querySelector(`[data-sub-reserve-account="${id}"][data-sub-reserve="${key}"]`);
  const set = (id, key, value) => { const node = input(id, key); node.value = value; node.dispatchEvent(new dom.window.Event("input", { bubbles: true })); };
  return { dom, saves, input, set };
}

test("auto activation defaults off, persists through reorder and saves explicit opt-in", async () => {
  const { dom, saves } = await setup();
  try {
    const checkbox = () => dom.window.document.querySelector("[data-sub-auto-activate]");
    assert.equal(checkbox().checked, false);
    checkbox().checked = true;
    checkbox().dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    dom.window.document.querySelector('[data-sub-up="b"]').click();
    assert.equal(checkbox().checked, true);
    assert.doesNotMatch(dom.window.document.body.textContent, /UTC\+8|HTTP 代理/);
    await dom.window.__codexPlusApi.flushSaves(); await flush();
    assert.equal(saves.at(-1).autoActivate, true);
  } finally { dom.window.close(); }
});

test("auto activation can be disabled from an enabled configuration", async () => {
  const { dom, saves } = await setup({ autoActivate: true });
  try {
    const checkbox = dom.window.document.querySelector("[data-sub-auto-activate]");
    assert.equal(checkbox.checked, true);
    checkbox.click();
    await dom.window.__codexPlusApi.flushSaves(); await flush();
    assert.equal(saves.at(-1).autoActivate, false);
  } finally { dom.window.close(); }
});

test("legacy configs leave reserve inputs blank and each account saves independent thresholds", async () => {
  const { dom, saves, input, set } = await setup();
  try {
    assert.equal(input("a", "shortTermPercent").value, "");
    set("a", "shortTermPercent", "21"); set("a", "longTermPercent", "30"); set("b", "longTermPercent", "0");
    dom.window.document.querySelector('[data-sub-up="b"]').click();
    assert.equal(input("a", "shortTermPercent").value, "21");
    await dom.window.__codexPlusApi.flushSaves(); await flush();
    assert.deepEqual(saves.at(-1).accountOrder, ["a", "b"]);
    assert.deepEqual(saves.at(-1).accountPriority, ["b", "a"]);
    assert.deepEqual(saves.at(-1).accountReserves, { a: { shortTermPercent: 21, longTermPercent: 30 }, b: { longTermPercent: 0 } });
  } finally { dom.window.close(); }
});

test("clearing a threshold disables it and unchecking an account preserves its settings", async () => {
  const { dom, saves, input, set } = await setup({ accountReserves: { a: { shortTermPercent: 21, longTermPercent: 35 }, deleted: { longTermPercent: 90 } } });
  try {
    set("a", "shortTermPercent", "");
    dom.window.document.querySelector('[data-sub-account="a"]').click();
    assert.equal(input("a", "longTermPercent").disabled, true);
    await dom.window.__codexPlusApi.flushSaves(); await flush();
    assert.deepEqual(saves.at(-1).accountOrder, ["b"]);
    assert.deepEqual(saves.at(-1).accountReserves, { a: { shortTermPercent: null, longTermPercent: 35 } });
  } finally { dom.window.close(); }
});

test("invalid reserve percentages are blocked before any save and valid edits survive retry", async () => {
  const { dom, saves, set } = await setup();
  try {
    for (const value of ["-1", "101", "20.5"]) {
      set("a", "shortTermPercent", value);
      await dom.window.__codexPlusApi.flushSaves(); await flush();
      assert.equal(saves.length, 0);
    }
    set("a", "shortTermPercent", "100");
    await dom.window.__codexPlusApi.flushSaves(); await flush();
    assert.equal(saves.at(-1).accountReserves.a.shortTermPercent, 100);
  } finally { dom.window.close(); }
});

test("reserve status is rendered separately from cooldown timestamps", async () => {
  const { dom } = await setup({ accountReserves: { a: { longTermPercent: 21 } } }, [{ recordId: "a", status: "reserved", reason: "长期额度剩余 21.0% ≤ 保留 21%" }]);
  try {
    const text = dom.window.document.querySelector("[data-api-body]").textContent;
    assert.match(text, /长期额度剩余 21.0% ≤ 保留 21%/);
    assert.doesNotMatch(text, /Invalid Date|undefined：/);
    dom.window.document.querySelector("[data-sub-auto-activate]").click();
    await dom.window.__codexPlusApi.flushSaves(); await flush();
    assert.doesNotMatch(dom.window.document.querySelector("[data-api-body]").textContent, /长期额度剩余 21.0%/);
  } finally { dom.window.close(); }
});

test("API overview and subscription config display account quota in UTC+8 and support temporary join", async () => {
  const saves = [];
  const resetSec = Math.floor(Date.UTC(2026, 10, 19, 10, 31, 0) / 1000); // 18:31 UTC+8
  const dom = new JSDOM("<!doctype html><html><head><style>input { appearance:none }</style></head><body></body></html>", { runScripts: "dangerously", url: "app://-/index.html" });
  dom.window.codexPlusInvoke = async (path, payload) => {
    if (path === "/api-providers/list") return { status: "ok", providers: [{ id: "chatgpt-subscription", kind: "subscription", name: "ChatGPT 订阅", enabled: true, models: [] }] };
    if (path === "/api-providers/subscription/get") return {
      status: "ok",
      config: { enabled: true, accountOrder: ["a"], models: [], proxyUrl: "", accountReserves: {}, accountTemporary: {} },
      accounts: [{ recordId: "a", email: "a@example.test", plan: "plus" }, { recordId: "b", email: "b@example.test", plan: "team" }],
      quotaStates: [{ recordId: "b", status: "temporary_completed", reason: "临时额度已达标：5h 额度本次已用 30.0% ≥ 设定 30%，已自动移出额度池", temporary: true }],
      accountStates: [{ recordId: "a", model: "*", reason: "请求频率限制", retryAt: resetSec }],
    };
    if (path === "/accounts/usage") {
      return {
        status: "ok",
        usage: {
          rate_limit: {
            primary_window: { used_percent: payload.recordId === "b" ? 20 : 60, limit_window_seconds: 18000, reset_at: resetSec },
            secondary_window: { used_percent: 30, limit_window_seconds: 604800, reset_at: resetSec + 86400 },
          },
        },
      };
    }
    if (path === "/api-providers/subscription/save") {
      saves.push(structuredClone(payload));
      return { status: "ok", config: payload, quotaStates: [] };
    }
    return { status: "ok", models: [] };
  };
  try {
    dom.window.eval(coreScript);
    dom.window.eval(script);
    dom.window.__codexPlusApi.open(); await flush();
    const overview = dom.window.document.querySelector("[data-api-sub-overview]");
    assert.ok(overview);
    assert.match(overview.textContent, /5 小时额度 · 剩余 40%/);
    assert.match(overview.textContent, /5 小时额度 · 剩余 80%/);
    assert.match(overview.textContent, /11月19日 18:31/);
    assert.doesNotMatch(overview.textContent, /UTC\+8/);
    assert.match(overview.textContent, /已自动移出/);

    dom.window.document.querySelector('[data-api-edit="chatgpt-subscription"]').click(); await flush();
    const bodyText = dom.window.document.querySelector("[data-api-body]").textContent;
    assert.match(bodyText, /11月19日 18:31 后重试/);
    assert.match(bodyText, /临时额度已达标/);
    assert.doesNotMatch(bodyText, /UTC\+8|HTTP 代理/);
    assert.equal(dom.window.document.querySelector('[data-sub-proxy]'), null);

    // A priority override is immediately valid without an exit condition.
    dom.window.document.querySelector('[data-sub-temp-toggle="b"]').click();
    await dom.window.__codexPlusApi.flushSaves(); await flush();
    assert.deepEqual(saves.at(-1).accountOrder, ["a", "b"]);
    assert.deepEqual(saves.at(-1).accountPriority, ["b"]);
    assert.deepEqual(saves.at(-1).accountTemporary, {});
    assert.match(dom.window.document.body.textContent, /额外优先池|自动分配池/);
    assert.match(dom.window.document.querySelector('[data-sub-temp-hint="b"]').textContent, /直到手动移除/);

    const preset = () => dom.window.document.querySelector('[data-sub-temp-preset="long"][data-sub-temp-account="b"]');
    const duration = () => dom.window.document.querySelector('[data-sub-temp="durationMinutes"][data-sub-temp-account="b"]');
    const target = dom.window.document.querySelector('[data-sub-temp="weeklyRemainingPercent"][data-sub-temp-account="b"]');
    preset().click();
    assert.equal(preset().getAttribute("aria-pressed"), "true");
    duration().value = "45";
    duration().dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    assert.equal(preset().getAttribute("aria-pressed"), "false");
    preset().click();
    assert.equal(duration().value, "");
    target.value = "10";
    target.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    const force = dom.window.document.querySelector('[data-sub-force-priority]');
    force.click();
    await dom.window.__codexPlusApi.flushSaves(); await flush();
    assert.equal(saves.at(-1).forcePriority, true);
    assert.equal(saves.at(-1).accountTemporary.b.weeklyRemainingPercent, 10);
    assert.equal(saves.at(-1).accountTemporary.b.untilReset, "long");
    assert.match(dom.window.document.querySelector('[data-sub-temp-hint="b"]').textContent, /周剩余 ≤ 10% 时恢复自动分配/);

    // Manual removal returns to automatic routing without revoking participation.
    dom.window.document.querySelector('[data-sub-temp-toggle="b"]').click();
    await dom.window.__codexPlusApi.flushSaves(); await flush();
    assert.deepEqual(saves.at(-1).accountOrder, ["a", "b"]);
    assert.deepEqual(saves.at(-1).accountPriority, []);
    assert.deepEqual(saves.at(-1).accountTemporary, {});
  } finally { dom.window.close(); }
});

test("every subscription change is saved automatically without a save button", async () => {
  const { dom, saves, set } = await setup();
  try {
    assert.equal(dom.window.document.querySelector("[data-sub-save]"), null);
    dom.window.document.querySelector('[data-sub-up="b"]').click();
    await flush();
    assert.equal(saves.length, 1);
    assert.deepEqual(saves[0].accountOrder, ["a", "b"]);
    assert.deepEqual(saves[0].accountPriority, ["b", "a"]);
    assert.match(dom.window.document.querySelector("[data-api-save-state]").textContent, /已自动保存/);
    set("a", "shortTermPercent", "15");
    await flush();
    assert.equal(saves.length, 1, "typing is debounced");
    await dom.window.__codexPlusApi.flushSaves();
    assert.equal(saves.length, 2);
    assert.equal(saves[1].accountReserves.a.shortTermPercent, 15);
    dom.window.document.querySelector('[data-sub-account="b"]').click();
    await flush();
    assert.deepEqual(saves.at(-1).accountOrder, ["a"]);
  } finally { dom.window.close(); }
});

test("a pending change is saved when the dialog closes", async () => {
  const { dom, saves, set } = await setup();
  try {
    set("b", "longTermPercent", "40");
    dom.window.document.querySelector(".cp-api-close").click();
    await flush();
    assert.equal(saves.at(-1).accountReserves.b.longTermPercent, 40);
  } finally { dom.window.close(); }
});

test("external API edits save automatically once required fields are filled", async () => {
  const saves = [];
  let providers = [];
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { runScripts: "dangerously", url: "app://-/index.html" });
  dom.window.codexPlusInvoke = async (path, payload) => {
    if (path === "/api-providers/list") return { status: "ok", providers };
    if (path === "/api-providers/save") {
      saves.push(structuredClone(payload));
      const id = payload.id || "p1";
      providers = [{ id, name: payload.name, baseUrl: payload.baseUrl, protocol: payload.protocol, enabled: payload.enabled, hasApiKey: true, models: [] }];
      return { status: "ok", providers };
    }
    return { status: "ok", models: [] };
  };
  try {
    dom.window.eval(coreScript);
    dom.window.eval(script);
    dom.window.__codexPlusApi.open(); await flush();
    dom.window.document.querySelector("[data-api-new]").click();
    const field = (name) => dom.window.document.querySelector(`[data-api-form] [name="${name}"]`);
    const type = (name, value) => { field(name).value = value; field(name).dispatchEvent(new dom.window.Event("input", { bubbles: true })); };
    type("name", "Demo");
    await dom.window.__codexPlusApi.flushSaves();
    assert.equal(saves.length, 0, "a new API waits for name, URL and key");
    type("baseUrl", "https://example.test/v1");
    type("apiKey", "sk-test");
    await dom.window.__codexPlusApi.flushSaves(); await flush();
    assert.equal(saves.length, 1);
    assert.equal(saves[0].id, null);
    type("name", "Demo 2");
    await dom.window.__codexPlusApi.flushSaves(); await flush();
    assert.equal(saves.length, 2);
    assert.equal(saves[1].id, "p1", "later edits update the created API instead of creating another");
    assert.equal(saves[1].name, "Demo 2");
    assert.equal(dom.window.document.querySelector('[data-api-form] button[type="submit"]'), null);
  } finally { dom.window.close(); }
});


test("automatic pool ranks weekly quotas, previews new sessions and keeps exhausted priority accounts", async () => {
  const now = Math.floor(Date.now() / 1000);
  const usage = (short, week, days) => ({ rate_limit: {
    primary_window: { used_percent: short, limit_window_seconds: 18000, reset_at: now + 3600 },
    secondary_window: { used_percent: week, limit_window_seconds: 604800, reset_at: now + days * 86400 },
  } });
  const { dom, saves } = await setup({ accountPriority: [] }, [], { a: usage(20, 40, 1), b: usage(10, 20, 4) });
  try {
    const next = () => dom.window.document.querySelector('[data-sub-next]').textContent;
    assert.match(next(), /a@example.test/);
    assert.match(next(), /自动分配池/);
    assert.match(dom.window.document.querySelector('[data-sub-routing="a"]').textContent, /60.0%\/天/);
    assert.equal(dom.window.document.querySelector('[data-sub-up="a"]'), null);
    dom.window.document.querySelector('[data-sub-temp-toggle="b"]').click();
    assert.match(next(), /b@example.test/);
    assert.match(next(), /额外优先池/);
    const limit = dom.window.document.querySelector('[data-sub-temp="weeklyRemainingPercent"][data-sub-temp-account="b"]');
    limit.value = "0";
    limit.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    await dom.window.__codexPlusApi.flushSaves();
    assert.equal(saves.at(-1).accountTemporary.b.weeklyRemainingPercent, 0);
  } finally { dom.window.close(); }

  const exhausted = await setup({ accountPriority: ["b"] }, [], { a: usage(20, 40, 1), b: usage(100, 20, 4) });
  try {
    assert.match(exhausted.dom.window.document.querySelector('[data-sub-next]').textContent, /a@example.test/);
    assert.match(exhausted.dom.window.document.querySelector('[data-sub-routing="b"]').textContent, /额度耗尽，恢复后继续参与/);
    assert.ok(exhausted.dom.window.document.querySelector('[data-sub-temp-toggle="b"]').textContent.includes("恢复自动"));
  } finally { exhausted.dom.window.close(); }
});
