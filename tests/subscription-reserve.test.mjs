import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { JSDOM } from "jsdom";

const coreScript = await readFile(new URL("../assets/core.js", import.meta.url), "utf8");
const script = await readFile(new URL("../assets/api-providers.js", import.meta.url), "utf8");
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setTimeout(resolve, 0)); };

async function setup(config = {}, quotaStates = []) {
  const saves = [];
  const dom = new JSDOM("<!doctype html><html><head><style>input { appearance:none }</style></head><body></body></html>", { runScripts: "dangerously", url: "app://-/index.html" });
  dom.window.codexPlusInvoke = async (path, payload) => {
    if (path === "/api-providers/list") return { status: "ok", providers: [{ id: "chatgpt-subscription", kind: "subscription", name: "ChatGPT 订阅", enabled: true, models: [] }] };
    if (path === "/api-providers/subscription/get") return {
      status: "ok", config: { enabled: true, accountOrder: ["a", "b"], models: [], proxyUrl: "", ...config },
      accounts: [{ recordId: "a", email: "a@example.test" }, { recordId: "b", email: "b@example.test" }], quotaStates,
    };
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
    dom.window.document.querySelector("[data-sub-save]").click(); await flush();
    assert.equal(saves[0].autoActivate, true);
  } finally { dom.window.close(); }
});

test("auto activation can be disabled from an enabled configuration", async () => {
  const { dom, saves } = await setup({ autoActivate: true });
  try {
    const checkbox = dom.window.document.querySelector("[data-sub-auto-activate]");
    assert.equal(checkbox.checked, true);
    checkbox.click();
    dom.window.document.querySelector("[data-sub-save]").click(); await flush();
    assert.equal(saves[0].autoActivate, false);
  } finally { dom.window.close(); }
});

test("legacy configs leave reserve inputs blank and each account saves independent thresholds", async () => {
  const { dom, saves, input, set } = await setup();
  try {
    assert.equal(input("a", "shortTermPercent").value, "");
    set("a", "shortTermPercent", "21"); set("a", "longTermPercent", "30"); set("b", "longTermPercent", "0");
    dom.window.document.querySelector('[data-sub-up="b"]').click();
    assert.equal(input("a", "shortTermPercent").value, "21");
    dom.window.document.querySelector("[data-sub-save]").click(); await flush();
    assert.deepEqual(saves[0].accountOrder, ["b", "a"]);
    assert.deepEqual(saves[0].accountReserves, { a: { shortTermPercent: 21, longTermPercent: 30 }, b: { longTermPercent: 0 } });
  } finally { dom.window.close(); }
});

test("clearing a threshold disables it and unchecking an account preserves its settings", async () => {
  const { dom, saves, input, set } = await setup({ accountReserves: { a: { shortTermPercent: 21, longTermPercent: 35 }, deleted: { longTermPercent: 90 } } });
  try {
    set("a", "shortTermPercent", "");
    dom.window.document.querySelector('[data-sub-account="a"]').click();
    assert.equal(input("a", "longTermPercent").disabled, true);
    dom.window.document.querySelector("[data-sub-save]").click(); await flush();
    assert.deepEqual(saves[0].accountOrder, ["b"]);
    assert.deepEqual(saves[0].accountReserves, { a: { shortTermPercent: null, longTermPercent: 35 } });
  } finally { dom.window.close(); }
});

test("invalid reserve percentages are blocked before any save and valid edits survive retry", async () => {
  const { dom, saves, set } = await setup();
  try {
    for (const value of ["-1", "101", "20.5"]) {
      set("a", "shortTermPercent", value);
      dom.window.document.querySelector("[data-sub-save]").click(); await flush();
      assert.equal(saves.length, 0);
    }
    set("a", "shortTermPercent", "100");
    dom.window.document.querySelector("[data-sub-save]").click(); await flush();
    assert.equal(saves[0].accountReserves.a.shortTermPercent, 100);
  } finally { dom.window.close(); }
});

test("reserve status is rendered separately from cooldown timestamps", async () => {
  const { dom } = await setup({ accountReserves: { a: { longTermPercent: 21 } } }, [{ recordId: "a", status: "reserved", reason: "长期额度剩余 21.0% ≤ 保留 21%" }]);
  try {
    const text = dom.window.document.querySelector("[data-api-body]").textContent;
    assert.match(text, /长期额度剩余 21.0% ≤ 保留 21%/);
    assert.doesNotMatch(text, /Invalid Date|undefined：/);
    dom.window.document.querySelector("[data-sub-save]").click(); await flush();
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

    // Click "临时加入" on unchecked account b
    dom.window.document.querySelector('[data-sub-temp-toggle="b"]').click();
    assert.equal(dom.window.document.querySelector('[data-sub-account="b"]').checked, true);

    // Saving without setting either 5h or weekly limit is blocked
    dom.window.document.querySelector("[data-sub-save]").click(); await flush();
    assert.equal(saves.length, 0);
    assert.match(dom.window.document.querySelector("[data-api-body]").textContent, /请至少设置一项 5h 或周使用额度/);

    // Fill in 5h temporary quota and verify live predicted stop %
    const tempShort = dom.window.document.querySelector('[data-sub-temp-account="b"][data-sub-temp="shortTermPercent"]');
    tempShort.value = "30";
    tempShort.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    assert.match(dom.window.document.querySelector('[data-sub-temp-hint="b"]').textContent, /5h 剩余 ≤ 50% 自动退出/);

    dom.window.document.querySelector("[data-sub-save]").click(); await flush();
    assert.deepEqual(saves[0].accountOrder, ["a", "b"]);
    assert.deepEqual(saves[0].accountTemporary, { b: { shortTermPercent: 30, longTermPercent: null } });
  } finally { dom.window.close(); }
});
