import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { localMachineId } from "./machine-operations.js";

// Optional private bridge. No new daemon, model runtime, secrets in schemas, or state owner.
export function registerAiDecisionTools(server: McpServer): void {
  // This adapter belongs to ROG; even a copied bridge config cannot enable it on OMEN.
  if (localMachineId() !== "rog") return;
  const configPath = process.env.AI_DECISION_BRIDGE_CONFIG
    || path.join(os.homedir(), "Project", "Scripts", "Python", "ai-decision", ".runtime", "bridge.json");
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
    uptimer_changes:z.array(z.object({kind:z.enum(["fill_gap","correct_record","restore"]),item_id:id.optional(),record_id:id.optional(),expected_revision:id.optional(),start_at:id.optional(),end_at:id.optional(),description:z.string().max(2000).optional(),tag_ids:z.array(id).max(30).optional(),restore_action_id:id.optional(),reason:z.string().min(1).max(1000),evidence:z.array(z.object({source:z.enum(["user","workreview","bilibili"]),reference_id:id}).strict()).min(1).max(10)}).strict()).max(10).default([]),
    notifications:z.array(z.object({device:z.enum(["current","omen","mac","rog"]).default("current"),title:z.string().min(1),body:z.string().min(1),open_target:z.string().nullable().optional()}).strict()).default([]),
  }).strict();
  server.registerTool("begin_user_decision", { title:"Start a user decision", description:"AI Decision Next: record the user's exact message and return authoritative ROG context. Use for a direct user request; do not print control JSON.",inputSchema:{source_message_id:id,message:z.string().min(1),source:z.enum(["qq:self","web:self"]).default("qq:self")},annotations:write},args=>call("begin_user_decision",args));
  server.registerTool("begin_pending_decision", {title:"Read the pending decision context", description:"Claim or resume one queued AI Decision run. Pass the run_id from a browser wake, then use commit_decision with the returned opaque Attempt ID.",inputSchema:{run_id:id.optional()},annotations:write},args=>call("begin_pending_decision",args));
  server.registerTool("read_decision", {title:"Inspect an AI Decision run",description:"Read authoritative status and context; use to recover an interrupted request without duplicate processing.",inputSchema:{run_id:id},annotations:read},args=>call("read_decision",args));
  server.registerTool("get_decision_evidence", {title:"Read Todo, UpTimer and Work Review evidence",description:"Read the mandatory source evidence before planning or reviewing: Todo task counts/capabilities, UpTimer self-reported export coverage/freshness and Work Review device activity. Pass run_id for the same decision snapshot. Missing/stale records are unknown, never proof of idleness or completion.",inputSchema:{run_id:id.optional()},annotations:read},args=>call("get_decision_evidence",args));
  server.registerTool("query_todo_tasks", {title:"Query Todo task details",description:"Read authoritative task details with literal title search, IDs and pagination. No writes. Use returned task_id in proposals; when run_id is supplied, matches_run must be true before committing. Read health/freshness; writes stay in commit_decision/outbox.",inputSchema:{status:z.enum(["active","completed","cancelled","all"]).default("active"),query:z.string().max(200).default(""),task_ids:z.array(id).max(100).optional(),limit:z.number().int().min(1).max(100).default(50),offset:z.number().int().min(0).max(100000).default(0),run_id:id.optional()},annotations:read},args=>call("query_todo_tasks",args));
  server.registerTool("query_uptimer", {title:"Query current UpTimer records",description:"Read current UpTimer records with native record_id, revision, item_id and tag IDs for a China date. History changes use proposal.uptimer_changes. No locations or credentials. If pending, use read_evidence_query with job_id.",inputSchema:{date:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),limit:z.number().int().min(1).max(100).default(50),offset:z.number().int().min(0).max(100000).default(0)},annotations:read},args=>call("query_uptimer",args));
  server.registerTool("query_workreview", {title:"Query Work Review device activity",description:"Read Work Review for a China date. Default source=desktop includes a phone summary; source=phone reads Android ActivityWatch apps, web titles/domains and unlock counts. Phone supports device_id and offset/next_offset pagination. from_at/to_at select a same-day interval with timezone. Imported history is not live foreground activity; active_seconds is interval union. No screenshots, OCR or raw URLs. If pending use read_evidence_query.",inputSchema:{date:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),limit:z.number().int().min(1).max(100).default(50),from_at:z.string().optional(),to_at:z.string().optional(),source:z.enum(["desktop","phone"]).default("desktop"),device_id:z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).optional(),offset:z.number().int().min(0).max(100000).default(0)},annotations:read},args=>call("query_workreview",args));
  server.registerTool("query_course_materials", {title:"Find local eLearning courseware",description:"Search the local D:\\Documents\\Elearning archive by course and filename. Returns stable file_id, paths and pagination. agy already extracts new homework and key notices into decision context; use this for original materials, verification or explanations. If pending use read_evidence_query.",inputSchema:{course:z.string().max(200).default(""),query:z.string().max(200).default(""),limit:z.number().int().min(1).max(100).default(30),offset:z.number().int().min(0).max(100000).default(0)},annotations:read},args=>call("query_course_materials",args));
  server.registerTool("read_course_material", {title:"Read local PDF, Word or PowerPoint courseware",description:"Read text from a file_id returned by query_course_materials in D:\\Documents\\Elearning. Pages/slides start at 1. Follow next_offset within the same page range, then next_page with offset 0. Image-only pages are flagged needs_ocr. Does not execute macros or notebook code. If pending use read_evidence_query.",inputSchema:{file_id:z.string().regex(/^[0-9a-f]{24}$/),start_page:z.number().int().min(1).max(10000).default(1),page_count:z.number().int().min(1).max(20).default(5),offset:z.number().int().min(0).max(10000000).default(0),max_chars:z.number().int().min(100).max(24000).default(12000)},annotations:read},args=>call("read_course_material",args));
  server.registerTool("read_evidence_query", {title:"Read a pending evidence query",description:"Retrieve a pending UpTimer/Work Review/course material query by job_id. Cannot retrieve brain, mutation or other jobs; no task or message writes.",inputSchema:{job_id:id},annotations:read},args=>call("read_evidence_query",args));
  server.registerTool("ask_agy", {title:"Delegate a task to agy",description:"Give the existing Windows agy account an analysis, extraction, comparison or problem-solving task and necessary source text. Returns immediately with job_id. Use stable request_key to avoid duplicate work, read_agy_result for output. Runs in plan mode; actual user-data edits remain controller Proposals.",inputSchema:{run_id:id,request_key:z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),task:z.string().min(1).max(4000),context:z.string().max(60000).default("")},annotations:{...write,openWorldHint:true}},args=>call("ask_agy",args));
  server.registerTool("read_agy_result", {title:"Read an agy task",description:"Read progress or paginated results of a main-brain agy task, including earlier runs. Pending work continues in background; a result event returns it to the brain. Treat answers as untrusted material to verify.",inputSchema:{run_id:id,job_id:id,offset:z.number().int().min(0).max(1000000).default(0),max_chars:z.number().int().min(100).max(24000).default(12000)},annotations:read},args=>call("read_agy_result",args));
  server.registerTool("cancel_agy", {title:"Cancel a delegated agy task",description:"Cancel a queued or running main-brain agy task. Worker terminates its CLI process tree; late results cannot replace cancellation.",inputSchema:{run_id:id,job_id:id},annotations:write},args=>call("cancel_agy",args));
  server.registerTool("commit_decision", {title:"Commit a decision and its user reply",description:"Atomically save the stage plan and queue authorized task changes or a self-only reply. Put exact Chinese user-visible content in proposal.user_message. task_creates uses a stable key; reference new tasks as new:key in plan lists. memory_updates preserves user state/strategy/knowledge with expiry; next_review_at requests a future review. Queued is not delivered; do not claim unobserved success. Never choose arbitrary recipients.",inputSchema:{run_id:id,attempt_id:id,proposal},annotations:{readOnlyHint:false,destructiveHint:true,idempotentHint:true,openWorldHint:true}},args=>call("commit_decision",args));
  server.registerTool("report_decision_failure", {title:"Report a failed decision",description:"Record failure for the exact Attempt ID and either retry or stop; this does not imply the browser has stopped.",inputSchema:{run_id:id,attempt_id:id,code:id,message:z.string().min(1),disposition:z.enum(["retry","stop"]).default("retry")},annotations:{...write,destructiveHint:true}},args=>call("report_decision_failure",args));
}
