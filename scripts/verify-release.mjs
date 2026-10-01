import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => readFileSync(path.join(root, relative), "utf8");
const release = JSON.parse(read("release-channel.json"));
assert.ok(["base", "omen", "rog"].includes(release.channel), "Unknown release channel");
const expectedBranch = release.channel === "base" ? "main" : `codex/${release.channel}`;
assert.equal(release.branch, expectedBranch, "Release branch must match its channel");
assert.match(release.version, release.channel === "base" ? /^\d+\.\d+\.\d+$/ : new RegExp(`^\\d+\\.\\d+\\.\\d+-${release.channel}$`));
assert.equal(read("Cargo.toml").match(/^version = "([^"]+)"/m)?.[1], release.version);
assert.equal(read("Cargo.lock").match(/name = "codex-plus"\nversion = "([^"]+)"/)?.[1], release.version);

const expectedChannel = process.argv[process.argv.indexOf("--channel") + 1];
if (process.argv.includes("--channel")) assert.equal(release.channel, expectedChannel, "Wrong release channel for this host");
const includesAdapter = release.channel === "rog";
assert.deepEqual(release.components, includesAdapter ? ["local-tools", "ai-decision-todoist"] : ["local-tools"]);
for (const relative of [
  "local-tools/src/ai-decision-tools.ts",
  "local-tools/test/ai-decision-tools.test.ts",
  "local-tools/docs/design/ai-decision-bridge.md",
  "local-tools/dist/ai-decision-tools.js",
  "local-tools/dist/ai-decision-tools.d.ts",
  "local-tools/dist/ai-decision-tools.js.map",
]) assert.equal(existsSync(path.join(root, relative)), includesAdapter, `Unexpected component state: ${relative}`);

const source = read("local-tools/src/mcp-server.ts");
const built = read("local-tools/dist/mcp-server.js");
for (const [name, code] of [["source", source], ["build", built]]) {
  assert.equal(code.includes("registerAiDecisionTools"), includesAdapter, `Wrong adapter registration in ${name}`);
}
if (!includesAdapter) {
  const forbidden = /ai[-_ ]decision|todoist|begin_user_decision|begin_pending_decision|read_decision|commit_decision|report_decision_failure/i;
  for (const directory of ["local-tools/src", "local-tools/test", "local-tools/dist"]) {
    for (const entry of readdirSync(path.join(root, directory), { withFileTypes: true })) {
      if (!entry.isFile() || !/\.(?:ts|js|map)$/.test(entry.name)) continue;
      assert.ok(!forbidden.test(read(`${directory}/${entry.name}`)), `Excluded component remains in ${directory}/${entry.name}`);
    }
  }
}
console.log(`Release verified: ${release.version} (${release.branch}), components: ${release.components.join(", ")}`);
