import { existsSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

export interface Workspace {
  id: string;
  root: string;
}

function comparisonPath(value: string): string {
  const normalized = path.normalize(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(comparisonPath(root), comparisonPath(target));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function safeId(value: string): string {
  const cleaned = value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned || "workspace";
}

export class WorkspaceRegistry {
  readonly workspaces: Workspace[];

  constructor(roots: string[]) {
    if (roots.length === 0) {
      throw new Error("At least one workspace root is required.");
    }

    const seenRoots = new Set<string>();
    const usedIds = new Set<string>();
    const items: Workspace[] = [];

    for (const rawRoot of roots) {
      const resolved = path.resolve(rawRoot);
      if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
        throw new Error(`Workspace root is not a directory: ${resolved}`);
      }
      const root = realpathSync.native(resolved);
      const rootKey = comparisonPath(root);
      if (seenRoots.has(rootKey)) continue;
      seenRoots.add(rootKey);

      const base = safeId(path.basename(root));
      let id = base;
      let suffix = 2;
      while (usedIds.has(id)) id = `${base}-${suffix++}`;
      usedIds.add(id);
      items.push({ id, root });
    }

    this.workspaces = items;
  }

  get(id: string): Workspace {
    const workspace = this.workspaces.find((item) => item.id === id);
    if (!workspace) {
      throw new Error(`Unknown workspace '${id}'. Available: ${this.workspaces.map((item) => item.id).join(", ")}`);
    }
    return workspace;
  }

  resolveExisting(workspaceId: string, relativePath = "."): string {
    const workspace = this.get(workspaceId);
    const candidate = this.lexicalPath(workspace, relativePath);
    if (!existsSync(candidate)) throw new Error(`Path does not exist: ${relativePath}`);
    const real = realpathSync.native(candidate);
    if (!isInside(workspace.root, real)) {
      throw new Error(`Path escapes workspace through a symbolic link: ${relativePath}`);
    }
    return real;
  }

  resolveProspective(workspaceId: string, relativePath: string): string {
    const workspace = this.get(workspaceId);
    const candidate = this.lexicalPath(workspace, relativePath);
    let ancestor = candidate;
    while (!existsSync(ancestor)) {
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw new Error(`Cannot resolve an ancestor for: ${relativePath}`);
      ancestor = parent;
    }
    const realAncestor = realpathSync.native(ancestor);
    if (!isInside(workspace.root, realAncestor)) {
      throw new Error(`Path escapes workspace through a symbolic link: ${relativePath}`);
    }
    return candidate;
  }

  relative(workspaceId: string, absolutePath: string): string {
    return path.relative(this.get(workspaceId).root, absolutePath).split(path.sep).join("/") || ".";
  }

  private lexicalPath(workspace: Workspace, relativePath: string): string {
    if (relativePath.includes("\0")) throw new Error("Paths cannot contain NUL characters.");
    if (path.isAbsolute(relativePath)) throw new Error("Use a workspace-relative path, not an absolute path.");
    const candidate = path.resolve(workspace.root, relativePath);
    if (!isInside(workspace.root, candidate)) throw new Error(`Path escapes workspace: ${relativePath}`);
    return candidate;
  }
}

export function rootsFromEnvironment(cwd: string, cliRoots: string[]): string[] {
  if (cliRoots.length > 0) return cliRoots;
  const configured = process.env.CODEX_CHAT_LOCAL_ROOTS;
  if (!configured) return [cwd];
  return configured.split(path.delimiter).map((item) => item.trim()).filter(Boolean);
}
