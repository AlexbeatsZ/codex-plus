import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { JSDOM } from "jsdom";

const script = await readFile(new URL("../assets/renderer.js", import.meta.url), "utf8");
const account = { recordId: "a".repeat(64), name: "Test", active: true };
const quota = (percent) => ({ rate_limit: { primary_window: { used_percent: percent, limit_window_seconds: 18000 } } });
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0)); };
function setup(usage) {
  const dom = new JSDOM("<!doctype html><html><head></head><body></body></html>", { runScripts: "dangerously", url: "app://-/index.html" });
  dom.window.codexPlusInvoke = async (path, payload) => path === "/accounts/list"
    ? { accounts: [account] } : usage(payload);
  dom.window.eval(script);
  return dom;
}

test("a failed usage query can be retried per account", async () => {
  let calls = 0;
  const dom = setup(async () => {
    if (++calls === 1) throw new Error("网络请求失败");
    return { usage: quota(25) };
  });
  try {
    dom.window.__codexPlusAccounts.open(); await flush();
    assert.match(dom.window.document.body.textContent, /网络请求失败/);
    const retry = dom.window.document.querySelector("[data-cp-usage-retry]");
    assert.ok(retry); retry.click(); await flush();
    assert.match(dom.window.document.body.textContent, /剩余 75%/);
    assert.equal(calls, 2);
  } finally { dom.window.close(); }
});

test("a refresh failure keeps the last success visibly marked as old", async () => {
  let calls = 0;
  const dom = setup(async () => {
    if (++calls > 1) throw new Error("网络请求失败");
    return { usage: quota(25) };
  });
  try {
    dom.window.__codexPlusAccounts.open(); await flush();
    dom.window.document.querySelector(".cp-account-close").click();
    dom.window.__codexPlusAccounts.open(); await flush();
    assert.match(dom.window.document.body.textContent, /剩余 75%/);
    assert.match(dom.window.document.body.textContent, /上次更新/);
    assert.match(dom.window.document.body.textContent, /网络请求失败/);
  } finally { dom.window.close(); }
});

test("missing usage is never displayed as 100 percent remaining", async () => {
  const dom = setup(async () => ({ usage: quota(null) }));
  try {
    dom.window.__codexPlusAccounts.open(); await flush();
    assert.doesNotMatch(dom.window.document.body.textContent, /剩余 100%/);
    assert.match(dom.window.document.body.textContent, /未知|暂不可用/);
  } finally { dom.window.close(); }
});

test("an old modal request cannot overwrite a newer usage result", async () => {
  let rejectOld, calls = 0;
  const dom = setup(async () => {
    if (++calls === 1) return new Promise((_, reject) => { rejectOld = reject; });
    return { usage: quota(20) };
  });
  try {
    dom.window.__codexPlusAccounts.open(); await flush();
    dom.window.document.querySelector(".cp-account-close").click();
    dom.window.__codexPlusAccounts.open(); await flush();
    rejectOld(new Error("old failure")); await flush();
    assert.match(dom.window.document.body.textContent, /剩余 80%/);
    assert.doesNotMatch(dom.window.document.body.textContent, /old failure/);
  } finally { dom.window.close(); }
});

test("opening the account list limits simultaneous quota requests to three", async () => {
  const dom = setup(async () => new Promise(() => {}));
  let calls = 0;
  dom.window.codexPlusInvoke = async (path) => {
    if (path === "/accounts/list") return { accounts: Array.from({ length: 6 }, (_, i) => ({ ...account, recordId: String(i).repeat(64) })) };
    calls += 1; return new Promise(() => {});
  };
  try {
    dom.window.__codexPlusAccounts.open(); await flush();
    assert.equal(calls, 3);
    assert.equal(dom.window.document.querySelectorAll(".cp-account-row").length, 6);
  } finally { dom.window.close(); }
});

async function setupSummary({ accounts = [account], order = [account.recordId], enabled = true, query = async () => ({ usage: quota(25) }), label = "剩余用量", expanded = false } = {}) {
  const dom = setup(query);
  const calls = [];
  dom.window.codexPlusInvoke = async (path, payload) => {
    calls.push({ path, payload });
    if (path === "/api-providers/subscription/get") return { config: { enabled, accountOrder: order }, accounts };
    if (path === "/accounts/usage") return query(payload);
    throw new Error(`Unexpected route: ${path}`);
  };
  dom.window.document.body.innerHTML = `<div role="menu"><div data-native-usage-block><button role="menuitem" data-native-usage aria-expanded="${expanded}">${label}</button>${expanded ? '<div data-native-details><div>5 小时 31% 14:24</div><div>1 周 42% 10月30日</div><button>升级至 Pro</button><button>了解更多</button></div>' : ""}</div><button role="menuitem">设置</button><button role="menuitem">退出登录</button></div>`;
  dom.window.__codexPlusAccounts.install(); await flush();
  return { dom, calls };
}

test("API usage is a separate inline accordion after the complete native usage block", async () => {
  for (const label of ["剩余用量", "剩余用量31%", "Usage remaining 31%", "Usage limits"]) {
    const { dom } = await setupSummary({ label, expanded: true });
    try {
      const native = dom.window.document.querySelector("[data-native-usage-block]");
      const item = native.nextElementSibling.querySelector("[data-codex-plus-usage-item]");
      assert.equal(item.textContent.trim(), "API 剩余额度");
      assert.equal(item.getAttribute("aria-expanded"), "false");
      assert.equal(item.getAttribute("aria-haspopup"), null);
      const body = dom.window.document.getElementById(item.getAttribute("aria-controls"));
      assert.equal(body.hidden, true);
      item.click(); await flush();
      assert.equal(item.getAttribute("aria-expanded"), "true");
      assert.equal(body.hidden, false);
      assert.equal(dom.window.document.querySelector(".cp-account-overlay"), null);
      assert.equal(native.querySelector("[data-native-usage]").getAttribute("aria-expanded"), "true");
      assert.match(native.textContent, /升级至 Pro.*了解更多/);
      item.click();
      assert.equal(body.hidden, true);
      dom.window.__codexPlusAccounts.install(); await flush();
      assert.equal(dom.window.document.querySelectorAll("[data-codex-plus-usage-item]").length, 1);
    } finally { dom.window.close(); }
  }
});

test("the API usage panel aggregates only selected accounts and excludes failed queries", async () => {
  const accounts = [account, { recordId: "b", name: "Second", plan: "plus" }, { recordId: "c", name: "Expired", plan: "plus" }, { recordId: "d", name: "Not selected", plan: "team" }];
  const { dom, calls } = await setupSummary({ accounts, order: [account.recordId, "b", "c"], query: async ({ recordId }) => {
    if (recordId === "c") throw new Error("凭据已失效，请重新登录");
    return { usage: { plan_type: "plus", rate_limit: { primary_window: { used_percent: recordId === "b" ? 60 : 20, limit_window_seconds: 18000 }, secondary_window: { used_percent: recordId === "b" ? 80 : 40, limit_window_seconds: 604800 } } } };
  } });
  try {
    dom.window.document.querySelector("[data-codex-plus-usage-item]").click(); await flush();
    const panel = dom.window.document.querySelector("[data-cp-usage-inline]");
    assert.deepEqual([...panel.querySelectorAll("[data-cp-usage-mean]")].map((node) => node.textContent), ["60%", "40%"]);
    assert.match(panel.textContent, /已更新 2\/3/);
    assert.match(panel.textContent, /1 个查询失败/);
    assert.doesNotMatch(panel.textContent, /Not selected/);
    assert.equal(calls.filter((call) => call.path === "/accounts/usage").length, 3);
    assert.equal(panel.querySelector("[data-cp-switch]"), null);
    assert.equal(panel.querySelector("[data-cp-delete]"), null);
    assert.equal(dom.window.document.querySelector(".cp-usage-dialog"), null);
    assert.equal(panel.closest('[role="menu"]'), dom.window.document.querySelector('[role="menu"]'));
  } finally { dom.window.close(); }
});

test("an empty disabled subscription pool does not borrow other accounts", async () => {
  const { dom, calls } = await setupSummary({ order: [], enabled: false });
  try {
    dom.window.document.querySelector("[data-codex-plus-usage-item]").click(); await flush();
    assert.match(dom.window.document.body.textContent, /尚未选择|未选择/);
    assert.match(dom.window.document.body.textContent, /停用/);
    assert.equal(calls.filter((call) => call.path === "/accounts/usage").length, 0);
  } finally { dom.window.close(); }
});

test("subscription averages keep different plans and durations separate", async () => {
  const accounts = [account, { recordId: "b", plan: "team" }, { recordId: "c", plan: "plus" }];
  const { dom } = await setupSummary({ accounts, order: [account.recordId, "b", "c"], query: async ({ recordId }) => ({ usage: {
    plan_type: recordId === "b" ? "team" : "plus",
    rate_limit: { primary_window: { used_percent: recordId === "b" ? 90 : recordId === "c" ? 60 : 20, limit_window_seconds: recordId === "c" ? 3600 : 18000 } },
  } }) });
  try {
    dom.window.document.querySelector("[data-codex-plus-usage-item]").click(); await flush();
    const groups = [...dom.window.document.querySelectorAll(".cp-inline-usage-group")];
    assert.equal(groups.length, 2);
    assert.match(groups[0].textContent, /5 小时80%/);
    assert.match(groups[0].textContent, /1 小时40%/);
    assert.match(groups[1].textContent, /10%/);
  } finally { dom.window.close(); }
});

test("collapsed or removed menu requests cannot update the next expanded accordion", async () => {
  let rejectOld, requests = 0;
  const { dom } = await setupSummary({ query: async () => {
    if (++requests === 1) return new Promise((_, reject) => { rejectOld = reject; });
    return { usage: quota(20) };
  } });
  try {
    const item = dom.window.document.querySelector("[data-codex-plus-usage-item]");
    item.click(); await flush(); item.click(); item.click(); await flush();
    rejectOld(new Error("obsolete error")); await flush();
    assert.equal(dom.window.document.querySelector("[data-cp-usage-mean]").textContent, "80%");
    assert.doesNotMatch(dom.window.document.querySelector("[data-cp-usage-inline]").textContent, /obsolete error/);
    dom.window.document.querySelector('[role="menu"]').remove(); await flush();
    assert.equal(dom.window.document.querySelector(".cp-account-overlay"), null);
  } finally { dom.window.close(); }
});

test("the inline trigger supports Enter and Space without opening a dialog", async () => {
  const { dom } = await setupSummary();
  try {
    const item = dom.window.document.querySelector("[data-codex-plus-usage-item]");
    item.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); await flush();
    assert.equal(item.getAttribute("aria-expanded"), "true");
    item.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true }));
    assert.equal(item.getAttribute("aria-expanded"), "false");
    assert.equal(dom.window.document.querySelector("[role=dialog]"), null);
  } finally { dom.window.close(); }
});

test("removing an expanded menu stops its remaining queued quota requests", async () => {
  const accounts = Array.from({ length: 5 }, (_, index) => ({ recordId: String(index), plan: "plus" }));
  const replies = [];
  const { dom } = await setupSummary({ accounts, order: accounts.map((value) => value.recordId), query: () => new Promise((resolve) => replies.push(resolve)) });
  try {
    dom.window.document.querySelector("[data-codex-plus-usage-item]").click(); await flush();
    assert.equal(replies.length, 3);
    dom.window.document.querySelector('[role="menu"]').remove();
    replies.forEach((resolve) => resolve({ usage: quota(20) })); await flush();
    assert.equal(replies.length, 3);
    assert.equal(dom.window.document.querySelector(".cp-account-overlay"), null);
  } finally { dom.window.close(); }
});

test("the summary refreshes with current participation and removes deleted accounts", async () => {
  const { dom, calls } = await setupSummary({ order: [account.recordId, "deleted"] });
  try {
    dom.window.document.querySelector("[data-codex-plus-usage-item]").click(); await flush();
    assert.match(dom.window.document.body.textContent, /1 个参与账户已删除/);
    dom.window.document.querySelector("[data-cp-usage-refresh]").click(); await flush();
    assert.equal(calls.filter((call) => call.path === "/api-providers/subscription/get").length, 2);
    assert.equal(calls.filter((call) => call.path === "/accounts/usage").length, 2);
    assert.ok(calls.filter((call) => call.path === "/accounts/usage").every((call) => call.payload.recordId === account.recordId));
  } finally { dom.window.close(); }
});
