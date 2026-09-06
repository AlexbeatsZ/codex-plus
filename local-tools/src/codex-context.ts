import { createHash } from "node:crypto";
import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { WorkspaceRegistry } from "./workspaces.js";

const DEFAULT_PROJECT_DOC_BYTES = 32 * 1024;
const MAX_PROJECT_DOC_BYTES = 256 * 1024;
const DEFAULT_CATALOG_CHARS = 8_000;
const MAX_SKILL_FILE_BYTES = 1_000_000;
const MAX_RESOURCE_BYTES = 5_000_000;
const MAX_IMAGE_BYTES = 10_000_000;
const MAX_RESOURCE_INVENTORY = 1_000;

const IMAGE_MIME_TYPES: Record<string, string> = {
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

export type SkillScope = "project" | "user" | "system" | "plugin" | "extra";

export interface CodexContextOptions {
  enabled?: boolean;
  codexHome?: string;
  extraSkillRoots?: string[];
  catalogMaxChars?: number;
}

export interface SyncedSkill {
  id: string;
  name: string;
  description: string;
  scope: SkillScope;
  source: string;
  sourcePath: string;
  implicitInvocation: boolean;
}

interface SkillSearchRoot {
  root: string;
  scope: SkillScope;
  source: string;
  maxDepth: number;
}

interface SkillRecord extends SyncedSkill {
  root: string;
}

interface InstructionSource {
  scope: "global" | "project";
  path: string;
  content: string;
  truncated: boolean;
}

interface CodexConfig {
  projectDocMaxBytes: number;
  projectDocFallbackFilenames: string[];
  disabledSkillPaths: Set<string>;
  enabledPlugins: Set<string>;
}

export interface SkillResourceResult {
  skillId: string;
  path: string;
  format: "text" | "image";
  mimeType: string;
  size: number;
  startLine?: number;
  endLine?: number;
  totalLines?: number;
  text?: string;
  truncated?: boolean;
  data?: string;
}

export function defaultCodexHome(): string {
  return path.resolve(process.env.CODEX_CHAT_CODEX_HOME ?? process.env.CODEX_HOME ?? path.join(homedir(), ".codex"));
}

export function extraSkillRootsFromEnvironment(): string[] {
  const configured = process.env.CODEX_CHAT_SKILL_ROOTS;
  return configured ? configured.split(path.delimiter).map((item) => item.trim()).filter(Boolean) : [];
}

export function codexContextEnabledFromEnvironment(): boolean {
  return !["0", "false", "off", "no"].includes((process.env.CODEX_CHAT_SYNC_CODEX_CONTEXT ?? "1").toLowerCase());
}

export class CodexContextSync {
  readonly enabled: boolean;
  readonly codexHome: string;
  readonly extraSkillRoots: string[];
  readonly catalogMaxChars: number;

  constructor(readonly registry: WorkspaceRegistry, options: CodexContextOptions = {}) {
    this.enabled = options.enabled ?? true;
    this.codexHome = path.resolve(options.codexHome ?? defaultCodexHome());
    this.extraSkillRoots = (options.extraSkillRoots ?? []).map((item) => path.resolve(item));
    this.catalogMaxChars = Math.max(1_000, options.catalogMaxChars ?? DEFAULT_CATALOG_CHARS);
  }

  status() {
    const skills = this.enabled ? this.discoverSkills() : [];
    return {
      enabled: this.enabled,
      codexHome: this.codexHome,
      instructionSync: "initialization-and-on-demand" as const,
      skillSync: "catalog-first" as const,
      skillCount: skills.length,
    };
  }

  initializationInstructions(): string {
    if (!this.enabled) return "Codex-visible local instruction synchronization is disabled for this server.";

    const config = readCodexConfig(this.codexHome);
    const candidates: InstructionSource[] = [];
    const seen = new Set<string>();
    for (const workspace of this.registry.workspaces) {
      const instructionSet = this.loadInstructions(workspace.id, ".", MAX_PROJECT_DOC_BYTES);
      for (const source of instructionSet.sources) {
        const key = comparisonPath(source.path);
        if (seen.has(key)) continue;
        seen.add(key);
        candidates.push(source);
      }
    }

    const selected: InstructionSource[] = [];
    let usedBytes = 0;
    let truncated = false;
    for (const candidate of candidates) {
      const remaining = config.projectDocMaxBytes - usedBytes;
      if (remaining <= 0) {
        truncated = true;
        break;
      }
      const content = truncateUtf8(candidate.content, remaining);
      const sourceTruncated = candidate.truncated || content !== candidate.content;
      selected.push({ ...candidate, content, truncated: sourceTruncated });
      usedBytes += Buffer.byteLength(content, "utf8");
      if (sourceTruncated) {
        truncated = true;
        break;
      }
    }

    const header = [
      "The following are Codex-visible local AGENTS instructions for the configured workspaces.",
      "They are mandatory operating instructions for every use of this MCP server.",
      "OpenAI platform system and developer prompts are private runtime inputs and are not included.",
    ].join("\n");
    if (selected.length === 0) return `${header}\n\nNo local AGENTS instruction file was found.`;

    const bodies = selected.map((source) => [
      `--- ${source.scope} AGENTS: ${source.path}${source.truncated ? " (truncated)" : ""} ---`,
      source.content,
    ].join("\n"));
    const footer = truncated
      ? "The startup AGENTS payload was truncated at the configured Codex project document limit. Call codex_instructions for the current complete bounded chain before substantive work."
      : "For nested workspace directories or instructions changed after this MCP process started, call codex_instructions before substantive work.";
    return `${header}\n\n${bodies.join("\n\n")}\n\n${footer}`;
  }

  triggerSummary(): string {
    if (!this.enabled) return "Codex instruction and skill sync is disabled for this server.";
    const skills = this.discoverSkills().filter((skill) => skill.implicitInvocation);
    const header = [
      "Load a synced Codex skill when the user names it or the task matches its description.",
      "Only metadata is shown here; calling this tool loads the full SKILL.md on demand.",
      "Synced implicit-trigger catalog:",
    ].join("\n");
    const footer = "\nIf the catalog is incomplete, call list_codex_skills for the current full metadata index.";

    for (const descriptionLimit of [240, 120, 60]) {
      const lines: string[] = [];
      let omitted = 0;
      for (const skill of skills) {
        const description = compactText(skill.description, descriptionLimit);
        const line = `- ${skill.id} | ${skill.name}: ${description}`;
        const candidate = `${header}\n${lines.concat(line).join("\n")}${footer}`;
        if (candidate.length > this.catalogMaxChars) {
          omitted += 1;
          continue;
        }
        lines.push(line);
      }
      const omission = omitted > 0 ? `\n${omitted} additional skills omitted from this startup catalog.` : "";
      const result = `${header}\n${lines.join("\n")}${omission}${footer}`;
      if (result.length <= this.catalogMaxChars) return result;
    }

    return `${header}\nCatalog omitted because it exceeds the startup budget.${footer}`;
  }

  listSkills(workspace?: string, relativePath = ".", query?: string): SyncedSkill[] {
    this.assertEnabled();
    let skills = this.discoverSkills(workspace, relativePath);
    if (query) {
      const needle = query.toLowerCase();
      skills = skills.filter((skill) =>
        [skill.id, skill.name, skill.description, skill.scope, skill.source].some((value) => value.toLowerCase().includes(needle))
      );
    }
    return skills.map(({ root: _root, ...skill }) => skill);
  }

  loadSkill(selector: string, workspace?: string, relativePath = ".") {
    this.assertEnabled();
    const skill = this.resolveSkill(selector, workspace, relativePath);
    const fileStat = statSync(skill.sourcePath);
    if (fileStat.size > MAX_SKILL_FILE_BYTES) throw new Error("SKILL.md exceeds the 1 MB instruction limit.");
    const instructions = readUtf8(skill.sourcePath);
    const inventory = this.inventoryResources(skill.root);
    const { root: _root, ...metadata } = skill;
    return {
      ...metadata,
      root: skill.root,
      instructions,
      resources: inventory.files,
      resourcesTruncated: inventory.truncated,
    };
  }

  readSkillResource(
    selector: string,
    resourcePath: string,
    startLine: number,
    lineCount: number,
    workspace?: string,
    relativePath = ".",
  ): SkillResourceResult {
    this.assertEnabled();
    const skill = this.resolveSkill(selector, workspace, relativePath);
    const absolutePath = resolveInsideExisting(skill.root, resourcePath);
    const fileStat = statSync(absolutePath);
    if (!fileStat.isFile()) throw new Error("Skill resource path must be a file.");

    const mimeType = IMAGE_MIME_TYPES[path.extname(absolutePath).toLowerCase()];
    if (mimeType) {
      if (fileStat.size > MAX_IMAGE_BYTES) throw new Error("Skill image exceeds the 10 MB limit.");
      return {
        skillId: skill.id,
        path: slashPath(path.relative(skill.root, absolutePath)),
        format: "image",
        mimeType,
        size: fileStat.size,
        data: readFileSync(absolutePath).toString("base64"),
      };
    }

    if (fileStat.size > MAX_RESOURCE_BYTES) throw new Error("Skill resource exceeds the 5 MB text limit.");
    const buffer = readFileSync(absolutePath);
    if (buffer.subarray(0, Math.min(buffer.length, 8_192)).includes(0)) {
      throw new Error("Skill resource appears to be binary and is not a supported image.");
    }
    const lines = stripUtf8Bom(buffer.toString("utf8")).split(/\r?\n/);
    const startIndex = Math.min(startLine - 1, lines.length);
    const selected = lines.slice(startIndex, startIndex + lineCount);
    return {
      skillId: skill.id,
      path: slashPath(path.relative(skill.root, absolutePath)),
      format: "text",
      mimeType: textMimeType(absolutePath),
      size: fileStat.size,
      startLine,
      endLine: startIndex + selected.length,
      totalLines: lines.length,
      text: selected.join("\n"),
      truncated: startIndex + selected.length < lines.length,
    };
  }

  loadInstructions(workspace: string, relativePath = ".", requestedMaxBytes?: number) {
    this.assertEnabled();
    const target = this.registry.resolveExisting(workspace, relativePath);
    const targetStat = statSync(target);
    if (!targetStat.isDirectory()) throw new Error("Codex instruction path must be a directory.");

    const config = readCodexConfig(this.codexHome);
    const maxBytes = Math.min(
      MAX_PROJECT_DOC_BYTES,
      Math.max(1_024, requestedMaxBytes ?? config.projectDocMaxBytes),
    );
    const candidates: Array<{ scope: "global" | "project"; path: string }> = [];
    const global = firstExisting([
      path.join(this.codexHome, "AGENTS.override.md"),
      path.join(this.codexHome, "AGENTS.md"),
    ]);
    if (global) candidates.push({ scope: "global", path: global });

    const workspaceRoot = this.registry.get(workspace).root;
    for (const directory of directoriesBetween(workspaceRoot, target)) {
      const projectFile = firstExisting([
        path.join(directory, "AGENTS.override.md"),
        path.join(directory, "AGENTS.md"),
        ...config.projectDocFallbackFilenames.map((name) => path.join(directory, name)),
      ]);
      if (projectFile) {
        const realProjectFile = realpathSync.native(projectFile);
        if (!isInside(workspaceRoot, realProjectFile)) {
          throw new Error(`Project instruction file escapes the configured workspace: ${projectFile}`);
        }
        candidates.push({ scope: "project", path: realProjectFile });
      }
    }

    const sources: InstructionSource[] = [];
    let usedBytes = 0;
    let truncated = false;
    for (const candidate of candidates) {
      const separatorBytes = sources.length > 0 ? 2 : 0;
      const available = maxBytes - usedBytes - separatorBytes;
      if (available <= 0) {
        truncated = true;
        break;
      }
      const content = readUtf8(candidate.path);
      const contentBytes = Buffer.byteLength(content, "utf8");
      const selected = contentBytes <= available ? content : truncateUtf8(content, available);
      const sourceTruncated = selected !== content;
      sources.push({ scope: candidate.scope, path: candidate.path, content: selected, truncated: sourceTruncated });
      usedBytes += separatorBytes + Buffer.byteLength(selected, "utf8");
      if (sourceTruncated) {
        truncated = true;
        break;
      }
    }

    return {
      boundary:
        "Mirrors Codex-visible local AGENTS guidance. OpenAI platform system and developer prompts are private runtime inputs and are not accessible to this server.",
      workspace,
      path: this.registry.relative(workspace, target),
      maxBytes,
      sources,
      combined: sources.map((source) => source.content).join("\n\n"),
      truncated,
    };
  }

  private assertEnabled(): void {
    if (!this.enabled) throw new Error("Codex context sync is disabled for this server.");
  }

  private resolveSkill(selector: string, workspace?: string, relativePath = "."): SkillRecord {
    const skills = this.discoverSkills(workspace, relativePath);
    const byId = skills.find((skill) => skill.id === selector);
    if (byId) return byId;
    const byName = skills.filter((skill) => skill.name === selector);
    if (byName.length === 1) return byName[0];
    if (byName.length > 1) {
      throw new Error(`Skill name '${selector}' is ambiguous. Use one of these IDs: ${byName.map((skill) => skill.id).join(", ")}`);
    }
    throw new Error(`Unknown synced skill '${selector}'. Call list_codex_skills for current IDs.`);
  }

  private discoverSkills(workspace?: string, relativePath = "."): SkillRecord[] {
    const config = readCodexConfig(this.codexHome);
    const roots: SkillSearchRoot[] = [];
    addSearchRoot(roots, path.join(this.codexHome, "skills"), "user", "codex-home", 3);
    addSearchRoot(roots, path.join(path.dirname(this.codexHome), ".agents", "skills"), "user", "user", 2);

    for (const plugin of config.enabledPlugins) {
      const split = plugin.lastIndexOf("@");
      if (split <= 0) continue;
      const name = plugin.slice(0, split);
      const marketplace = plugin.slice(split + 1);
      const versionRoot = latestPluginVersion(path.join(this.codexHome, "plugins", "cache", marketplace, name));
      if (versionRoot) addSearchRoot(roots, path.join(versionRoot, "skills"), "plugin", plugin, 2);
    }
    for (const remote of installedRemotePluginRoots(this.codexHome)) {
      addSearchRoot(roots, path.join(remote.versionRoot, "skills"), "plugin", remote.source, 2);
    }

    const workspaces = workspace ? [this.registry.get(workspace)] : this.registry.workspaces;
    for (const item of workspaces) {
      const target = workspace ? this.registry.resolveExisting(item.id, relativePath) : item.root;
      const directory = statSync(target).isDirectory() ? target : path.dirname(target);
      for (const ancestor of directoriesBetween(item.root, directory)) {
        addSearchRoot(roots, path.join(ancestor, ".agents", "skills"), "project", item.id, 2);
      }
    }
    for (const extra of this.extraSkillRoots) addSearchRoot(roots, extra, "extra", "configured", 4);

    const records: SkillRecord[] = [];
    const seen = new Set<string>();
    for (const searchRoot of roots) {
      for (const skillFile of findSkillFiles(searchRoot.root, searchRoot.maxDepth)) {
        const realSkillFile = safeRealpath(skillFile);
        if (!realSkillFile) continue;
        const key = comparisonPath(realSkillFile);
        if (seen.has(key) || config.disabledSkillPaths.has(key)) continue;
        const record = parseSkillRecord(realSkillFile, searchRoot);
        if (!record) continue;
        seen.add(key);
        records.push(record);
      }
    }

    const priority: Record<SkillScope, number> = { project: 0, user: 1, system: 2, plugin: 3, extra: 4 };
    return records.sort((left, right) =>
      priority[left.scope] - priority[right.scope]
      || left.name.localeCompare(right.name)
      || left.sourcePath.localeCompare(right.sourcePath)
    );
  }

  private inventoryResources(root: string) {
    const files: Array<{ path: string; kind: "reference" | "script" | "asset" | "metadata" | "other"; size: number }> = [];
    const visited = new Set<string>();
    let truncated = false;
    const visit = (directory: string, depth: number) => {
      if (truncated || depth > 10) return;
      const directoryKey = comparisonPath(directory);
      if (visited.has(directoryKey)) return;
      visited.add(directoryKey);
      let entries;
      try {
        entries = readdirSync(directory, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (files.length >= MAX_RESOURCE_INVENTORY) {
          truncated = true;
          return;
        }
        if ([".git", "node_modules"].includes(entry.name)) continue;
        const absolutePath = path.join(directory, entry.name);
        const real = safeRealpath(absolutePath);
        if (!real || !isInside(root, real)) continue;
        const realStat = statSync(real);
        if (realStat.isDirectory()) visit(real, depth + 1);
        else if (realStat.isFile() && entry.name !== "SKILL.md") {
          const relative = slashPath(path.relative(root, real));
          files.push({ path: relative, kind: resourceKind(relative), size: statSync(real).size });
        }
      }
    };
    visit(root, 0);
    return { files, truncated };
  }
}

function addSearchRoot(
  roots: SkillSearchRoot[],
  root: string,
  scope: SkillScope,
  source: string,
  maxDepth: number,
): void {
  if (!existsSync(root)) return;
  roots.push({ root: path.resolve(root), scope, source, maxDepth });
}

function findSkillFiles(root: string, maxDepth: number): string[] {
  const results: string[] = [];
  const visited = new Set<string>();
  const visit = (directory: string, depth: number) => {
    if (depth > maxDepth) return;
    const realDirectory = safeRealpath(directory);
    if (!realDirectory) return;
    const directoryKey = comparisonPath(realDirectory);
    if (visited.has(directoryKey)) return;
    visited.add(directoryKey);
    const skillFile = path.join(realDirectory, "SKILL.md");
    if (existsSync(skillFile)) {
      results.push(skillFile);
      return;
    }
    let entries;
    try {
      entries = readdirSync(realDirectory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if ([".git", "node_modules", "assets", "examples", "references", "scripts", "templates"].includes(entry.name)) continue;
      const child = path.join(realDirectory, entry.name);
      const realChild = safeRealpath(child);
      if (!realChild || !statSync(realChild).isDirectory()) continue;
      visit(realChild, depth + 1);
    }
  };
  visit(root, 0);
  return results;
}

function parseSkillRecord(skillFile: string, searchRoot: SkillSearchRoot): SkillRecord | undefined {
  let contents: string;
  try {
    contents = readUtf8(skillFile);
  } catch {
    return undefined;
  }
  const frontmatter = parseFrontmatter(contents);
  if (!frontmatter.name || !frontmatter.description) return undefined;
  const root = path.dirname(skillFile);
  const relativeFromCodexSkills = slashPath(path.relative(searchRoot.root, skillFile));
  const scope = searchRoot.source === "codex-home" && relativeFromCodexSkills.startsWith(".system/")
    ? "system"
    : searchRoot.scope;
  return {
    id: `${safeName(frontmatter.name)}-${createHash("sha256").update(comparisonPath(skillFile)).digest("hex").slice(0, 10)}`,
    name: frontmatter.name,
    description: frontmatter.description,
    scope,
    source: searchRoot.source,
    sourcePath: skillFile,
    root,
    implicitInvocation: readImplicitInvocation(root),
  };
}

function parseFrontmatter(contents: string): { name?: string; description?: string } {
  const lines = contents.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return {};
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (end < 0) return {};
  const values: Record<string, string> = {};
  for (let index = 1; index < end; index += 1) {
    const match = lines[index].match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) continue;
    const [, key, raw] = match;
    if (/^[>|][+-]?$/.test(raw)) {
      const block: string[] = [];
      while (index + 1 < end && /^\s+/.test(lines[index + 1])) block.push(lines[++index].trim());
      values[key] = raw.startsWith(">") ? block.join(" ") : block.join("\n");
    } else {
      values[key] = unquoteYamlScalar(raw.trim());
    }
  }
  return { name: values.name, description: values.description };
}

function unquoteYamlScalar(value: string): string {
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value) as string;
    } catch {
      return value.slice(1, -1);
    }
  }
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replace(/''/g, "'");
  return value;
}

function readImplicitInvocation(root: string): boolean {
  const metadata = path.join(root, "agents", "openai.yaml");
  if (!existsSync(metadata)) return true;
  try {
    return !/^\s*allow_implicit_invocation\s*:\s*false\s*(?:#.*)?$/im.test(readUtf8(metadata));
  } catch {
    return true;
  }
}

function readCodexConfig(codexHome: string): CodexConfig {
  const defaults: CodexConfig = {
    projectDocMaxBytes: DEFAULT_PROJECT_DOC_BYTES,
    projectDocFallbackFilenames: [],
    disabledSkillPaths: new Set<string>(),
    enabledPlugins: new Set<string>(),
  };
  const configPath = path.join(codexHome, "config.toml");
  if (!existsSync(configPath)) return defaults;

  let contents: string;
  try {
    contents = readUtf8(configPath);
  } catch {
    return defaults;
  }
  const maxBytes = contents.match(/^\s*project_doc_max_bytes\s*=\s*(\d+)\s*$/m)?.[1];
  if (maxBytes) defaults.projectDocMaxBytes = Math.min(MAX_PROJECT_DOC_BYTES, Math.max(1_024, Number(maxBytes)));
  const fallback = contents.match(/^\s*project_doc_fallback_filenames\s*=\s*\[([^\]]*)\]/m)?.[1];
  if (fallback) {
    defaults.projectDocFallbackFilenames = [...fallback.matchAll(/["']([^"']+)["']/g)]
      .map((match) => match[1])
      .filter(isSafeFallbackFilename);
  }

  for (const block of contents.split(/(?=^\s*\[\[skills\.config\]\]\s*$)/m)) {
    if (!/^\s*\[\[skills\.config\]\]/m.test(block) || !/^\s*enabled\s*=\s*false\s*$/m.test(block)) continue;
    const configuredPath = block.match(/^\s*path\s*=\s*["']([^"']+)["']\s*$/m)?.[1];
    if (!configuredPath) continue;
    const resolved = path.isAbsolute(configuredPath) ? configuredPath : path.resolve(codexHome, configuredPath);
    defaults.disabledSkillPaths.add(comparisonPath(safeRealpath(resolved) ?? path.resolve(resolved)));
  }

  const pluginPattern = /^\s*\[plugins\."([^"]+)"\]\s*$([\s\S]*?)(?=^\s*\[|(?![\s\S]))/gm;
  for (const match of contents.matchAll(pluginPattern)) {
    if (/^\s*enabled\s*=\s*true\s*$/m.test(match[2])) defaults.enabledPlugins.add(match[1]);
  }
  return defaults;
}

function installedRemotePluginRoots(codexHome: string): Array<{ versionRoot: string; source: string }> {
  const cacheRoot = path.join(codexHome, "plugins", "cache");
  if (!existsSync(cacheRoot)) return [];
  const results: Array<{ versionRoot: string; source: string }> = [];
  for (const marketplace of safeDirectories(cacheRoot)) {
    for (const plugin of safeDirectories(marketplace.path)) {
      if (!existsSync(path.join(plugin.path, ".codex-remote-plugin-install.json"))) continue;
      const versionRoot = latestPluginVersion(plugin.path);
      if (versionRoot) results.push({ versionRoot, source: `${plugin.name}@${marketplace.name}` });
    }
  }
  return results;
}

function latestPluginVersion(pluginRoot: string): string | undefined {
  if (!existsSync(pluginRoot)) return undefined;
  const versions = safeDirectories(pluginRoot).filter((entry) => existsSync(path.join(entry.path, "skills")));
  versions.sort((left, right) => right.name.localeCompare(left.name, undefined, { numeric: true }));
  return versions[0]?.path;
}

function safeDirectories(root: string): Array<{ name: string; path: string }> {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({ name: entry.name, path: path.join(root, entry.name) }));
  } catch {
    return [];
  }
}

function directoriesBetween(root: string, target: string): string[] {
  if (!isInside(root, target)) throw new Error("Instruction target escapes the selected workspace.");
  const relative = path.relative(root, target);
  const directories = [root];
  if (!relative) return directories;
  let current = root;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    directories.push(current);
  }
  return directories;
}

function firstExisting(candidates: string[]): string | undefined {
  return candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile());
}

function isSafeFallbackFilename(value: string): boolean {
  return Boolean(value)
    && !path.isAbsolute(value)
    && value !== "."
    && value !== ".."
    && !value.includes("/")
    && !value.includes("\\")
    && !value.includes("\0");
}

function resolveInsideExisting(root: string, relativePath: string): string {
  if (!relativePath || relativePath.includes("\0") || path.isAbsolute(relativePath)) {
    throw new Error("Use a non-empty skill-relative resource path.");
  }
  const lexical = path.resolve(root, relativePath);
  if (!isInside(root, lexical) || !existsSync(lexical)) throw new Error(`Invalid or missing skill resource: ${relativePath}`);
  const real = realpathSync.native(lexical);
  if (!isInside(root, real)) throw new Error(`Skill resource escapes its root through a symbolic link: ${relativePath}`);
  return real;
}

function comparisonPath(value: string): string {
  const normalized = path.normalize(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(comparisonPath(root), comparisonPath(target));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function safeRealpath(value: string): string | undefined {
  try {
    return realpathSync.native(value);
  } catch {
    return undefined;
  }
}

function readUtf8(filePath: string): string {
  return stripUtf8Bom(readFileSync(filePath, "utf8"));
}

function stripUtf8Bom(value: string): string {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}

function truncateUtf8(value: string, maxBytes: number): string {
  const buffer = Buffer.from(value, "utf8");
  if (buffer.length <= maxBytes) return value;
  return buffer.subarray(0, maxBytes).toString("utf8").replace(/\uFFFD$/, "");
}

function compactText(value: string, maxChars: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length <= maxChars ? compact : `${compact.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`;
}

function safeName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "skill";
}

function slashPath(value: string): string {
  return value.split(path.sep).join("/");
}

function resourceKind(relativePath: string): "reference" | "script" | "asset" | "metadata" | "other" {
  const first = relativePath.split("/", 1)[0].toLowerCase();
  if (first === "references") return "reference";
  if (first === "scripts") return "script";
  if (first === "assets" || first === "templates") return "asset";
  if (first === "agents") return "metadata";
  return "other";
}

function textMimeType(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".json") return "application/json";
  if (extension === ".yaml" || extension === ".yml") return "application/yaml";
  if (extension === ".md") return "text/markdown";
  return "text/plain";
}
