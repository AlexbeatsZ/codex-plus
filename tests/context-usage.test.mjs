import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { JSDOM } from "jsdom";

const script = await readFile(new URL("../assets/context-usage.js", import.meta.url), "utf8");
const usage = (input = 102640263, cached = 100660224, output = 327318) => ({
  total: { inputTokens: input, cachedInputTokens: cached, outputTokens: output, reasoningOutputTokens: 133764 },
  last: { inputTokens: 347536, outputTokens: 327, totalTokens: 347863 },
  modelContextWindow: 475000,
});

function close(dom) {
  dom.window.__codexPlusContextUsage.destroy();
  dom.window.close();
}

function fixture({ native = usage(), threadId = "thread-a", hostId = "local", routing, snapshot, url = "app://-/index.html" } = {}) {
  const dom = new JSDOM('<!doctype html><html lang="zh-CN"><body><div role="tooltip"><div data-panel><span>背景信息窗口：</span><span>已用 347k 标记，共 475k</span></div></div></body></html>', { runScripts: "dangerously", url });
  const timers = new Map();
  let nextTimer = 0;
  dom.window.setInterval = (callback) => { timers.set(++nextTimer, callback); return nextTimer; };
  dom.window.clearInterval = (id) => timers.delete(id);
  dom.window.__codexPlusModelRouting = routing;
  const panel = dom.window.document.querySelector("[data-panel]");
  const owner = { memoizedProps: { conversationId: threadId }, return: null };
  const hook = { memoizedState: native, queue: snapshot ? { getSnapshot: snapshot } : null, next: null };
  const footer = { memoizedProps: { permissionsHostId: hostId }, memoizedState: hook, return: owner };
  panel.__reactFiber$test = { memoizedProps: {}, return: footer };
  dom.window.eval(script);
  const rows = () => Object.fromEntries([...panel.querySelectorAll("[data-codex-plus-context-usage] > div")].map(row => [...row.children].map(cell => cell.textContent)));
  return { dom, panel, hook, footer, owner, timers, rows, tick: () => { for (const callback of timers.values()) callback(); } };
}

test("native tooltip totals work without the legacy conversation manager", () => {
  const { dom, panel, rows } = fixture();
  try {
    assert.deepEqual(rows(), { 会话累计: "", 输入: "102,640,263", 缓存输入: "100,660,224", 缓存命中: "98.1%", 输出: "327,318", 其中推理: "133,764" });
    assert.match(panel.textContent, /已用 347k 标记，共 475k/);
  } finally { close(dom); }
});

test("reads the current native subscription across React alternates and clears missing data", () => {
  let current = usage(5000, 4000, 200);
  const { dom, rows, tick } = fixture({ snapshot: () => current, routing: { tokenUsage: () => usage(9999) } });
  try {
    assert.equal(rows().输入, "5,000");
    current = usage(6000, 5000, 300); tick();
    assert.equal(rows().输入, "6,000");
    current = null; tick();
    assert.equal(rows().输入, "—");
    assert.equal(rows().输出, "—");
  } finally { close(dom); }
});

test("a failed native snapshot does not show stale manager totals", () => {
  const { dom, rows } = fixture({ snapshot: () => { throw new Error("unmounted"); }, routing: { tokenUsage: () => usage() } });
  try { assert.equal(rows().输入, "—"); } finally { close(dom); }
});

test("a previously empty React alternate can read newly committed native usage", () => {
  const current = usage(5000, 4000, 200);
  const { dom, hook, rows, tick } = fixture({ native: null });
  try {
    assert.equal(rows().输入, "—");
    hook.queue = { value: current, getSnapshot: () => current }; tick();
    assert.equal(rows().输入, "5,000");
  } finally { close(dom); }
});

test("simultaneous tooltips keep each conversation's native totals isolated", () => {
  const { dom, panel, hook, rows, tick } = fixture({ native: usage(5000, 4000, 200) });
  try {
    const second = panel.cloneNode(true);
    second.querySelector("[data-codex-plus-context-usage]").remove();
    second.__reactFiber$test = { memoizedProps: { threadId: "thread-b", hostId: "remote-host" }, memoizedState: { memoizedState: usage(9000, 8000, 300), next: null } };
    panel.parentElement.append(second);
    dom.window.eval(script);
    assert.equal(rows().输入, "5,000");
    assert.match(second.querySelector("[data-codex-plus-context-usage]").textContent, /输入9,000/);
    hook.memoizedState = usage(6000, 5000, 200); tick();
    assert.equal(rows().输入, "6,000");
    assert.match(second.querySelector("[data-codex-plus-context-usage]").textContent, /输入9,000/);
  } finally { close(dom); }
});

test("legacy manager fallback keeps the tooltip's host and thread identity", () => {
  const calls = [];
  const { dom, rows } = fixture({ native: null, threadId: "remote-thread", hostId: "remote-host", routing: { tokenUsage: (...args) => { calls.push(args); return usage(8000, 6000, 100); } } });
  try {
    assert.deepEqual(calls, [["remote-thread", "remote-host"]]);
    assert.equal(rows().输入, "8,000");
  } finally { close(dom); }
});

test("a tooltip cannot borrow usage from outside its nearest conversation boundary", () => {
  const { dom, owner, rows, tick } = fixture({ native: null });
  try {
    owner.return = { memoizedState: { memoizedState: usage(), next: null }, memoizedProps: { conversationId: "other-thread" } };
    tick();
    assert.equal(rows().输入, "—");
  } finally { close(dom); }
});

test("native usage stays unknown when the tooltip has no conversation identity", () => {
  const { dom, rows } = fixture({ threadId: null });
  try { assert.equal(rows().输入, "—"); } finally { close(dom); }
});

test("explicit thread paths retain the legacy identity fallback", () => {
  const calls = [];
  const threadId = "01234567-89ab-cdef-0123-456789abcdef";
  const { dom, rows } = fixture({ native: null, threadId: null, url: `app://-/thread/${threadId}`, routing: { tokenUsage: (...args) => { calls.push(args); return usage(500, 250, 100); } } });
  try {
    assert.deepEqual(calls, [[threadId, "local"]]);
    assert.equal(rows().缓存命中, "50.0%");
  } finally { close(dom); }
});

test("invalid counts and cache ratios remain unknown without adding cached or reasoning tokens twice", () => {
  const info = usage(100, 101, 20);
  info.total.reasoningOutputTokens = null;
  const { dom, rows, hook, tick } = fixture({ native: info });
  try {
    assert.equal(rows().输入, "100");
    assert.equal(rows().缓存命中, "—");
    assert.equal(rows().输出, "20");
    assert.equal(rows().其中推理, undefined);
    hook.memoizedState = usage(-1, NaN, Number.MAX_SAFE_INTEGER + 1); tick();
    assert.equal(rows().输入, "—");
    assert.equal(rows().缓存输入, "—");
    assert.equal(rows().输出, "—");
  } finally { close(dom); }
});

test("reinjection and tooltip removal dispose the old blocks and polling timers", () => {
  const { dom, panel, timers, tick } = fixture();
  try {
    assert.equal(timers.size, 1);
    dom.window.eval(script);
    assert.equal(timers.size, 1);
    assert.equal(panel.querySelectorAll("[data-codex-plus-context-usage]").length, 1);
    panel.remove(); tick();
    assert.equal(timers.size, 0);
    dom.window.__codexPlusContextUsage.destroy();
  } finally { close(dom); }
});
