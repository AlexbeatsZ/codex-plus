import { existsSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { runProcess, shellInvocation, type ProcessResult } from "./process.js";
import { WorkspaceRegistry } from "./workspaces.js";

const IMAGE_MIME_TYPES: Record<string, string> = {
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

export interface TextReadResult {
  path: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  text: string;
  truncated: boolean;
}

export interface SearchMatch {
  path: string;
  line: number;
  column: number;
  text: string;
}

export class LocalOperations {
  constructor(readonly registry: WorkspaceRegistry) {}

  async listFiles(workspace: string, relativePath: string, glob: string | undefined, limit: number) {
    const cwd = this.registry.resolveExisting(workspace, relativePath);
    const targetStat = await stat(cwd);
    if (!targetStat.isDirectory()) throw new Error("list_files path must be a directory.");

    const args = ["--files", "--hidden", "--glob", "!.git/**"];
    if (glob) args.push("--glob", glob);
    let result: ProcessResult;
    try {
      result = await runProcess(ripgrepExecutable(), args, { cwd, timeoutMs: 30_000, maxOutputBytes: 2_000_000 });
    } catch (error) {
      if (!isUnavailableExecutable(error)) throw error;
      const files = await fallbackFileList(cwd, glob);
      const all = files.map((item) => this.registry.relative(workspace, item));
      return { files: all.slice(0, limit), truncated: all.length > limit };
    }
    if (result.exitCode !== 0 && result.exitCode !== 1) throw processFailure("ripgrep file listing", result);
    const all = result.stdout
      .split(/\r?\n/)
      .filter(Boolean)
      .map((item) => this.registry.relative(workspace, path.resolve(cwd, item)));
    return { files: all.slice(0, limit), truncated: all.length > limit || result.truncated };
  }

  async searchText(
    workspace: string,
    relativePath: string,
    query: string,
    fixed: boolean,
    glob: string | undefined,
    limit: number,
  ) {
    const cwd = this.registry.resolveExisting(workspace, relativePath);
    const args = ["--json", "--hidden", "--glob", "!.git/**"];
    if (fixed) args.push("--fixed-strings");
    if (glob) args.push("--glob", glob);
    args.push("--", query, ".");
    let result: ProcessResult;
    try {
      result = await runProcess(ripgrepExecutable(), args, { cwd, timeoutMs: 30_000, maxOutputBytes: 4_000_000 });
    } catch (error) {
      if (!isUnavailableExecutable(error)) throw error;
      return fallbackSearch(
        cwd,
        (absolutePath) => this.registry.relative(workspace, absolutePath),
        query,
        fixed,
        glob,
        limit,
      );
    }
    if (result.exitCode !== 0 && result.exitCode !== 1) throw processFailure("ripgrep search", result);

    const matches: SearchMatch[] = [];
    for (const line of result.stdout.split(/\r?\n/)) {
      if (!line) continue;
      const event = JSON.parse(line) as {
        type: string;
        data?: {
          path?: { text?: string };
          lines?: { text?: string };
          line_number?: number;
          submatches?: Array<{ start?: number }>;
        };
      };
      if (event.type !== "match" || !event.data?.path?.text || event.data.line_number === undefined) continue;
      const filePath = path.resolve(cwd, event.data.path.text);
      matches.push({
        path: this.registry.relative(workspace, filePath),
        line: event.data.line_number,
        column: (event.data.submatches?.[0]?.start ?? 0) + 1,
        text: (event.data.lines?.text ?? "").replace(/[\r\n]+$/, ""),
      });
      if (matches.length >= limit) break;
    }
    return { matches, truncated: matches.length >= limit || result.truncated };
  }

  async readText(workspace: string, relativePath: string, startLine: number, lineCount: number): Promise<TextReadResult> {
    const absolutePath = this.registry.resolveExisting(workspace, relativePath);
    const fileStat = await stat(absolutePath);
    if (!fileStat.isFile()) throw new Error("read_file path must be a file.");
    if (fileStat.size > 5_000_000) throw new Error("File exceeds the 5 MB text read limit.");
    const buffer = await readFile(absolutePath);
    if (buffer.subarray(0, Math.min(buffer.length, 8_192)).includes(0)) throw new Error("File appears to be binary. Use read_image for supported images.");
    const lines = buffer.toString("utf8").split(/\r?\n/);
    const startIndex = Math.min(startLine - 1, lines.length);
    const selected = lines.slice(startIndex, startIndex + lineCount);
    return {
      path: this.registry.relative(workspace, absolutePath),
      startLine,
      endLine: startIndex + selected.length,
      totalLines: lines.length,
      text: selected.join("\n"),
      truncated: startIndex + selected.length < lines.length,
    };
  }

  async readImage(workspace: string, relativePath: string) {
    const absolutePath = this.registry.resolveExisting(workspace, relativePath);
    const mimeType = IMAGE_MIME_TYPES[path.extname(absolutePath).toLowerCase()];
    if (!mimeType) throw new Error("Supported image types: PNG, JPEG, GIF, and WebP.");
    const fileStat = await stat(absolutePath);
    if (!fileStat.isFile()) throw new Error("read_image path must be a file.");
    if (fileStat.size > 10_000_000) throw new Error("Image exceeds the 10 MB limit.");
    return {
      path: this.registry.relative(workspace, absolutePath),
      mimeType,
      size: fileStat.size,
      data: (await readFile(absolutePath)).toString("base64"),
    };
  }

  async runCommand(workspace: string, relativePath: string, command: string, timeoutSeconds: number): Promise<ProcessResult> {
    const cwd = this.registry.resolveExisting(workspace, relativePath);
    const cwdStat = await stat(cwd);
    if (!cwdStat.isDirectory()) throw new Error("run_command cwd must be a directory.");
    const shell = shellInvocation(command);
    return runProcess(shell.executable, shell.args, {
      cwd,
      timeoutMs: timeoutSeconds * 1_000,
      maxOutputBytes: 200_000,
    });
  }

  async applyPatch(workspace: string, patchText: string) {
    const root = this.registry.get(workspace).root;
    const paths = extractPatchPaths(patchText);
    if (paths.length === 0) throw new Error("Patch has no ---/+++ file headers.");
    for (const patchPath of paths) this.registry.resolveProspective(workspace, patchPath);

    const args = ["apply", "--recount", "--whitespace=nowarn", "-"];
    const check = await runProcess("git", ["apply", "--check", "--recount", "--whitespace=nowarn", "-"], {
      cwd: root,
      input: patchText,
      timeoutMs: 30_000,
    });
    if (check.exitCode !== 0) throw processFailure("git apply --check", check);
    const applied = await runProcess("git", args, { cwd: root, input: patchText, timeoutMs: 30_000 });
    if (applied.exitCode !== 0) throw processFailure("git apply", applied);
    return { applied: true, paths };
  }

  async gitStatus(workspace: string) {
    const root = this.registry.get(workspace).root;
    const result = await runProcess("git", ["status", "--short", "--branch"], { cwd: root, timeoutMs: 30_000 });
    if (result.exitCode !== 0) throw processFailure("git status", result);
    return result.stdout.trimEnd();
  }

  async gitDiff(workspace: string, staged: boolean, relativePath: string | undefined) {
    const root = this.registry.get(workspace).root;
    const args = ["diff", "--no-ext-diff", "--no-color"];
    if (staged) args.push("--cached");
    if (relativePath) {
      const absolute = this.registry.resolveProspective(workspace, relativePath);
      args.push("--", path.relative(root, absolute));
    }
    const result = await runProcess("git", args, { cwd: root, timeoutMs: 30_000, maxOutputBytes: 500_000 });
    if (result.exitCode !== 0) throw processFailure("git diff", result);
    return { diff: result.stdout, truncated: result.truncated };
  }
}

function ripgrepExecutable(): string {
  const explicit = process.env.CODEX_PLUS_RG;
  if (explicit) return explicit;

  if (process.platform === "darwin") {
    const bundled = [
      "/Applications/ChatGPT.app/Contents/Resources/rg",
      "/Applications/Codex.app/Contents/Resources/rg",
    ].find((candidate) => existsSync(candidate));
    if (bundled) return bundled;
  }

  return "rg";
}
function isUnavailableExecutable(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "EPERM" || code === "EACCES";
}

async function fallbackFileList(cwd: string, glob: string | undefined): Promise<string[]> {
  const files: string[] = [];
  await walkFiles(cwd, async (absolutePath, relativePath) => {
    if (!glob || matchesGlob(relativePath, glob)) files.push(absolutePath);
    return false;
  });
  return files;
}

async function fallbackSearch(
  cwd: string,
  displayPath: (absolutePath: string) => string,
  query: string,
  fixed: boolean,
  glob: string | undefined,
  limit: number,
): Promise<{ matches: SearchMatch[]; truncated: boolean }> {
  const matches: SearchMatch[] = [];
  const expression = fixed ? undefined : new RegExp(query);
  await walkFiles(cwd, async (absolutePath, relativePath) => {
    if (glob && !matchesGlob(relativePath, glob)) return false;
    const fileStat = await stat(absolutePath);
    if (fileStat.size > 5_000_000) return false;
    const buffer = await readFile(absolutePath);
    if (buffer.subarray(0, Math.min(buffer.length, 8_192)).includes(0)) return false;
    const lines = buffer.toString("utf8").split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      const column = fixed ? line.indexOf(query) : (expression?.exec(line)?.index ?? -1);
      if (column < 0) continue;
      matches.push({ path: displayPath(absolutePath), line: index + 1, column: column + 1, text: line });
      if (matches.length >= limit) return true;
    }
    return false;
  });
  return { matches, truncated: matches.length >= limit };
}

async function walkFiles(
  root: string,
  visitor: (absolutePath: string, relativePath: string) => Promise<boolean>,
): Promise<boolean> {
  const visitDirectory = async (directory: string): Promise<boolean> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (entry.name === ".git" || entry.isSymbolicLink()) continue;
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (await visitDirectory(absolutePath)) return true;
      } else if (entry.isFile()) {
        const relativePath = path.relative(root, absolutePath).split(path.sep).join("/");
        if (await visitor(absolutePath, relativePath)) return true;
      }
    }
    return false;
  };
  return visitDirectory(root);
}

function matchesGlob(value: string, glob: string): boolean {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const pattern = escaped.replace(/\*\*\//g, "(?:.*/)?").replace(/\*\*/g, ".*").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]");
  return new RegExp(`^${pattern}$`).test(value);
}

function processFailure(action: string, result: ProcessResult): Error {
  const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode}`;
  return new Error(`${action} failed: ${detail}`);
}

function extractPatchPaths(patchText: string): string[] {
  const paths = new Set<string>();
  for (const line of patchText.split(/\r?\n/)) {
    if (!line.startsWith("--- ") && !line.startsWith("+++ ")) continue;
    let value = line.slice(4).split("\t", 1)[0].trim();
    if (value === "/dev/null") continue;
    if (value.startsWith('"') && value.endsWith('"')) {
      try {
        value = JSON.parse(value) as string;
      } catch {
        throw new Error(`Unsupported quoted patch path: ${value}`);
      }
    }
    if (value.startsWith("a/") || value.startsWith("b/")) value = value.slice(2);
    if (!value || path.isAbsolute(value) || value.split(/[\\/]/).includes("..")) {
      throw new Error(`Unsafe patch path: ${value}`);
    }
    paths.add(value);
  }
  return [...paths];
}
