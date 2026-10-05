import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: projectRoot, stdio: "inherit", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status ?? result.signal})`);
  return result;
}

// Prepare both files before replacing the installed executable. Signing failures
// leave the previous entry point and its release record intact.
export function publishRelease({ root, executable, release, revision, env = process.env }) {
  const destination = path.join(root, "target/release/codex-plus");
  const state = path.join(root, ".codex-plus");
  mkdirSync(path.dirname(destination), { recursive: true });
  const stage = mkdtempSync(path.join(path.dirname(destination), ".macos-release-"));
  let metadataStage;
  try {
    const candidate = path.join(stage, "codex-plus");
    copyFileSync(executable, candidate);
    chmodSync(candidate, 0o755);
    run("/bin/bash", [path.join(root, "macos/sign.sh"), candidate], { env });
    const architecture = run("/usr/bin/file", ["-b", candidate], { encoding: "utf8", stdio: "pipe" }).stdout.trim();
    assert.match(architecture, /Mach-O/, "Release must be a macOS executable");
    const record = { ...release, ...revision, platform: "macos", architecture, builtAt: new Date().toISOString(), executable: destination };
    mkdirSync(state, { recursive: true });
    metadataStage = mkdtempSync(path.join(state, ".release-"));
    const metadata = path.join(metadataStage, "release.json");
    writeFileSync(metadata, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    renameSync(candidate, destination);
    renameSync(metadata, path.join(state, "release.json"));
    return record;
  } finally {
    rmSync(stage, { recursive: true, force: true });
    if (metadataStage) rmSync(metadataStage, { recursive: true, force: true });
  }
}

function buildRelease(args) {
  assert.equal(process.platform, "darwin", "Use macos/release.sh on macOS");
  const release = JSON.parse(readFileSync(path.join(projectRoot, "release-channel.json"), "utf8"));
  assert.equal(release.channel, "base", "Mac releases use the shared base edition");
  // Clean away stale host-only compiled modules, as the Windows release does.
  run("npm", ["run", "local-tools:build"]);
  run("npm", ["run", "release:verify", "--", "--channel", "base"]);
  const sourceCommit = run("git", ["rev-parse", "HEAD"], { encoding: "utf8", stdio: "pipe" }).stdout.trim();
  const sourceDirty = run("git", ["status", "--porcelain"], { encoding: "utf8", stdio: "pipe" }).stdout.trim() !== "";
  // Cargo's diagnostics still go to the terminal; artifact messages select the
  // actual output, including an explicit --target, instead of signing an old file.
  const result = run("/usr/bin/arch", ["-arm64", "cargo", "build", "--release", ...args,
      "--target-dir", path.join(projectRoot, "target/macos-build"), "--message-format=json-render-diagnostics"],
    { encoding: "utf8", stdio: ["inherit", "pipe", "inherit"], maxBuffer: 32 * 1024 * 1024 });
  const artifacts = result.stdout.split("\n").filter(Boolean).map(line => JSON.parse(line))
      .filter(item => item.reason === "compiler-artifact" && item.target?.name === "codex-plus" && item.executable);
  assert.equal(artifacts.length, 1, "Expected one codex-plus executable from Cargo");
  const record = publishRelease({ root: projectRoot, executable: artifacts[0].executable, release, revision: { sourceCommit, sourceDirty } });
  console.log(`Published ${record.version} (${record.sourceCommit}${record.sourceDirty ? ", uncommitted changes" : ""}): ${record.executable}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { buildRelease(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
