import { randomUUID } from "node:crypto";
import type { Server as HttpServer } from "node:http";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { Request, Response } from "express";
import { CodexContextSync } from "./codex-context.js";
import { createMcpServer } from "./mcp-server.js";
import { WorkspaceRegistry } from "./workspaces.js";

interface Session {
  transport: StreamableHTTPServerTransport;
  server: ReturnType<typeof createMcpServer>;
}

export interface HttpStartOptions {
  host: string;
  port: number;
}

export function startHttpServer(
  registry: WorkspaceRegistry,
  options: HttpStartOptions,
  codexContext: CodexContextSync = new CodexContextSync(registry),
): Promise<HttpServer> {
  const app = createMcpExpressApp({ host: options.host });
  const sessions = new Map<string, Session>();

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true, workspaces: registry.workspaces.map(({ id }) => id) });
  });

  app.post("/mcp", async (req, res) => {
    try {
      const sessionId = headerValue(req, "mcp-session-id");
      let session = sessionId ? sessions.get(sessionId) : undefined;

      if (!session && !sessionId && isInitializeRequest(req.body)) {
        let transport!: StreamableHTTPServerTransport;
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          enableJsonResponse: true,
          onsessioninitialized: (newSessionId) => {
            sessions.set(newSessionId, { transport, server });
          },
        });
        const server = createMcpServer(registry, codexContext);
        session = { transport, server };
        await server.connect(transport);
      }

      if (!session) {
        badRequest(res, "Missing or unknown MCP session ID.");
        return;
      }
      await session.transport.handleRequest(req, res, req.body);
    } catch (error) {
      internalError(res, error);
    }
  });

  const handleSessionRequest = async (req: Request, res: Response) => {
    try {
      const sessionId = headerValue(req, "mcp-session-id");
      const session = sessionId ? sessions.get(sessionId) : undefined;
      if (!session) {
        badRequest(res, "Missing or unknown MCP session ID.");
        return;
      }
      await session.transport.handleRequest(req, res);
      if (req.method === "DELETE" && sessionId) {
        sessions.delete(sessionId);
        await session.server.close();
      }
    } catch (error) {
      internalError(res, error);
    }
  };

  app.get("/mcp", handleSessionRequest);
  app.delete("/mcp", handleSessionRequest);

  return new Promise((resolve, reject) => {
    const httpServer = app.listen(options.port, options.host, () => resolve(httpServer));
    httpServer.on("error", reject);
  });
}

function headerValue(req: Request, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function badRequest(res: Response, message: string): void {
  res.status(400).json({ jsonrpc: "2.0", error: { code: -32000, message }, id: null });
}

function internalError(res: Response, error: unknown): void {
  console.error(error);
  if (!res.headersSent) {
    res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
  }
}
