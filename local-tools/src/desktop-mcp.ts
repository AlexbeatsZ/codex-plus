import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";

const DESKTOP_TOKEN = "codex-plus-desktop-loopback";
const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(moduleDirectory, "..", "..");
const defaultStateDirectory = path.join(repositoryRoot, ".codex-plus");

const readonlyAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const actionAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;

type JsonObject = Record<string, unknown>;
interface DesktopScreen { left: number; top: number; width: number; height: number; backingPixelWidth: number; backingPixelHeight: number; scaleFactor?: number; }
interface DesktopStateResult extends JsonObject { screen: DesktopScreen; }
interface ScreenshotResult extends JsonObject { path: string; width: number; height: number; }
interface Observation { state: JsonObject; screenshot: ScreenshotResult; imageData: string; mimeType: "image/png"; }

export class DesktopClient {
  readonly stateDirectory: string;
  constructor(stateDirectory = process.env.CODEX_PLUS_STATE_DIR ?? defaultStateDirectory) { this.stateDirectory = path.resolve(stateDirectory); }
  async request<T extends JsonObject>(request: JsonObject): Promise<T> {
    const endpointPath = path.join(this.stateDirectory, "desktop-endpoint.json");
    const endpoint = JSON.parse(await readFile(endpointPath, "utf8")) as { port?: unknown };
    const port = Number(endpoint.port);
    if (!Number.isInteger(port) || port <= 0 || port > 65_535) throw new Error(`Desktop helper endpoint contains an invalid port: ${endpointPath}`);
    let response: Response;
    try {
      response = await fetch(`http://127.0.0.1:${port}/v1/desktop`, {
        method: "POST",
        headers: { authorization: `Bearer ${DESKTOP_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      throw new Error(`codex-plus desktop helper is not reachable on 127.0.0.1:${port}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const body = await response.json().catch(() => null) as { ok?: boolean; result?: T; error?: { message?: string } } | null;
    if (!response.ok || body?.ok !== true || body.result == null) throw new Error(body?.error?.message ?? `codex-plus desktop helper returned HTTP ${response.status}`);
    return body.result;
  }
  async state(): Promise<DesktopStateResult> { return this.request<DesktopStateResult>({ operation: "state" }); }
  async observe(): Promise<Observation> {
    const state = await this.state();
    const screenshot = await this.request<ScreenshotResult>({ operation: "screenshot" });
    const screenshotPath = path.resolve(screenshot.path);
    const allowedRoot = `${path.join(this.stateDirectory, "desktop")}${path.sep}`;
    if (!screenshotPath.startsWith(allowedRoot)) throw new Error(`Desktop helper returned a screenshot outside its state directory: ${screenshotPath}`);
    return { state, screenshot, imageData: (await readFile(screenshotPath)).toString("base64"), mimeType: "image/png" };
  }
  async pointFromScreenshot(x: number, y: number): Promise<{ x: number; y: number; screen: DesktopScreen }> {
    const state = await this.state();
    const point = screenshotPointToNative(state.screen, x, y);
    return { ...point, screen: state.screen };
  }
}

export function screenshotPointToNative(screen: DesktopScreen, x: number, y: number): { x: number; y: number } {
  for (const [label, value] of Object.entries({ left: screen.left, top: screen.top, width: screen.width, height: screen.height, backingPixelWidth: screen.backingPixelWidth, backingPixelHeight: screen.backingPixelHeight, x, y })) {
    if (!Number.isFinite(value)) throw new Error(`${label} must be finite`);
  }
  if (screen.width <= 0 || screen.height <= 0 || screen.backingPixelWidth <= 0 || screen.backingPixelHeight <= 0) throw new Error("Desktop screen dimensions must be positive");
  if (x < 0 || y < 0 || x >= screen.backingPixelWidth || y >= screen.backingPixelHeight) throw new Error(`Screenshot coordinate (${x}, ${y}) is outside ${screen.backingPixelWidth}x${screen.backingPixelHeight}`);
  return { x: screen.left + (x * screen.width) / screen.backingPixelWidth, y: screen.top + (y * screen.height) / screen.backingPixelHeight };
}

function textContent(value: unknown) { return { type: "text" as const, text: JSON.stringify(value, null, 2) }; }
function observationContent(observation: Observation, extra?: JsonObject) {
  const metadata = { ...extra, state: observation.state, screenshot: { width: observation.screenshot.width, height: observation.screenshot.height, coordinateSpace: "screenshot-pixels", note: "Pass x/y exactly as seen in this image; Retina scaling is handled by the MCP server." } };
  return { content: [textContent(metadata), { type: "image" as const, data: observation.imageData, mimeType: observation.mimeType }] };
}
async function actionResult(client: DesktopClient, result: JsonObject, observeAfter: boolean) { return observeAfter ? observationContent(await client.observe(), { actionResult: result }) : { content: [textContent(result)] }; }

const exactString = z.string().min(1);
const appInput = exactString.describe("macOS process/application name as shown by computer_windows, for example Google Chrome or ChatGPT");
const observeAfterInput = z.boolean().default(true).describe("Return a fresh screenshot after the action");

export function createDesktopMcpServer(client = new DesktopClient()): McpServer {
  const server = new McpServer({ name: "codex-plus-computer-use", version: "0.1.0" }, { instructions: [
    "This server controls the current macOS desktop through the local codex-plus desktop helper.",
    "Call computer_observe before coordinate actions. All x/y inputs use pixels in the screenshot returned by computer_observe, not macOS Quartz points; Retina conversion is automatic.",
    "Prefer Accessibility tools over coordinate clicks when an element can be identified. After UI-changing actions, use the returned screenshot or call computer_observe again before the next coordinate action.",
  ].join("\n") });

  server.registerTool("computer_observe", { title: "Observe desktop", description: "Capture the main macOS display and return a screenshot plus cursor, screen geometry, and visible windows. Use the screenshot's pixel coordinates directly with computer_click/computer_move/computer_scroll.", inputSchema: {}, annotations: readonlyAnnotations }, async () => observationContent(await client.observe()));
  server.registerTool("computer_windows", { title: "List desktop windows", description: "List visible top-level macOS windows with process names, titles, and Quartz-point bounds.", inputSchema: {}, annotations: readonlyAnnotations }, async () => ({ content: [textContent(await client.request({ operation: "windows" }))] }));
  server.registerTool("computer_permissions", { title: "Check desktop permissions", description: "Check whether codex-plus currently has macOS post-event and screen-capture permission.", inputSchema: {}, annotations: readonlyAnnotations }, async () => ({ content: [textContent(await client.request({ operation: "permissions" }))] }));

  server.registerTool("computer_click", { title: "Click desktop", description: "Click a point using screenshot pixel coordinates from computer_observe. Retina scaling is automatic. Supports left/right and single/double click.", inputSchema: { x: z.number().finite().nonnegative(), y: z.number().finite().nonnegative(), button: z.enum(["left", "right"]).default("left"), clicks: z.union([z.literal(1), z.literal(2)]).default(1), observeAfter: observeAfterInput }, annotations: actionAnnotations }, async ({ x, y, button, clicks, observeAfter }) => {
    const point = await client.pointFromScreenshot(x, y);
    const action = button === "right" ? "right_click" : clicks === 2 ? "double_click" : "click";
    const result = await client.request<JsonObject>({ operation: "mouse", action, x: point.x, y: point.y });
    return actionResult(client, { ...result, screenshotPoint: { x, y }, nativePoint: { x: point.x, y: point.y } }, observeAfter);
  });
  server.registerTool("computer_move", { title: "Move pointer", description: "Move the pointer to screenshot pixel coordinates from computer_observe. Use this for hover interactions.", inputSchema: { x: z.number().finite().nonnegative(), y: z.number().finite().nonnegative(), observeAfter: z.boolean().default(false) }, annotations: actionAnnotations }, async ({ x, y, observeAfter }) => {
    const point = await client.pointFromScreenshot(x, y);
    const result = await client.request<JsonObject>({ operation: "mouse", action: "move", x: point.x, y: point.y });
    return actionResult(client, { ...result, screenshotPoint: { x, y }, nativePoint: { x: point.x, y: point.y } }, observeAfter);
  });
  server.registerTool("computer_scroll", { title: "Scroll desktop", description: "Scroll at the current pointer location. deltaY is in screenshot pixels: positive scrolls down, negative scrolls up. Optionally move the pointer to x/y first.", inputSchema: { deltaY: z.number().finite().min(-20_000).max(20_000), x: z.number().finite().nonnegative().optional(), y: z.number().finite().nonnegative().optional(), observeAfter: observeAfterInput }, annotations: actionAnnotations }, async ({ deltaY, x, y, observeAfter }) => {
    if ((x == null) !== (y == null)) throw new Error("computer_scroll requires both x and y when either is supplied");
    let nativePoint: { x: number; y: number } | undefined;
    if (x != null && y != null) { nativePoint = await client.pointFromScreenshot(x, y); await client.request({ operation: "mouse", action: "move", x: nativePoint.x, y: nativePoint.y }); }
    const result = await client.request<JsonObject>({ operation: "mouse", action: "scroll", deltaY: -deltaY });
    return actionResult(client, { ...result, deltaY, ...(nativePoint ? { nativePoint } : {}) }, observeAfter);
  });
  server.registerTool("computer_type", { title: "Type text", description: "Type Unicode text into the currently focused control using the codex-plus CoreGraphics text path.", inputSchema: { text: z.string().max(100_000), observeAfter: observeAfterInput }, annotations: actionAnnotations }, async ({ text, observeAfter }) => actionResult(client, await client.request<JsonObject>({ operation: "keyboard", text }), observeAfter));
  server.registerTool("computer_key", { title: "Press key chord", description: "Press a key or chord such as RETURN, TAB, ESC, CMD+L, CMD+A, CMD+C, or SHIFT+TAB.", inputSchema: { key: exactString.max(100), observeAfter: observeAfterInput }, annotations: actionAnnotations }, async ({ key, observeAfter }) => actionResult(client, await client.request<JsonObject>({ operation: "keyboard", key }), observeAfter));
  server.registerTool("computer_find_element", { title: "Find accessibility elements", description: "Search macOS Accessibility elements in one application. name, role, description, and windowTitle are exact-match filters. Prefer this before coordinate clicking when possible.", inputSchema: { app: appInput, name: z.string().optional(), role: z.string().optional(), description: z.string().optional(), windowTitle: z.string().optional(), limit: z.number().int().min(1).max(100).default(20), maxDepth: z.number().int().min(0).max(12).default(7), maxVisited: z.number().int().min(1).max(3_000).default(800) }, annotations: readonlyAnnotations }, async (input) => ({ content: [textContent(await client.request({ operation: "uia_find", ...input }))] }));
  server.registerTool("computer_element_action", { title: "Act on accessibility element", description: "Act on the first macOS Accessibility element matching the exact filters. set_value requires value.", inputSchema: { app: appInput, action: z.enum(["click", "invoke", "focus", "set_value"]), name: z.string().optional(), role: z.string().optional(), description: z.string().optional(), windowTitle: z.string().optional(), value: z.string().optional(), maxDepth: z.number().int().min(0).max(12).default(7), maxVisited: z.number().int().min(1).max(3_000).default(800), observeAfter: observeAfterInput }, annotations: actionAnnotations }, async ({ observeAfter, ...input }) => {
    if (input.action === "set_value" && input.value == null) throw new Error("set_value requires value");
    return actionResult(client, await client.request<JsonObject>({ operation: "uia_action", ...input }), observeAfter);
  });
  return server;
}
