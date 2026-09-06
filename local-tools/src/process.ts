import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

const FORCE_CLOSE_GRACE_MS = 1_000;

export interface ProcessResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
}

export interface ProcessOptions {
  cwd: string;
  input?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  env?: NodeJS.ProcessEnv;
}

export async function runProcess(
  executable: string,
  args: string[],
  options: ProcessOptions,
): Promise<ProcessResult> {
  const timeoutMs = options.timeoutMs ?? 90_000;
  const maxOutputBytes = options.maxOutputBytes ?? 200_000;

  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      detached: process.platform !== "win32",
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = Buffer.alloc(0) as Buffer<ArrayBufferLike>;
    let stderr = Buffer.alloc(0) as Buffer<ArrayBufferLike>;
    let truncated = false;
    let timedOut = false;
    let settled = false;
    let forceCloseTimer: NodeJS.Timeout | undefined;

    const cleanupTimers = () => {
      clearTimeout(timer);
      if (forceCloseTimer) clearTimeout(forceCloseTimer);
    };

    const finish = (exitCode: number | null, forceStreamsClosed = false) => {
      if (settled) return;
      settled = true;
      cleanupTimers();
      if (forceStreamsClosed) {
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
      }
      resolve({
        exitCode,
        stdout: stdout.toString("utf8"),
        stderr: stderr.toString("utf8"),
        timedOut,
        truncated,
      });
    };

    const append = (current: Buffer<ArrayBufferLike>, chunk: Buffer<ArrayBufferLike>): Buffer<ArrayBufferLike> => {
      const remaining = maxOutputBytes - current.length;
      if (remaining <= 0) {
        truncated = true;
        return current;
      }
      if (chunk.length > remaining) {
        truncated = true;
        return Buffer.concat([current, chunk.subarray(0, remaining)]);
      }
      return Buffer.concat([current, chunk]);
    };

    child.stdout.on("data", (chunk: Buffer) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      cleanupTimers();
      reject(error);
    });

    const timer = setTimeout(() => {
      timedOut = true;
      terminateProcessTree(child);
      forceCloseTimer = setTimeout(() => finish(null, true), FORCE_CLOSE_GRACE_MS);
    }, timeoutMs);

    child.on("close", (exitCode) => {
      finish(exitCode);
    });

    if (options.input !== undefined) {
      child.stdin.end(options.input, "utf8");
    } else {
      child.stdin.end();
    }
  });
}

function terminateProcessTree(child: ChildProcessWithoutNullStreams): void {
  if (!child.pid) {
    child.kill("SIGKILL");
    return;
  }

  if (process.platform === "win32") {
    const killer = spawn("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], {
      windowsHide: true,
      stdio: "ignore",
    });
    killer.once("error", () => child.kill("SIGKILL"));
    killer.unref();
    return;
  }

  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

export function shellInvocation(command: string): { executable: string; args: string[] } {
  if (process.platform === "win32") {
    return {
      executable: "powershell.exe",
      args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
    };
  }
  return { executable: "bash", args: ["-lc", command] };
}
