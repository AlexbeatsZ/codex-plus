import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";

// Optional private bridge. No new daemon, model runtime, secrets in schemas, or state owner.
export function registerAiDecisionTools(server: McpServer): void {
  const configPath = process.env.AI_DECISION_BRIDGE_CONFIG
    || path.join(os.homedir(), "AppData", "Local", "AI-Decision", "bridge.json");
  if (!fs.existsSync(configPath)) return;
  const config = JSON.parse(fs.readFileSync(configPath, "utf8").replace(/^\uFEFF/, "")) as { url: string; token: string; enabled?: boolean };
  if (config.enabled === false) return;
  const base = new URL(config.url);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(base.hostname) || base.protocol !== "http:") {
    throw new Error("AI Decision proxy must target trusted local loopback HTTP");
  }
  if (!config.token) throw new Error("AI Decision proxy token is missing");
  const call = async (name: string, args: unknown) => {
    try {
      const r = await fetch(new URL(`/v1/bridge/tools/${name}`, base), {
        method: "POST", signal: AbortSignal.timeout(20000),
        headers: { "Authorization": `Bearer ${config.token}`, "Content-Type": "application/json" },
        body: JSON.stringify(args),
      });
      const body = await r.json() as { content?: Array<{type: "text"; text: string}>; detail?: unknown };
      if (!r.ok) return { isError: true, content: [{ type: "text" as const, text: `AI Decision rejected the request (${r.status}): ${JSON.stringify(body.detail)}` }] };
      return { content: body.content || [{ type: "text" as const, text: "AI Decision returned no content" }] };
    } catch {
      return { isError: true, content: [{ type: "text" as const, text: "AI Decision local service is unreachable; no decision or delivery success is implied." }] };
    }
  };
  const read = { readOnlyHint:true, destructiveHint:false, idempotentHint:true, openWorldHint:false };
  const write = { readOnlyHint:false, destructiveHint:false, idempotentHint:true, openWorldHint:false };
  const id = z.string().min(1);
  const plan = z.object({core:z.array(id).optional(),extension:z.array(id).optional(),reserve:z.array(id).optional(),preview:z.array(id).optional(),exploration_budget:z.record(z.string(),z.unknown()).optional()}).strict();
  const proposal = z.object({
    user_message:z.object({channel:z.enum(["origin","qq:self","web:self"]).default("origin"),text:z.string().min(1)}).strict().nullable().optional(),
    read_task_ids:z.array(id).default([]), plan_patch:plan.default({}),
    task_creates:z.array(z.object({key:z.string().regex(/^[A-Za-z0-9_-]+$/),title:z.string().min(1).max(500),planned_date:z.string().nullable().optional(),hard_deadline_at:z.string().nullable().optional(),priority:z.number().int().min(1).max(4).default(1),description:z.string().max(8000).default(""),section:z.string().min(1).max(120).nullable().optional()}).strict()).default([]),
    memory_updates:z.array(z.object({key:z.string().min(1).max(128),scope:z.enum(["state","strategy","knowledge"]),text:z.string().min(1).max(8000),expires_at:z.string().nullable().optional()}).strict()).default([]),
    next_review_at:z.string().nullable().optional(),
    task_updates:z.array(z.object({task_id:id,title:z.string().nullable().optional(),status:z.enum(["active","completed","cancelled"]).nullable().optional(),planned_date:z.string().nullable().optional(),priority:z.number().int().min(1).max(4).nullable().optional(),description:z.string().max(8000).nullable().optional(),section:z.string().min(1).max(120).nullable().optional()}).strict()).default([]),
    notifications:z.array(z.object({device:z.enum(["current","omen","mac","rog"]).default("current"),title:z.string().min(1),body:z.string().min(1),open_target:z.string().nullable().optional()}).strict()).default([]),
  }).strict();
  server.registerTool("begin_user_decision", { title:"Start a user decision", description:"AI Decision Next: record the user's exact message and return authoritative ROG context. Use for a direct user request; do not print control JSON.",inputSchema:{source_message_id:id,message:z.string().min(1),source:z.enum(["qq:self","web:self"]).default("qq:self")},annotations:write},args=>call("begin_user_decision",args));
  server.registerTool("begin_pending_decision", {title:"Read the pending decision context", description:"Claim or resume one queued AI Decision run. Pass the run_id from a browser wake, then use commit_decision with the returned opaque Attempt ID.",inputSchema:{run_id:id.optional()},annotations:write},args=>call("begin_pending_decision",args));
  server.registerTool("read_decision", {title:"Inspect an AI Decision run",description:"Read authoritative status and context; use to recover an interrupted request without duplicate processing.",inputSchema:{run_id:id},annotations:read},args=>call("read_decision",args));
  server.registerTool("commit_decision", {title:"Commit a decision and its user reply",description:"Atomically save the stage plan and queue authorized task changes or a self-only reply. Put exact Chinese user-visible content in proposal.user_message. task_creates uses a stable key; reference new tasks as new:key in plan lists. memory_updates preserves user state/strategy/knowledge with expiry; next_review_at requests a future review. Queued is not delivered; do not claim unobserved success. Never choose arbitrary recipients.",inputSchema:{run_id:id,attempt_id:id,proposal},annotations:{readOnlyHint:false,destructiveHint:true,idempotentHint:true,openWorldHint:true}},args=>call("commit_decision",args));
  server.registerTool("report_decision_failure", {title:"Report a failed decision",description:"Record failure for the exact Attempt ID and either retry or stop; this does not imply the browser has stopped.",inputSchema:{run_id:id,attempt_id:id,code:id,message:z.string().min(1),disposition:z.enum(["retry","stop"]).default("retry")},annotations:{...write,destructiveHint:true}},args=>call("report_decision_failure",args));
}
