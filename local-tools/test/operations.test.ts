import assert from "node:assert/strict";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { LocalOperations } from "../src/operations.js";
import { runProcess } from "../src/process.js";
import { WorkspaceRegistry } from "../src/workspaces.js";
import { makeAgentTemp } from "./support.js";

test("workspace operations read, search, patch, command, and Git state", async () => {
  const temporary = await makeAgentTemp("codex-chat-local-tools");
  try {
    await writeFile(path.join(temporary.directory, "hello.txt"), "alpha\nsecond line\n", "utf8");
    await mkdir(path.join(temporary.directory, "src"));
    await writeFile(path.join(temporary.directory, "src", "nested.txt"), "nested\n", "utf8");
    await runProcess("git", ["init", "-b", "main"], { cwd: temporary.directory });

    const registry = new WorkspaceRegistry([temporary.directory]);
    const workspace = registry.workspaces[0].id;
    const operations = new LocalOperations(registry);

    const listing = await operations.listFiles(workspace, ".", undefined, 20);
    assert.deepEqual(listing.files.sort(), ["hello.txt", "src/nested.txt"]);
    const nestedListing = await operations.listFiles(workspace, "src", undefined, 20);
    assert.deepEqual(nestedListing.files, ["src/nested.txt"]);

    const search = await operations.searchText(workspace, ".", "alpha", true, undefined, 20);
    assert.equal(search.matches.length, 1);
    assert.equal(search.matches[0].path, "hello.txt");
    assert.equal(search.matches[0].line, 1);

    const read = await operations.readText(workspace, "hello.txt", 1, 1);
    assert.equal(read.text, "alpha");
    assert.equal(read.truncated, true);

    const command = process.platform === "win32" ? "Write-Output command-ok" : "printf 'command-ok\\n'";
    const commandResult = await operations.runCommand(workspace, ".", command, 10);
    assert.equal(commandResult.exitCode, 0);
    assert.match(commandResult.stdout, /command-ok/);

    const patch = [
      "diff --git a/hello.txt b/hello.txt",
      "--- a/hello.txt",
      "+++ b/hello.txt",
      "@@ -1,2 +1,2 @@",
      "-alpha",
      "+beta",
      " second line",
      "",
    ].join("\n");
    const applied = await operations.applyPatch(workspace, patch);
    assert.deepEqual(applied.paths, ["hello.txt"]);
    assert.equal((await operations.readText(workspace, "hello.txt", 1, 1)).text, "beta");

    const status = await operations.gitStatus(workspace);
    assert.match(status, /hello\.txt/);
  } finally {
    await temporary.cleanup();
  }
});

test("path-based operations reject lexical workspace escape", async () => {
  const temporary = await makeAgentTemp("codex-chat-paths");
  try {
    const registry = new WorkspaceRegistry([temporary.directory]);
    const workspace = registry.workspaces[0].id;
    assert.throws(() => registry.resolveProspective(workspace, "../outside.txt"), /escapes workspace/);
  } finally {
    await temporary.cleanup();
  }
});

test("existing paths cannot escape through a directory link", async () => {
  const temporary = await makeAgentTemp("codex-chat-links");
  try {
    const workspaceRoot = path.join(temporary.directory, "workspace");
    const outsideRoot = path.join(temporary.directory, "outside");
    await mkdir(workspaceRoot);
    await mkdir(outsideRoot);
    await writeFile(path.join(outsideRoot, "secret.txt"), "outside\n", "utf8");
    await symlink(outsideRoot, path.join(workspaceRoot, "linked"), process.platform === "win32" ? "junction" : "dir");

    const registry = new WorkspaceRegistry([workspaceRoot]);
    const workspace = registry.workspaces[0].id;
    assert.throws(() => registry.resolveExisting(workspace, "linked/secret.txt"), /symbolic link/);
  } finally {
    await temporary.cleanup();
  }
});
