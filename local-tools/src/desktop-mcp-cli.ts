#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createDesktopMcpServer } from "./desktop-mcp.js";
const server = createDesktopMcpServer();
await server.connect(new StdioServerTransport());
console.error("codex-plus-computer-use ready on stdio");
