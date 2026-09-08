#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TOKEN = "codex-plus-desktop-loopback";
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDir, "..", "..");
const stateDir = process.env.CODEX_PLUS_STATE_DIR
  ? path.resolve(process.env.CODEX_PLUS_STATE_DIR)
  : path.join(repositoryRoot, ".codex-plus");

function fail(message) {
  console.error(message);
  process.exit(2);
}

function parseNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) fail(`${label} must be a number`);
  return number;
}

function parseOptions(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) fail(`Unexpected argument: ${value}`);
    const equal = value.indexOf("=");
    const key = (equal >= 0 ? value.slice(2, equal) : value.slice(2)).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    const raw = equal >= 0 ? value.slice(equal + 1) : values[++index];
    if (raw === undefined) fail(`Missing value for --${key}`);
    result[key] = raw;
  }
  return result;
}

function buildRequest(args) {
  const [command, subcommand, ...rest] = args;
  if (!command) fail("Usage: desktop-helper.mjs <state|windows|screenshot|mouse|keyboard|uia|permissions|codex-task> ...");
  if (command === "state") return { operation: "state" };
  if (command === "windows") return { operation: "windows" };
  if (command === "permissions") {
    if (!subcommand) return { operation: "permissions" };
    if (subcommand !== "request") fail("permissions accepts only the optional request subcommand");
    const options = parseOptions(rest);
    return {
      operation: "request_permissions",
      postEvents: options.postEvents === "true",
      screenCapture: options.screenCapture === "true",
    };
  }
  if (command === "codex-task") {
    if (subcommand === "start64") {
      if (rest.length !== 1) fail("codex-task start64 requires one base64 prompt");
      return { operation: "codex_task_start", prompt: Buffer.from(rest[0], "base64").toString("utf8") };
    }
    if (subcommand === "status") {
      if (rest.length < 1) fail("codex-task status requires a job id");
      const [jobId, ...optionArgs] = rest;
      const options = parseOptions(optionArgs);
      return {
        operation: "codex_task_status",
        jobId,
        ...(options.waitMs !== undefined ? { waitMs: parseNumber(options.waitMs, "waitMs") } : {}),
      };
    }
    if (subcommand === "cancel") {
      if (rest.length !== 1) fail("codex-task cancel requires a job id");
      return { operation: "codex_task_cancel", jobId: rest[0] };
    }
    fail("codex-task requires start64, status, or cancel");
  }
  if (command === "screenshot") {
    const options = parseOptions(subcommand ? [subcommand, ...rest] : []);
    return { operation: "screenshot", ...(options.scope ? { scope: options.scope } : {}) };
  }
  if (command === "mouse") {
    const action = subcommand;
    if (!action) fail("mouse requires an action");
    if (action === "move" || action === "click" || action === "double_click" || action === "right_click") {
      if (rest.length !== 0 && rest.length !== 2) fail(`${action} accepts either no coordinates or x y`);
      return {
        operation: "mouse",
        action,
        ...(rest.length === 2 ? { x: parseNumber(rest[0], "x"), y: parseNumber(rest[1], "y") } : {}),
      };
    }
    if (action === "scroll") {
      if (rest.length !== 1) fail("scroll requires deltaY");
      return { operation: "mouse", action, deltaY: parseNumber(rest[0], "deltaY") };
    }
    fail(`Unsupported mouse action: ${action}`);
  }
  if (command === "keyboard") {
    if (subcommand === "key") {
      if (rest.length !== 1) fail("keyboard key requires one chord, for example CTRL+L or CMD+L");
      return { operation: "keyboard", key: rest[0] };
    }
    if (subcommand === "text64") {
      if (rest.length !== 1) fail("keyboard text64 requires one base64 string");
      return { operation: "keyboard", text: Buffer.from(rest[0], "base64").toString("utf8") };
    }
    fail("keyboard requires key or text64");
  }
  if (command === "uia") {
    if (subcommand !== "find" && subcommand !== "action") fail("uia requires find or action");
    const options = parseOptions(rest);
    const request = {
      operation: subcommand === "find" ? "uia_find" : "uia_action",
    };
    if (options.app) request.app = options.app;
    if (options.name) request.name = options.name;
    if (options.role) request.role = options.role;
    if (options.description) request.description = options.description;
    if (options.automationId) request.automationId = options.automationId;
    if (options.controlType) request.controlType = options.controlType;
    if (options.windowTitle) request.windowTitle = options.windowTitle;
    if (options.windowHandle) request.windowHandle = parseNumber(options.windowHandle, "windowHandle");
    if (options.limit) request.limit = parseNumber(options.limit, "limit");
    if (options.maxDepth) request.maxDepth = parseNumber(options.maxDepth, "maxDepth");
    if (options.maxVisited) request.maxVisited = parseNumber(options.maxVisited, "maxVisited");
    if (subcommand === "action") {
      if (!options.action) fail("uia action requires --action");
      request.action = options.action;
      if (options.value !== undefined) request.value = options.value;
    }
    return request;
  }
  fail(`Unsupported command: ${command}`);
}

async function main() {
  const endpointPath = path.join(stateDir, "desktop-endpoint.json");
  let endpoint;
  try {
    endpoint = JSON.parse(await readFile(endpointPath, "utf8"));
  } catch (error) {
    fail(`Desktop helper endpoint is unavailable at ${endpointPath}: ${error.message}`);
  }
  const port = Number(endpoint.port);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) fail("Desktop helper endpoint contains an invalid port");
  const request = buildRequest(process.argv.slice(2));
  let response;
  try {
    const requestTimeout = request.operation === "codex_task_status"
      ? Math.min(40_000, Math.max(15_000, Number(request.waitMs ?? 0) + 5_000))
      : 15_000;
    response = await fetch(`http://127.0.0.1:${port}/v1/desktop`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(requestTimeout),
    });
  } catch (error) {
    fail(`Desktop helper at 127.0.0.1:${port} is not reachable: ${error.message}`);
  }
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.ok) {
    fail(body?.error?.message ?? `Desktop helper returned HTTP ${response.status}`);
  }
  console.log(JSON.stringify(body.result, null, 2));
}

await main();
