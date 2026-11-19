import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { JSDOM } from "jsdom";

const coreScript = await readFile(new URL("../assets/core.js", import.meta.url), "utf8");

function setup(body = "") {
  const dom = new JSDOM(`<!doctype html><html><head></head><body>${body}</body></html>`, { runScripts: "dangerously" });
  dom.window.eval(coreScript);
  return dom;
}

test("one shared observer serves every subscriber and isolates failures", async () => {
  const dom = setup();
  const core = dom.window.__codexPlusCore;
  const seen = [];
  core.subscribe("broken", () => { throw new Error("boom"); });
  core.subscribe("menus", (records) => seen.push(records.length));
  assert.equal(core.observing("menus"), true);
  dom.window.document.body.appendChild(dom.window.document.createElement("div"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(seen.length, 1);
  core.subscribe("menus", () => seen.push("replaced"));
  dom.window.document.body.appendChild(dom.window.document.createElement("div"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(seen.slice(1), ["replaced"]);
  dom.window.eval(coreScript);
  assert.equal(core.observing("menus"), true, "re-injecting the same version keeps subscribers");
});

test("profile menus require both native Settings and Sign out in one container", () => {
  const dom = setup('<div id="edit"><button role="menuitem">设置 Ctrl+,</button></div><div id="profile"><button role="menuitem">Settings</button><button role="menuitem">Log out</button></div>');
  const menus = dom.window.__codexPlusCore.profileMenus();
  assert.equal(menus.length, 1);
  assert.equal(menus[0].parent.id, "profile");
});

test("invoke surfaces failures and html escaping covers attributes", async () => {
  const dom = setup();
  const core = dom.window.__codexPlusCore;
  await assert.rejects(core.invoke("/x"), /尚未就绪/);
  dom.window.codexPlusInvoke = async () => ({ status: "failed", message: "坏了" });
  await assert.rejects(core.invoke("/x"), /坏了/);
  assert.equal(core.escapeHtml(`<a href="x" title='y'>&`), "&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;");
  const list = [];
  for (let index = 0; index < 5; index += 1) core.pushDiagnostic(list, 3, `e${index}`);
  assert.deepEqual(list.map((entry) => entry.event), ["e2", "e3", "e4"]);
});

test("converts timestamps to UTC+8 regardless of local timezone", () => {
  const dom = setup();
  const core = dom.window.__codexPlusCore;
  // 2026-11-19T10:31:00Z -> UTC+8 is 2026-11-19 18:31
  const utcMs = Date.UTC(2026, 10, 19, 10, 31, 0);
  const parts = core.utc8Parts(utcMs);
  assert.deepEqual({ year: parts.year, month: parts.month, day: parts.day, hour: parts.hour, minute: parts.minute }, {
    year: 2026, month: 11, day: 19, hour: 18, minute: 31,
  });
  assert.equal(core.formatUtc8Time(utcMs), "18:31");
  assert.equal(core.formatUtc8DateTime(utcMs), "11月19日 18:31");
  // Same UTC+8 day vs next UTC+8 day in compact reset formatting
  const sameDayNow = Date.UTC(2026, 10, 19, 5, 0, 0);
  const nextDayReset = Date.UTC(2026, 10, 19, 17, 0, 0); // UTC+8 is Nov 20 01:00
  assert.equal(core.formatUtc8Reset(utcMs / 1000, sameDayNow, { compact: true }), "18:31");
  assert.equal(core.formatUtc8Reset(nextDayReset / 1000, sameDayNow, { compact: true }), "11月20日 01:00");
  assert.equal(core.formatUtc8Reset(utcMs / 1000, sameDayNow), "11月19日 18:31");
  assert.match(core.timezoneConversionNote(), /UTC\+8/);
});
