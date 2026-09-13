import assert from "node:assert/strict";
import test from "node:test";
import { screenshotPointToNative } from "../src/desktop-mcp.js";

test("maps Retina screenshot pixels to Quartz points", () => {
  assert.deepEqual(screenshotPointToNative({ left: 0, top: 0, width: 1800, height: 1169, backingPixelWidth: 3600, backingPixelHeight: 2338, scaleFactor: 2 }, 1800, 1169), { x: 900, y: 584.5 });
});
test("maps non-zero screen origins", () => {
  assert.deepEqual(screenshotPointToNative({ left: -1200, top: 100, width: 1200, height: 800, backingPixelWidth: 2400, backingPixelHeight: 1600 }, 1200, 800), { x: -600, y: 500 });
});
test("rejects coordinates outside the screenshot", () => {
  assert.throws(() => screenshotPointToNative({ left: 0, top: 0, width: 100, height: 100, backingPixelWidth: 200, backingPixelHeight: 200 }, 200, 50), /outside 200x200/);
});
