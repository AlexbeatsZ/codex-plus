import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { JSDOM } from "jsdom";

const script = await readFile(new URL("../assets/renderer.js", import.meta.url), "utf8");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

async function flush(rounds = 4) {
  for (let index = 0; index < rounds; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function setup(invoke) {
  const dom = new JSDOM(`<!doctype html><html><head></head><body><div role="menu" id="profile-menu"><button role="menuitem" class="native">设置</button><button role="menuitem" class="native">退出登录</button></div></body></html>`, {
    runScripts: "dangerously",
    url: "app://-/index.html",
  });
  dom.window.codexPlusInvoke = invoke;
  dom.window.eval(script);
  return dom;
}

test("inserts one UsersRound account item between settings and sign out", async () => {
  const dom = setup(async () => ({ status: "ok", accounts: [] }));
  await flush();
  const menu = dom.window.document.getElementById("profile-menu");
  const labels = [...menu.children].map((node) => node.textContent.trim());
  assert.deepEqual(labels, ["设置", "切换账户", "退出登录"]);
  const item = menu.querySelector("[data-codex-plus-account-item]");
  assert.equal(item.querySelector("svg")?.getAttribute("viewBox"), "0 0 24 24");
  assert.equal(item.querySelector(".cp-menu-row")?.textContent, "切换账户");
  dom.window.__codexPlusAccounts.install();
  await flush();
  assert.equal(menu.querySelectorAll("[data-codex-plus-account-item]").length, 1);
});

test("renders account buttons before independent usage requests finish", async () => {
  const usageOne = deferred();
  const usageTwo = deferred();
  const dom = setup(async (path, payload) => {
    if (path === "/accounts/list") {
      return {
        status: "ok",
        accounts: [
          { accountId: "one", email: "one@example.com", active: true },
          { accountId: "two", email: "two@example.com", active: false },
        ],
      };
    }
    if (path === "/accounts/usage") return payload.accountId === "one" ? usageOne.promise : usageTwo.promise;
    throw new Error(`unexpected ${path}`);
  });
  await flush();
  dom.window.document.querySelector("[data-codex-plus-account-item]").click();
  await flush();
  assert.equal(dom.window.document.querySelectorAll(".cp-account-row").length, 2);
  assert.equal(dom.window.document.querySelector('[data-cp-switch="two"]')?.textContent, "切换");
  assert.equal(dom.window.document.querySelectorAll(".cp-usage-loading").length, 2);

  usageOne.resolve({
    status: "ok",
    usage: { rate_limit: { primary_window: { used_percent: 25, limit_window_seconds: 18000, reset_at: 2000000000 } } },
  });
  await flush();
  assert.match(dom.window.document.querySelector('[data-account-id="one"] .cp-account-usage').textContent, /剩余 75%/);
  assert.match(dom.window.document.querySelector('[data-account-id="two"] .cp-account-usage').textContent, /读取中/);
  usageTwo.resolve({ status: "failed", message: "额度暂不可用" });
  await flush();
});

test("file selection only fills the textarea and import requires the second button", async () => {
  const calls = [];
  const auth = JSON.stringify({ auth_mode: "chatgpt", tokens: { account_id: "a" } });
  const dom = setup(async (path, payload) => {
    calls.push({ path, payload });
    if (path === "/accounts/list") return { status: "ok", accounts: [] };
    if (path === "/accounts/import") return { status: "ok", account: { accountId: "a" } };
    throw new Error(`unexpected ${path}`);
  });
  await flush();
  dom.window.document.querySelector("[data-codex-plus-account-item]").click();
  await flush();
  dom.window.document.querySelector('[data-cp-view="import"]').click();
  await flush();
  const fileInput = dom.window.document.querySelector("[data-cp-file]");
  Object.defineProperty(fileInput, "files", {
    configurable: true,
    value: [{ name: "account.txt", text: async () => auth }],
  });
  fileInput.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  await flush();
  assert.equal(dom.window.document.querySelector("[data-cp-auth]").value, auth);
  assert.equal(calls.filter((call) => call.path === "/accounts/import").length, 0);
  assert.deepEqual(
    [...dom.window.document.querySelectorAll(".cp-import-actions button")].map((button) => button.textContent),
    ["选取文件", "导入"],
  );

  dom.window.document.querySelector("[data-cp-import]").click();
  await flush(8);
  const imports = calls.filter((call) => call.path === "/accounts/import");
  assert.equal(imports.length, 1);
  assert.equal(imports[0].payload.authContents, auth);
  assert.equal(dom.window.document.querySelector('[data-cp-view="accounts"]').getAttribute("aria-selected"), "true");
});

test("invalid JSON preserves the draft and never calls the backend", async () => {
  const calls = [];
  const dom = setup(async (path) => {
    calls.push(path);
    return { status: "ok", accounts: [] };
  });
  await flush();
  dom.window.document.querySelector("[data-codex-plus-account-item]").click();
  await flush();
  dom.window.document.querySelector('[data-cp-view="import"]').click();
  const textarea = dom.window.document.querySelector("[data-cp-auth]");
  textarea.value = "not-json";
  textarea.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  dom.window.document.querySelector("[data-cp-import]").click();
  await flush();
  assert.equal(dom.window.document.querySelector("[data-cp-auth]").value, "not-json");
  assert.match(dom.window.document.querySelector(".cp-account-status").textContent, /有效/);
  assert.equal(calls.filter((path) => path === "/accounts/import").length, 0);
});
