import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";

export async function makeAgentTemp(prefix: string): Promise<{ directory: string; cleanup: () => Promise<void> }> {
  const base = process.platform === "win32"
    ? path.join(process.env.LOCALAPPDATA ?? "C:\\Users\\Public\\AppData\\Local", "Temp", ".agents")
    : "/tmp/.agents";
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(path.join(base, `${prefix}-`));
  return { directory, cleanup: () => rm(directory, { recursive: true, force: true }) };
}
