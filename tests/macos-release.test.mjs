import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { publishRelease } from "../macos/release.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const identity = process.env.CODEX_PLUS_SIGN_IDENTITY || "Local Development Code Signing";
const identities = process.platform === "darwin" ? spawnSync("security", ["find-identity", "-v", "-p", "codesigning"], { encoding: "utf8" }).stdout : "";
const skip = process.platform !== "darwin" || !identities?.includes(`"${identity}"`);

test("macOS publishing preserves signing identity and the previous release on failure", { skip }, () => {
  mkdirSync("/tmp/.agents", { recursive: true });
  const fixture = mkdtempSync("/tmp/.agents/codex-plus-signing-test-");
  const call = (command, args) => {
    const result = spawnSync(command, args, { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return `${result.stdout}${result.stderr}`;
  };
  try {
    mkdirSync(path.join(fixture, "macos"));
    copyFileSync(path.join(root, "macos/sign.sh"), path.join(fixture, "macos/sign.sh"));
    const binary = path.join(fixture, "native-fixture");
    const source = path.join(fixture, "fixture.c");
    writeFileSync(source, "int main(void) { return 0; }\n");
    call("/usr/bin/arch", ["-arm64", "/usr/bin/cc", source, "-o", binary]);
    call("codesign", ["--force", "--timestamp=none", "--identifier", "com.example.wrong", "--sign", identity, binary]);
    call("/bin/bash", [path.join(root, "macos/sign.sh"), binary]);
    assert.match(call("codesign", ["-d", "-r-", binary]), /identifier "com\.codex-plus\.launcher" and certificate leaf/);
    call(binary, []);
    const signedInode = statSync(binary).ino;
    assert.match(call("/bin/bash", [path.join(root, "macos/sign.sh"), binary]), /already signed/);
    assert.equal(statSync(binary).ino, signedInode, "Correctly signed binaries must not be replaced");

    const options = { root: fixture, executable: binary,
      release: { channel: "base", branch: "main", version: "0.3.2", components: ["local-tools"] },
      revision: { sourceCommit: "test-fixture", sourceDirty: false } };
    const record = publishRelease(options);
    call(record.executable, []);
    const manifest = path.join(fixture, ".codex-plus/release.json");
    assert.deepEqual(JSON.parse(readFileSync(manifest, "utf8")), record);
    const installedInode = statSync(record.executable).ino;
    const previousMetadata = readFileSync(manifest, "utf8");
    assert.throws(() => publishRelease({ ...options, env: { ...process.env, CODEX_PLUS_SIGN_IDENTITY: "Missing Codex Plus Test Identity" } }), /failed/);
    assert.equal(statSync(record.executable).ino, installedInode);
    assert.equal(readFileSync(manifest, "utf8"), previousMetadata);
    assert.deepEqual(readdirSync(path.dirname(record.executable)), ["codex-plus"]);
    assert.deepEqual(readdirSync(path.dirname(manifest)), ["release.json"]);
    assert.ok(existsSync(binary));
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
