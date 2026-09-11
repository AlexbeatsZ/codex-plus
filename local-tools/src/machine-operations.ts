import { LocalOperations } from "./operations.js";
import { runProcess } from "./process.js";
import { WorkspaceRegistry } from "./workspaces.js";

export type MachineId = "omen" | "mac" | "rog";

export interface MachineDefinition {
  id: MachineId;
  label: string;
  platform: "win32" | "darwin";
  sshTarget: string;
  sshFallbackTarget: string;
  workspaceRoot: string;
}

interface HostRpcResponse<T> {
  ok: boolean;
  result?: T;
  error?: string;
}

const DEFAULT_MACHINES: Record<MachineId, MachineDefinition> = {
  omen: {
    id: "omen",
    label: "Windows PC Meta-OMEN",
    platform: "win32",
    sshTarget: "meta@192.168.31.214",
    sshFallbackTarget: "meta@100.113.70.121",
    workspaceRoot: "C:/Users/Meta/Project/Workspaces/codex-plus",
  },
  mac: {
    id: "mac",
    label: "MacBook Pro",
    platform: "darwin",
    sshTarget: "meta@192.168.31.174",
    sshFallbackTarget: "meta@100.64.2.94",
    workspaceRoot: "/Users/meta/Project/Workspaces/codex-plus",
  },
  rog: {
    id: "rog",
    label: "Windows ROG Meta-ROGAlly",
    platform: "win32",
    sshTarget: "meta@192.168.31.32",
    sshFallbackTarget: "meta@100.106.169.46",
    workspaceRoot: "C:/Users/Meta/Project/Workspaces/codex-plus",
  },
};

export function machineDefinition(id: MachineId): MachineDefinition {
  const base = DEFAULT_MACHINES[id];
  const prefix = id === "omen" ? "CODEX_PLUS_OMEN" : id === "mac" ? "CODEX_PLUS_MAC" : "CODEX_PLUS_ROG";
  return {
    ...base,
    sshTarget: process.env[`${prefix}_SSH_TARGET`] ?? base.sshTarget,
    sshFallbackTarget: process.env[`${prefix}_SSH_FALLBACK_TARGET`] ?? base.sshFallbackTarget,
    workspaceRoot: process.env[`${prefix}_WORKSPACE_ROOT`] ?? base.workspaceRoot,
  };
}

export function localMachineId(): MachineId {
  const configured = process.env.CODEX_PLUS_MACHINE_ID?.trim().toLowerCase();
  if (configured === "omen" || configured === "mac" || configured === "rog") return configured;
  if (process.platform === "win32") return "omen";
  if (process.platform === "darwin") return "mac";
  throw new Error(`Unsupported gateway platform: ${process.platform}`);
}

export class MachineOperations {
  readonly local: LocalOperations;

  constructor(readonly registry: WorkspaceRegistry) {
    this.local = new LocalOperations(registry);
  }

  info() {
    const localId = localMachineId();
    return {
      localMachine: localId,
      machines: (["omen", "mac", "rog"] as const).map((id) => ({ ...machineDefinition(id), local: id === localId })),
    };
  }

  async workspaceInfo(machine: MachineId) {
    if (machine === localMachineId()) return { workspaces: this.registry.workspaces };
    return this.remoteCall<{ workspaces: Array<{ id: string; root: string }> }>(machine, "workspace_info", {}, 15_000);
  }

  async listFiles(machine: MachineId, workspace: string, path: string, glob: string | undefined, limit: number) {
    if (machine === localMachineId()) return this.local.listFiles(workspace, path, glob, limit);
    return this.remoteCall<{ files: string[]; truncated: boolean }>(machine, "list_files", { workspace, path, glob, limit }, 35_000);
  }

  async searchText(machine: MachineId, workspace: string, path: string, query: string, fixed: boolean, glob: string | undefined, limit: number) {
    if (machine === localMachineId()) return this.local.searchText(workspace, path, query, fixed, glob, limit);
    return this.remoteCall<{ matches: Array<{ path: string; line: number; column: number; text: string }>; truncated: boolean }>(machine, "search_text", { workspace, path, query, fixed, glob, limit }, 35_000);
  }

  async readText(machine: MachineId, workspace: string, path: string, startLine: number, lineCount: number) {
    if (machine === localMachineId()) return this.local.readText(workspace, path, startLine, lineCount);
    return this.remoteCall<{ path: string; startLine: number; endLine: number; totalLines: number; text: string; truncated: boolean }>(machine, "read_file", { workspace, path, startLine, lineCount }, 35_000);
  }

  async readImage(machine: MachineId, workspace: string, path: string) {
    if (machine === localMachineId()) return this.local.readImage(workspace, path);
    return this.remoteCall<{ path: string; mimeType: string; size: number; data: string }>(machine, "read_image", { workspace, path }, 35_000, 16_000_000);
  }

  async applyPatch(machine: MachineId, workspace: string, patch: string) {
    if (machine === localMachineId()) return this.local.applyPatch(workspace, patch);
    return this.remoteCall<{ applied: boolean; paths: string[] }>(machine, "apply_patch", { workspace, patch }, 35_000);
  }

  async runCommand(machine: MachineId, workspace: string, cwd: string, command: string, timeoutSeconds: number) {
    if (machine === localMachineId()) return this.local.runCommand(workspace, cwd, command, timeoutSeconds);
    return this.remoteCall<{ exitCode: number | null; stdout: string; stderr: string; timedOut: boolean; truncated: boolean }>(machine, "run_command", { workspace, cwd, command, timeoutSeconds }, (timeoutSeconds + 5) * 1_000);
  }

  async gitStatus(machine: MachineId, workspace: string) {
    if (machine === localMachineId()) return { status: await this.local.gitStatus(workspace) };
    return this.remoteCall<{ status: string }>(machine, "git_status", { workspace }, 35_000);
  }

  async gitDiff(machine: MachineId, workspace: string, staged: boolean, path: string | undefined) {
    if (machine === localMachineId()) return this.local.gitDiff(workspace, staged, path);
    return this.remoteCall<{ diff: string; truncated: boolean }>(machine, "git_diff", { workspace, staged, path }, 35_000);
  }

  private async remoteCall<T>(machine: MachineId, operation: string, args: Record<string, unknown>, timeoutMs: number, maxOutputBytes = 2_000_000): Promise<T> {
    const target = machineDefinition(machine);
    const localRoot = this.registry.workspaces[0]?.root ?? process.cwd();
    const input = JSON.stringify({ operation, arguments: args });
    const failures: string[] = [];
    for (const sshTarget of [target.sshTarget, target.sshFallbackTarget]) {
      const sshArgs = [
        "-o", "BatchMode=yes",
        "-o", "ConnectTimeout=5",
        "-o", "StrictHostKeyChecking=accept-new",
        sshTarget,
        ...remoteRpcCommand(target),
      ];
      const result = await runProcess("ssh", sshArgs, {
        cwd: localRoot,
        input,
        timeoutMs,
        maxOutputBytes,
      });
      if (result.timedOut) throw new Error(`${machine} host-rpc timed out via ${sshTarget}`);
      const text = result.stdout.trim();
      let response: HostRpcResponse<T> | undefined;
      try {
        response = JSON.parse(text) as HostRpcResponse<T>;
      } catch {
        const detail = result.stderr.trim() || text || `exit code ${result.exitCode}`;
        if (result.exitCode !== 0) {
          failures.push(`${sshTarget}: ${detail}`);
          continue;
        }
        throw new Error(`${machine} host-rpc returned invalid JSON via ${sshTarget}: ${detail}`);
      }
      if (!response.ok || response.result === undefined) {
        throw new Error(response.error ?? `${machine} host-rpc failed`);
      }
      if (result.exitCode !== 0) {
        failures.push(`${sshTarget}: ${result.stderr.trim() || `exit code ${result.exitCode}`}`);
        continue;
      }
      return response.result;
    }
    throw new Error(`${machine} host-rpc unavailable: ${failures.join("; ")}`);
  }
}

function remoteRpcCommand(machine: MachineDefinition): string[] {
  const root = machine.workspaceRoot.replace(/\\/g, "/");
  if (machine.platform === "win32") {
    return [
      "powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-File", `${root}/local-tools/scripts/host-rpc.ps1`, "-Root", root,
    ];
  }
  return ["/bin/bash", `${root}/local-tools/scripts/host-rpc.sh`, root];
}