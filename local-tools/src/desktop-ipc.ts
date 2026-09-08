import { createServer, type Server } from "node:http";
import { DesktopOperations } from "./desktop-operations.js";

export const DESKTOP_IPC_PORT = Number(process.env.CODEX_CHAT_DESKTOP_IPC_PORT ?? "3345");

interface DesktopRequest {
  operation: string;
  arguments?: Record<string, unknown>;
}

export async function dispatchDesktopRequest(request: DesktopRequest) {
  const desktop = new DesktopOperations();
  const args = request.arguments ?? {};
  switch (request.operation) {
    case "state": return desktop.state();
    case "screenshot": return desktop.screenshot(numberArg(args, "width", 1440), optionalNumberArg(args, "windowId"));
    case "mouse": return desktop.mouse(stringArg(args, "action") as any, optionalNumberArg(args, "x"), optionalNumberArg(args, "y"), numberArg(args, "deltaY", 0), numberArg(args, "deltaX", 0));
    case "keyboard": return desktop.keyboard(optionalStringArg(args, "text"), optionalStringArg(args, "key"), numberArg(args, "repeat", 1));
    case "find": return desktop.find(numberArg(args, "windowId"), optionalStringArg(args, "role"), optionalStringArg(args, "label"), optionalStringArg(args, "value"), numberArg(args, "maxResults", 20));
    case "ui_action": return desktop.uiAction({
      windowId: numberArg(args, "windowId"),
      operation: stringArg(args, "operation") as any,
      role: optionalStringArg(args, "role"),
      label: optionalStringArg(args, "label"),
      action: optionalStringArg(args, "action"),
      value: optionalStringArg(args, "value"),
    });
    default: throw new Error(`Unsupported desktop operation: ${request.operation}`);
  }
}

export function startDesktopIpcServer(): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer(async (req, res) => {
      if (req.method !== "POST" || req.url !== "/desktop") {
        res.writeHead(404).end();
        return;
      }
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        const request = JSON.parse(Buffer.concat(chunks).toString("utf8")) as DesktopRequest;
        const result = await dispatchDesktopRequest(request);
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, result }));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ ok: false, error: message }));
      }
    });
    server.once("error", reject);
    server.listen(DESKTOP_IPC_PORT, "127.0.0.1", () => resolve(server));
  });
}

export async function callDesktopIpc(request: DesktopRequest) {
  const response = await fetch(`http://127.0.0.1:${DESKTOP_IPC_PORT}/desktop`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
  });
  const body = await response.json() as { ok: boolean; result?: unknown; error?: string };
  if (!response.ok || !body.ok) throw new Error(body.error ?? `desktop IPC failed with HTTP ${response.status}`);
  return body.result;
}

function stringArg(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  return value;
}
function optionalStringArg(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  return value;
}
function numberArg(args: Record<string, unknown>, name: string, fallback?: number): number {
  const value = args[name] ?? fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${name} must be a number`);
  return value;
}
function optionalNumberArg(args: Record<string, unknown>, name: string): number | undefined {
  const value = args[name];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${name} must be a number`);
  return value;
}
