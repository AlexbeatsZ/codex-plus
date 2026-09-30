# Optional AI Decision MCP facade

The ROG local-tools runtime optionally registers five AI Decision tools when the private loopback bridge config exists. This is a forwarding adapter, not an agent, planner, queue or second state store.

Implementation: `src/ai-decision-tools.ts`, registered by `mcp-server.ts`. Config: `%USERPROFILE%/AppData/Local/AI-Decision/bridge.json`; never commit its token. The endpoint must be local loopback HTTP. Outbound mutations and exact user replies remain validated and persisted by AI Decision Next.

Tool schemas must match `/home/meta/Project/Scripts/Python/ai-decision-next/src/ai_decision/mcp/gateway.py`. Task create/update, priority, description, memory expiry and next-review fields are typed. Do not weaken annotations or permission settings to suppress native confirmation. This facade is absent when no config file exists, so other machines keep their existing behavior.

Build using the existing TypeScript workflow. Validate listTools and read_decision through stdio without creating a production decision. After deployment, reload the existing ROG Tunnel and refresh the ChatGPT plugin tool definitions. That refresh is not authorization for later write actions.

The main project contains operational records and acceptance evidence. No browser cookies, tokens or personal task content belong in this repository.
