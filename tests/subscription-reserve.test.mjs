import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { JSDOM } from "jsdom";

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
  dom.window.eval(script);
  dom.window.__codexPlusApi.open(); await flush();
  dom.window.document.querySelector('[data-api-edit="chatgpt-subscription"]').click(); await flush();
  const input = (id, key) => dom.window.document.querySelector(`[data-sub-reserve-account="${id}"][data-sub-reserve="${key}"]`);
  const set = (id, key, value) => { const node = input(id, key); node.value = value; node.dispatchEvent(new dom.window.Event("input", { bubbles: true })); };
  return { dom, saves, input, set };
}

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
