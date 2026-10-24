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
